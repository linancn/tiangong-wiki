# 数据模型

本文档定义 Wiki Skill 的数据结构：Frontmatter 规范、SQLite Schema、模板配置文件、Graph 设计。

---

## 1. Frontmatter 规范

第一批 pageType 与默认模板资产以本文档、`assets/templates/` 和 `assets/wiki.config.default.json` 为准。

### 支持的 pageType（第一批）

`concept` · `misconception` · `bridge` · `source-summary` · `lesson` · `method` · `person` · `achievement` · `resume` · `research-note` · `faq`

### 通用 frontmatter 字段（所有 pageType 共享）

```yaml
---
pageType: <type>          # 必填
title: <标题>              # 必填
nodeId: <slug>            # 可选，知识图谱节点标识
status: draft             # draft | active | archived
visibility: private       # private | shared | public
sourceRefs: []            # 引用来源（见下方 sourceRefs 规范）
relatedPages: []          # 关联页面路径（相对于 wiki/pages/）
tags: []                  # 自由标签
createdAt: 2026-04-06
updatedAt: 2026-04-06
---
```

**设计原则**：通用字段必须是领域无关的。任何与特定使用场景相关的字段（如 `courseId`、`projectId`）不在通用层出现，而是通过 `wiki.config.json` 的 `customColumns` 或模板级 `columns` 按需声明。

### sourceRefs 规范

`sourceRefs` 记录页面内容的来源归属（provenance）。使用路径前缀区分引用类型，人类可读，机器可解析：

```yaml
sourceRefs:
  - vault/projects/phoenix/spec.pdf         # vault 文件引用
  - concepts/bayesian-theorem.md             # wiki 页面引用（= pages.id，无 pages/ 前缀）
  - https://arxiv.org/abs/2301.00001         # 外部 URL
```

**引用类型检测规则**（按顺序匹配）：

| 匹配规则 | 类型 | `wiki lint` 验证 | 生成 edge？ |
| --- | --- | --- | --- |
| 以 `vault/` 开头 | vault 文件 | 验证文件存在于 `vault_files` 表 | 否（vault 文件不是 graph 节点） |
| 以 `http://` 或 `https://` 开头 | 外部 URL | 不验证 | 否 |
| 以 `.md` 结尾 | wiki 页面 | 验证 `pages.id` 存在 | 是 → `sourced_from` edge |
| 其他 | 自由文本 | 不验证 | 否 |

**wiki 页面引用的路径格式 = `pages.id`**：即相对于 `wiki/pages/` 的路径，如 `concepts/bayesian-theorem.md`。不带 `pages/` 前缀，与 `relatedPages` 格式一致。

**与 relatedPages 的区别**：

- `relatedPages` = 语义关联（"这两个概念相关"），双向，生成 `related` edge
- `sourceRefs` = 来源归属（"这个页面的知识来自哪里"），单向，wiki 页面引用生成 `sourced_from` edge

两者可以指向同一个页面，但语义不同。

### 三层索引列模型

字段如何进入 SQLite `pages` 表做列索引，分为三个层级：

| 层级 | 定义位置 | 适用范围 | 由谁决定 | 示例 |
| --- | --- | --- | --- | --- |
| **固定列** | 代码硬编码 | 所有页面，不可更改 | 开发者 | pageType, title, nodeId, status, visibility, tags, createdAt, updatedAt |
| **部署列** | config 根级 `customColumns` | 所有页面，部署时配置 | 部署者 | courseId, projectId, teamId... |
| **模板列** | config 各 template 的 `columns` | 仅特定 pageType | 部署者 | confidence, severity, stage... |

**选择放哪一层的判断标准**：

- 这个字段是否领域无关？→ 固定列（但极少新增，需改代码）
- 这个部署中几乎所有模板都需要它？→ `customColumns`（如教育场景的 `courseId`）
- 只有某种 pageType 需要它？→ 对应 template 的 `columns`（如 concept 的 `confidence`）
- 不需要 SQL WHERE 过滤？→ 不建列，存入 `extra` JSON，用 `json_extract()` 按需查询

---

## 2. SQLite Schema

### 固定部分（代码硬编码）

