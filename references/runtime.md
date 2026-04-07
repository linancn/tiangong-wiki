# 运行时设计

本文档定义 Wiki Skill 的运行时行为：Embedding 策略、同步机制、冷启动、NAS 兼容、守护进程。

---

## 1. Embedding 策略：元数据向量化

### 核心设计

**只对页面的元数据摘要做向量化，不对全文分块 embed。**

理由：Agent 本身具备文件读取能力（Read / Grep），不需要从向量数据库中检索内容片段。Wiki Skill 的价值是**帮 Agent 快速找到正确的页面路径**，而非替代 Agent 的阅读能力。

| 对比项 | 全文分块 embedding | 元数据 embedding（本方案） |
| --- | --- | --- |
| 每页向量数 | 5-20 | **1** |
| 需要分块策略 | 是 | **不需要** |
| embedding API 成本 | 高 | **极低** |
| 冷启动速度 | 慢 | **快** |
| 搜索返回 | 文本片段 | **页面路径 + 摘要** |

### summary_text 生成

将 frontmatter 关键字段 + body 首段拼接为一段自然语言文本，作为 embedding 输入。

**拼接规则**（由 `wiki.config.json` 驱动）：

```text
1. 固定前缀:  [{page_type}] {title}
2. 通用字段:  标签: {tags.join(", ")}
3. 部署列:    customColumns 中声明的字段（如有），格式 "{label}: {value}"
4. 专属字段:  config.summaryFields 中声明的字段，格式 "{label}: {value}"
5. 分隔线:    ---
6. body 首段: 取 Markdown body 的第一个段落或第一个 ## section 的内容，截断到 ~200 字符
```

示例（concept 页）：

```text
[concept] 贝叶斯定理
标签: probability, ml-foundations
掌握度: medium | 前置: probability-basics, conditional-probability
---
贝叶斯定理描述了在已知先验概率的情况下，如何根据新的证据更新后验概率。
核心公式为 P(A|B) = P(B|A)·P(A) / P(B)...
```

> 如果 `customColumns` 中声明了 `courseId`，它会自动出现在第 3 行，如 `课程: ML-2026-Spring`。但这不是 summary_text 的固定部分。

### 模型建议

推荐使用支持 `dimensions` 参数的 OpenAI 兼容 API（如 `text-embedding-3-small`），可将高维模型输出降维到 384，同时保持 8191 tokens 的 max_seq_length。

如果使用原生 384 维模型（如 `paraphrase-multilingual-MiniLM-L12-v2`），需注意其 max_seq_length 仅 128 tokens，summary_text 必须控制在此范围内。

### Embedding API 调用

使用 Node.js 内置 `fetch`（Node 18+），调用 OpenAI 兼容端点：

```text
POST {EMBEDDING_BASE_URL}/embeddings
{
  "model": "{EMBEDDING_MODEL}",
  "input": [summary_text_1, summary_text_2, ...],
  "dimensions": {EMBEDDING_DIMENSIONS}
}
```

支持批量调用（每批 ~50 条）。失败时标记 `embedding_status = 'error'`，下次 sync 重试。

**Embedding 未配置时**：`EMBEDDING_BASE_URL` / `EMBEDDING_API_KEY` / `EMBEDDING_MODEL` 任一缺失，则 `wiki sync` 自动跳过向量化步骤（等同于 `--skip-embedding`），`wiki search` 返回配置错误。结构化查询、全文搜索、图遍历不受影响。

### Embedding 配置变更检测

`embedding_profile` = SHA-256(`${EMBEDDING_BASE_URL}:${EMBEDDING_MODEL}:${EMBEDDING_DIMENSIONS}`)，存储在 `sync_meta` 中。

当 `embedding_profile` 与 sync_meta 中存储的值不匹配时（endpoint、模型或维度任一变更）：

1. **DROP** 现有 `vec_pages` 虚拟表（旧向量语义过期且维度可能不兼容）
2. **重建** `vec_pages`（使用新的 `EMBEDDING_DIMENSIONS`）
3. 标记所有页面 `embedding_status = 'pending'`
4. 全量 re-embed

此逻辑在 sync step 3.5 执行（独立于 step 4，不受 `--skip-embedding` 影响）。`sync_meta.embedding_profile` 延迟到 step 4 全量 re-embed 成功后写入，确保中途失败时下次 sync 会重试。

---

## 2. 同步机制

### 设计原则

- **定期同步 + 手动触发**，不使用实时文件监听
- wiki 页面变更频率低，实时 watcher 的复杂度 > 收益
- 两层分离：机械索引（确定性代码） / AI 维护（Agent Instruction），各自独立节奏

### 变更检测

使用 **SHA-256 content_hash** 而非 mtime：

- mtime 在 NAS、git pull 等场景下不可靠
- content_hash 确保只处理内容真正变更的文件
- 全量扫描几百个 .md 文件并计算 hash < 1 秒

### sync 流程