```sql
------------------------------------------------------------
-- pages: wiki 页面索引
------------------------------------------------------------
CREATE TABLE pages (
    -- 标识
    id              TEXT PRIMARY KEY,       -- 相对路径 (e.g. "concepts/bayesian-theorem.md")
    node_id         TEXT UNIQUE,            -- frontmatter nodeId (可 NULL)

    -- 通用 frontmatter（固定列）
    title           TEXT NOT NULL,
    page_type       TEXT NOT NULL,
    status          TEXT DEFAULT 'draft',   -- draft | active | archived
    visibility      TEXT DEFAULT 'private', -- private | shared | public
    tags            TEXT,                   -- JSON array as TEXT

    -- customColumns 和 template columns 在 init 时通过 ALTER TABLE 动态添加
    -- 未声明为列的 frontmatter 字段统一存入 extra
    extra           TEXT,                   -- JSON object

    -- 索引元数据
    file_path       TEXT NOT NULL,          -- 绝对路径
    content_hash    TEXT,                   -- SHA-256, 用于变更检测
    summary_text    TEXT,                   -- 用于 embedding 的元数据摘要
    embedding_status TEXT DEFAULT 'pending', -- pending | done | error
    file_mtime      REAL,
    created_at      TEXT,                   -- from frontmatter createdAt
    updated_at      TEXT,                   -- from frontmatter updatedAt
    indexed_at      TEXT                    -- 最后索引时间 (ISO 8601)
);

CREATE INDEX idx_pages_type     ON pages(page_type);
CREATE INDEX idx_pages_status   ON pages(status);
CREATE INDEX idx_pages_node     ON pages(node_id);

------------------------------------------------------------
-- edges: 页面间关系（知识图谱）
------------------------------------------------------------
CREATE TABLE edges (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    source      TEXT NOT NULL,              -- node_id 或 page id
    target      TEXT NOT NULL,              -- node_id 或 page id
    edge_type   TEXT NOT NULL,              -- 由 wiki.config.json 定义
    source_page TEXT,                       -- 定义此边的页面 id
    metadata    TEXT,                       -- JSON, 额外信息
    UNIQUE(source, target, edge_type)
);

CREATE INDEX idx_edges_source ON edges(source);
CREATE INDEX idx_edges_target ON edges(target);
CREATE INDEX idx_edges_type   ON edges(edge_type);

------------------------------------------------------------
-- vec_pages: 元数据向量索引 (sqlite-vec)
------------------------------------------------------------
-- 维度由环境变量 EMBEDDING_DIMENSIONS 决定，建表时动态填入
CREATE VIRTUAL TABLE vec_pages USING vec0(
    page_id   TEXT PRIMARY KEY,
    embedding float[384]
);

------------------------------------------------------------
-- pages_fts: 全文搜索 (FTS5)
------------------------------------------------------------
CREATE VIRTUAL TABLE pages_fts USING fts5(
    title,
    tags,
    summary_text,
    content='pages',
    content_rowid='rowid'
);

------------------------------------------------------------
-- vault_files: vault 文件轻量索引
------------------------------------------------------------
CREATE TABLE vault_files (
    id          TEXT PRIMARY KEY,            -- 相对路径
    file_name   TEXT NOT NULL,
    file_ext    TEXT,
    source_type TEXT,                        -- 自由文本
    file_size   INTEGER,
    file_path   TEXT NOT NULL,               -- 绝对路径
    content_hash TEXT,
    file_mtime  REAL,
    indexed_at  TEXT
);

------------------------------------------------------------
-- vault_changelog: vault 变更日志（由 wiki sync 写入）
------------------------------------------------------------
CREATE TABLE vault_changelog (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id     TEXT NOT NULL,               -- vault_files.id (相对路径)
    action      TEXT NOT NULL,               -- added | modified | removed
    detected_at TEXT NOT NULL,               -- ISO 8601, sync 检测到变更的时间
    sync_id     TEXT NOT NULL                -- 本次 sync 的唯一标识（用于按次查询）
);

CREATE INDEX idx_vchangelog_sync ON vault_changelog(sync_id);
CREATE INDEX idx_vchangelog_time ON vault_changelog(detected_at);

------------------------------------------------------------
-- sync_meta: 同步状态
------------------------------------------------------------
CREATE TABLE sync_meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);
-- 预置 key:
--   'last_sync_at'          最后同步时间
--   'last_sync_id'          最后同步的 sync_id
--   'last_full_rebuild_at'  最后全量重建时间
--   'config_version'        SHA-256(wiki.config.json)，变更时触发全量重解析
--   'schema_version'        核心表结构版本（breaking changes）
--   'embedding_profile'     SHA-256(BASE_URL:MODEL:DIMENSIONS)，变更时 DROP + 重建 vec_pages
```

### 动态列（init 时根据 config 创建）

`wiki init` 读取 `wiki.config.json` 后，为 `customColumns` 和各 template 的 `columns` 执行 ALTER TABLE：

```sql
-- 来自 customColumns（例如教育场景）
ALTER TABLE pages ADD COLUMN course_id TEXT;
CREATE INDEX idx_pages_course ON pages(course_id);

-- 来自 templates.concept.columns
ALTER TABLE pages ADD COLUMN confidence TEXT;
ALTER TABLE pages ADD COLUMN mastery_level TEXT;

-- 来自 templates.misconception.columns
ALTER TABLE pages ADD COLUMN severity TEXT;
ALTER TABLE pages ADD COLUMN resolved_at TEXT;
-- ...
```

不同模板声明的列共存于同一张 `pages` 表中。非该模板类型的页面在这些列上值为 NULL。这是合理的——SQLite 对 NULL 列几乎没有存储开销。

---

## 3. Graph 设计

### SQLite 唯一，JSON 按需导出

Graph 数据统一存储在 `index.db` 的 `pages` + `edges` 表中，不维护独立的 JSON 文件。

理由：

- SQLite 递归 CTE 可做多跳遍历，能力强于静态 JSON
- 单一数据源，无同步问题
- JSON 导出通过 `wiki export-graph` 按需生成

### Edge 提取规则

Edge 提取由 `wiki.config.json` 的 `edges` 配置驱动。确定性操作，不依赖 LLM。

默认配置中的 edge 映射：

| frontmatter 字段 | 来源 pageType | 生成的 edge_type | source → target |
| --- | --- | --- | --- |
| `prerequisites[]` | concept | `prerequisite` | 当前页 → 前置概念 |
| `relatedPages[]` | 所有类型（commonEdges） | `related` | 当前页 → 关联页 |
| `sourceRefs[]`（.md 引用） | 所有类型（commonEdges） | `sourced_from` | 当前页 → 来源页 |
| `fromConcepts[]` | bridge | `bridges_from` | 当前页 → 来源概念 |
| `toConcepts[]` | bridge | `bridges_to` | 当前页 → 目标概念 |
| `correctedConcepts[]` | misconception | `corrects` | 当前页 → 被修正概念 |

### Edge 配置字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `edgeType` | 是 | 生成的 edge 类型标识，写入 `edges.edge_type` |
| `resolve` | 是 | 目标节点匹配方式：`"nodeId"` 匹配 `pages.node_id`；`"path"` 匹配 `pages.id` |
| `match` | 否 | 正则表达式，对 frontmatter 字段的每个值做**前置过滤**：仅匹配的值才进入 resolve + edge 生成流程。未设置时所有值都参与。例如 `"\\.md$"` 过滤出仅 `.md` 结尾的 sourceRefs |

**处理顺序**：frontmatter 字段值 → `match` 过滤（如有）→ `resolve` 匹配目标节点 → 写入 `edges` 表。

### 图遍历查询示例

```sql
-- 某概念的所有前置依赖（递归，含间接依赖）
WITH RECURSIVE deps(node) AS (
    SELECT target FROM edges
    WHERE source = 'bayesian-theorem' AND edge_type = 'prerequisite'
    UNION
    SELECT e.target FROM edges e
    JOIN deps d ON e.source = d.node
    WHERE e.edge_type = 'prerequisite'
)
SELECT p.* FROM pages p JOIN deps d ON p.node_id = d.node;

-- 某页面的所有直接关联（入边 + 出边）
SELECT e.edge_type, e.source, e.target, p.title, p.file_path
FROM edges e
LEFT JOIN pages p ON p.node_id = e.target OR p.id = e.target
WHERE e.source = 'bayesian-theorem'
UNION ALL
SELECT e.edge_type, e.source, e.target, p.title, p.file_path
FROM edges e
LEFT JOIN pages p ON p.node_id = e.source OR p.id = e.source
WHERE e.target = 'bayesian-theorem';
```

---

## 4. 模板配置文件 wiki.config.json

### 设计目标

让索引行为完全由配置驱动。新增 pageType 或部署级字段均为零代码改动。

### 完整结构