```text
wiki sync [--path PATH] [--force] [--skip-embedding]
  │
  ├── 0. Schema 检查
  │      a) 核心表结构版本：对比 sync_meta.schema_version 与代码期望版本
  │         不匹配 → 中止，提示 "wiki init --force"（破坏性变更，需重建）
  │      b) 配置漂移：config_version = SHA-256(wiki.config.json 文件内容)
  │         对比 sync_meta.config_version 与当前 hash
  │         不匹配 → ALTER TABLE 补缺少的列 + 设置 config_changed = true
  │         更新 sync_meta.config_version
  │
  ├── 1. 扫描 wiki/pages/**/*.md
  │      如果 config_changed: 强制处理全部文件（忽略 content_hash）
  │      否则: 对比 SHA-256 content_hash，只处理变更文件
  │
  ├── 2. 分类
  │      新增文件 → 待 INSERT
  │      变更文件（hash 不同 或 config_changed）→ 待 UPDATE
  │      已删文件（DB 有记录但文件不存在）→ 待 DELETE
  │      未变文件且非 config_changed → 跳过
  │
  ├── 3. 处理（在单个 SQLite 事务中）
  │      对每个待 INSERT/UPDATE 的页面:
  │        解析 frontmatter → 生成新 summary_text
  │        如果是 UPDATE: 读取 DB 中旧 summary_text，对比新旧，标记 summary_changed
  │        写入 pages + edges + FTS（此时新 summary_text 已写入 DB）
  │      DELETE: 删除 pages + edges + vec_pages + FTS 对应记录
  │
  ├── 3.5 Embedding profile 检测（始终执行，不受 --skip-embedding 影响）
  │      检查 embedding_profile = SHA-256(BASE_URL:MODEL:DIMENSIONS)
  │      如果不匹配:
  │        如果 --skip-embedding → 立即报错并中止（不修改任何数据）:
  │          "Embedding profile changed, cannot skip embedding."
  │        否则 → DROP + 重建 vec_pages 表
  │               全部页面 embedding_status = 'pending'
  │               设置 embed_all = true
  │               （sync_meta.embedding_profile 延迟到 step 4 全量 re-embed 成功后写入）
  │
  ├── 4. Embedding（除非 --skip-embedding 或 Embedding 未配置）
  │      b) 确定需要 embed 的页面集合:
  │         如果 embed_all: 全部页面（模型/维度变了，旧向量全部作废）
  │         否则: step 3 中标记了 summary_changed 的页面
  │               + 新 INSERT 的页面
  │               + 之前 embedding_status = pending/error 的页面
  │      c) 批量调 embedding API → UPSERT vec_pages
  │         成功项标记 embedding_status = done
  │         失败项标记 embedding_status = error
  │      d) 如果 embed_all 且全部页面均成功 → 更新 sync_meta.embedding_profile
  │         （部分失败时不更新，下次 sync 会再次触发全量 re-embed）
  │
  ├── 5. Vault 索引（仅全量 sync，--path 模式跳过此步骤）
  │      生成 sync_id (e.g. "sync-2026-04-06-100000")
  │      扫描 vault/ → 对比 vault_files 表
  │      变更项（added/modified/removed）→ INSERT vault_changelog (sync_id, action, detected_at)
  │      然后更新 vault_files 表（仅文件元数据）
  │
  └── 6. 更新 sync_meta: last_sync_at（全量 sync 时同时更新 last_sync_id）
```

### --path 模式 vs 全量模式

| | 全量 `wiki sync` | 部分 `wiki sync --path <file>` |
| --- | --- | --- |
| Schema 检查 (step 0) | 执行 | 执行（config_version 不匹配则**自动升级为全量**） |
| 页面扫描范围 (step 1) | 全部 wiki/pages/ | 仅指定文件（**升级为全量时扫描全部**） |
| Embedding (step 4) | 执行 | 执行（embedding_profile 不匹配则**自动升级为全量**） |
| Vault 扫描 (step 5) | 执行，写 vault_changelog | **跳过**（除非已升级为全量） |
| sync_id 生成 | 是 | **否**（除非已升级为全量） |

`--path` 是 page-only 操作：只处理指定页面的解析、索引、embedding。不触发 vault 扫描，不生成新的 vault sync_id，不会冲掉 `wiki vault diff` 的默认视图。

**全局失效条件下的 --path 行为**：如果 step 0 检测到 `config_version` 不匹配，或 step 3.5 检测到 `embedding_profile` 不匹配，`--path` 自动升级为全量 sync（输出提示 `"Config/embedding profile changed, upgrading to full sync"`）。因为这些变更影响所有页面的列映射 / 向量，只处理单个文件会导致索引不一致。

### 其他选项

| 选项 | 效果 |
| --- | --- |
| `--force` | 忽略 content_hash，全量重建。适合 index.db 损坏或 schema 变更后 |
| `--skip-embedding` | 只更新结构化索引（pages/edges/FTS），跳过 embedding API 调用 |

### 触发方式

| 方式 | 场景 |
| --- | --- |
| **定时** | 守护进程调度器，间隔由 `WIKI_SYNC_INTERVAL` 配置（默认每天一次） |
| **手动** `wiki sync` | Agent 创建/修改页面后主动调用；用户手动触发 |
| **手动** `wiki sync --force` | index.db 损坏、schema 变更、或需要全量重建时 |

### AI 维护节奏

AI 驱动的 wiki 维护分成两层：

1. **Skill 接口层**：外部 Agent 按需调用 `wiki find`、`wiki fts`、`wiki search`、`wiki type list/show/recommend`、`wiki create`、`wiki sync --path` 等命令。
2. **服务层自动处理**：daemon 在全量 sync 后读取 `vault_processing_queue`，使用 **Codex SDK** 启动或恢复 workflow thread，让 Codex 自己读取文件、discover ontology、执行页面动作并写 `result.json`。

默认协作关系：

```text
1. wiki sync                           ← 更新结构化索引、embedding、vault 元数据
2. vault_processing_queue 入队         ← added / modified 文件进入 pending
3. service 生成 queue artifacts        ← queue-item.json / prompt.md / result.json
4. Codex workflow 执行                 ← CLI discovery + skills + create/update/propose_only
5. service 回收 result.json            ← 更新 queue row、日志、重试状态
```

需要特别注意：

- 所有 page type 完全平等，不存在“vault 文件默认生成 source-summary”的运行时规则。
- service 不做 pageType 判断，只负责队列、文件可达性、thread 生命周期和结果回收。
- ontology 的事实来源是 `wiki` CLI，而不是启动时静态注入的大块摘要。

与 `wiki sync` 的配合：

```text
Agent 日常例行:
  1. wiki sync
  2. wiki stat
  3. wiki vault diff / vault queue
  4. wiki type list / show / recommend
  5. (AI 判断) 创建或更新页面
  6. wiki sync --path <page>
  7. wiki lint --path <page>
```

更具体的 service 配置、queue 可观测性、result manifest 契约和 NAS 场景见 [service-admin.md](./service-admin.md)。

---

## 3. 冷启动与重建

采用 **两阶段渐进式** 启动：

### 阶段 1：结构化索引（秒级，立即可用）

全量扫描 → 解析 frontmatter → 填充 `pages` + `edges` + `pages_fts`。

- 不需要网络调用
- 几百个 .md 文件 < 1 秒
- 此时结构化查询（`wiki find`）、全文搜索（`wiki fts`）、图遍历（`wiki graph`）**立即可用**

### 阶段 2：向量索引（后台异步）

队列式批量生成 summary_text → 调 embedding API → 填充 `vec_pages`。

- 每个文件标记 `embedding_status`：pending → done / error
- 向量搜索（`wiki search`）随索引进度渐进可用
- 失败项下次 sync 自动重试

### 触发条件

| 条件 | 行为 |
| --- | --- |
| `index.db` 不存在 | 等同于 `wiki init`，自动全量重建 |
| `schema_version` 不匹配（核心表结构变更） | 中止并提示 `wiki init --force`（破坏性变更，需 DROP + 重建） |
| `config_version` 不匹配（config 有变更） | 自动 ALTER TABLE 补列 + 强制全量重解析既有页面（回填新列、重建 edges、重生成 summary_text） |
| `wiki sync --force` | 清空所有表，全量重建 |
| 正常 `wiki sync` | 增量更新，只处理变更文件 |

**两类 schema 变更的区别**：

- **Additive（config 新增 customColumns / template columns）**：sync 自动检测并 ALTER TABLE，不丢数据
- **Breaking（核心表结构变更，如字段重命名、类型变更）**：需要 `wiki init --force` 重建，仅在版本升级时发生

---

## 4. 守护进程

### 设计

```text
wiki daemon
  ├── 定时调度器 (setInterval)
  │     └── 按 WIKI_SYNC_INTERVAL 执行 wiki sync
  ├── PID 文件: wiki/.wiki-daemon.pid
  └── 日志: wiki/.wiki-daemon.log (stdout/stderr 重定向)
```

### 关键特性

- 查询命令（find / search / graph / ...）**不依赖守护进程**，直接打开 index.db 查询
- SQLite 支持并发读，守护进程在写入时短暂持有写锁，不阻塞查询
- 守护进程只负责定时同步
- 守护进程不运行时，手动 `wiki sync` 仍然可用

### 命令

```bash
wiki daemon start         # 启动守护进程（后台运行）
wiki daemon stop          # 停止（读取 PID 文件，发送 SIGTERM）
wiki daemon status        # 查看状态 + 上次同步时间 + 下次同步时间
```

---

## 5. NAS 兼容

### wiki/pages/ — 始终本地

wiki/pages/ 目录作为 SSOT 必须本地可读写。Agent 直接操作本地文件。

### vault/ — 支持 Synology NAS

当 `VAULT_SOURCE=synology` 时：

- vault 文件列表通过 `synology-file-station` 的 `list` 命令获取（polling 模式）
- 本地不直接扫描 vault 目录，而是调用 NAS API 获取文件列表
- 对比 `vault_files` 表中的记录，识别新增/删除/变更
- 需要下载到本地处理的文件通过 `download` 命令拉取

当 `VAULT_SOURCE=local`（默认）时：

- 直接使用 `node:fs` 扫描本地 vault 目录
- 与 wiki/pages/ 的扫描逻辑一致