```json
{
  "schemaVersion": 1,

  "customColumns": {
    "courseId": "text"
  },

  "defaultSummaryFields": ["title", "tags"],

  "commonEdges": {
    "relatedPages": { "edgeType": "related", "resolve": "path" },
    "sourceRefs": { "edgeType": "sourced_from", "resolve": "path", "match": "\\.md$" }
  },

  "templates": {
    "concept": {
      "file": "templates/concept.md",
      "columns": {
        "confidence": "text",
        "masteryLevel": "text"
      },
      "edges": {
        "prerequisites": { "edgeType": "prerequisite", "resolve": "nodeId" }
      },
      "summaryFields": ["confidence", "masteryLevel", "prerequisites"]
    },

    "misconception": {
      "file": "templates/misconception.md",
      "columns": {
        "severity": "text",
        "resolvedAt": "text"
      },
      "edges": {
        "correctedConcepts": { "edgeType": "corrects", "resolve": "nodeId" }
      },
      "summaryFields": ["severity", "correctedConcepts"]
    },

    "bridge": {
      "file": "templates/bridge.md",
      "columns": {
        "fromCourse": "text",
        "toCourse": "text",
        "transferType": "text"
      },
      "edges": {
        "fromConcepts": { "edgeType": "bridges_from", "resolve": "nodeId" },
        "toConcepts": { "edgeType": "bridges_to", "resolve": "nodeId" }
      },
      "summaryFields": ["fromCourse", "toCourse", "transferType"]
    },

    "source-summary": {
      "file": "templates/source-summary.md",
      "columns": {
        "sourceType": "text",
        "vaultPath": "text"
      },
      "edges": {},
      "summaryFields": ["sourceType", "keyFindings"]
    },

    "lesson": {
      "file": "templates/lesson.md",
      "columns": {
        "context": "text",
        "severity": "text",
        "actionable": "text"
      },
      "edges": {},
      "summaryFields": ["context", "severity"]
    },

    "method": {
      "file": "templates/method.md",
      "columns": {
        "domain": "text",
        "effectiveness": "text"
      },
      "edges": {},
      "summaryFields": ["domain", "applicableTo", "effectiveness"]
    },

    "person": {
      "file": "templates/person.md",
      "columns": {
        "role": "text",
        "context": "text"
      },
      "edges": {},
      "summaryFields": ["role", "context"]
    },

    "achievement": {
      "file": "templates/achievement.md",
      "columns": {
        "achievementType": "text",
        "date": "text"
      },
      "edges": {},
      "summaryFields": ["achievementType", "date", "issuer"]
    },

    "resume": {
      "file": "templates/resume.md",
      "columns": {
        "targetAudience": "text"
      },
      "edges": {},
      "summaryFields": ["targetAudience"]
    },

    "research-note": {
      "file": "templates/research-note.md",
      "columns": {
        "researchTopic": "text",
        "stage": "text"
      },
      "edges": {},
      "summaryFields": ["researchTopic", "stage"]
    },

    "faq": {
      "file": "templates/faq.md",
      "columns": {
        "frequency": "text"
      },
      "edges": {},
      "summaryFields": ["frequency"]
    }
  }
}
```

### 字段说明

| 字段 | 说明 |
| --- | --- |
| `schemaVersion` | 配置格式版本，用于未来迁移 |
| `customColumns` | **部署级**自定义列，所有模板共享。key 是 frontmatter 字段名（camelCase），value 是 SQLite 类型。会在 `pages` 表上建列+索引 |
| `defaultSummaryFields` | 所有模板共享的 summary_text 基础字段 |
| `commonEdges` | 所有模板共享的 edge 提取规则。每条规则含 `edgeType`、`resolve`、可选 `match`（正则前置过滤） |
| `templates.<type>.file` | 模板 .md 文件路径（相对于 wiki/） |
| `templates.<type>.columns` | **模板级**自定义列。仅该类型的页面会填充这些列 |
| `templates.<type>.edges` | 该类型专属的 edge 提取规则。字段格式同 commonEdges |
| `templates.<type>.summaryFields` | 该类型专属的 summary_text 附加字段 |

### 列名映射

frontmatter 中的 camelCase 字段名（如 `courseId`）映射到 SQLite 的 snake_case 列名（如 `course_id`）。转换规则统一为：`camelCase → snake_case`。

### 索引器如何消费配置

```text
wiki init:
  1. 创建 pages 表（固定列）
  2. 读取 config.customColumns → ALTER TABLE 添加部署列 + 建索引
  3. 遍历 config.templates → ALTER TABLE 添加所有模板列 + 建索引

wiki sync (对每个 .md 文件):
  1. gray-matter 解析 → frontmatter data + body content
  2. 读取 data.pageType → 查 config.templates[pageType]
  3. 固定列字段 → 写入 pages 表固定列
  4. customColumns 中声明的字段 → 写入部署列
  5. 匹配的 template.columns 中声明的字段 → 写入模板列
  6. 其余 frontmatter 字段 → JSON 序列化写入 pages.extra
  7. config.commonEdges + template.edges → 提取值，写入 edges 表
  8. config.defaultSummaryFields + template.summaryFields + body 首段 → 拼接 summary_text
```

### 教育场景示例

```json
{
  "customColumns": {
    "courseId": "text"
  }
}
```

所有页面的 frontmatter 中写 `courseId: ML-2026-Spring`，即可通过 `wiki find --course-id ML-2026-Spring` 过滤。

### 工作场景示例

```json
{
  "customColumns": {
    "projectId": "text",
    "teamId": "text"
  }
}
```

所有页面可写 `projectId: phoenix-v2`，通过 `wiki find --project-id phoenix-v2` 过滤。

### 无额外上下文的场景

```json
{
  "customColumns": {}
}
```

不声明任何部署级列，纯粹靠 tags + pageType 组织内容。
