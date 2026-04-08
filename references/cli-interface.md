# CLI 接口

所有命令通过单一入口调用：

```bash
# 全局安装后
wiki <command> [options]

# npx
npx @biaoo/wiki <command> [options]

# 开发模式
npm run dev -- <command> [options]
```

---

## 命令总览

| 命令 | 说明 | Agent 常用度 |
| --- | --- | --- |
| `setup` | 交互式完整配置向导，写 `.wiki.env` 并 scaffold 工作区 | 一次性 |
| `doctor` | 诊断当前配置、路径、embedding、agent、daemon 状态 | 高 |
| `init` | 初始化 index.db，执行首次全量同步 | 一次性 |
| `sync` | 增量同步索引 | 高 |
| `create` | 从模板创建新页面 | 高 |
| `find` | 按 frontmatter 字段过滤（结构化查询） | 高 |
| `search` | 语义相似搜索（向量查询） | 高 |
| `fts` | 全文搜索（FTS5） | 中 |
| `graph` | 图遍历（从节点出发找关联） | 中 |
| `page-info` | 单页详情 | 中 |
| `list` | 列出页面概览 | 中 |
| `stat` | 全局统计 | 中 |
| `type` | 类型发现与推荐 | 高 |
| `vault list` | 列出 vault 文件（支持多级路径过滤） | 中 |
| `vault diff` | 显示上次 sync 以来 vault 的变更 | 高 |
| `vault queue` | 查看 vault 自动处理队列状态 | 高 |
| `lint` | 校验页面完整性（引用、字段、关联） | 中 |
| `template` | 模板管理 | 低 |
| `export-graph` | 导出图谱 JSON | 低 |
| `export-index` | 导出人类可读的页面索引 Markdown | 低 |
| `daemon` | 守护进程管理 | 低 |
| `check-config` | 检查配置 | 一次性 |

---

## 命令详细

### setup

```bash
wiki setup
```

按 step-by-step 的方式完成完整配置流程：

- 记录 `WIKI_PATH`、`VAULT_PATH`、`WIKI_DB_PATH`、`WIKI_CONFIG_PATH`、`WIKI_TEMPLATES_PATH`
- 记录 `WIKI_SYNC_INTERVAL`
- 可选配置 `EMBEDDING_*`
- 可选配置 `WIKI_AGENT_*`
- 在当前工作目录写入 `.wiki.env`
- scaffold `wiki/pages/`、`vault/`、`wiki.config.json`、`templates/`

`setup` 是安装向导，不会替代 `wiki init`。完成后仍应执行：

```bash
wiki doctor
wiki init
```

### doctor

```bash
wiki doctor
wiki doctor --probe
wiki doctor --format json
```

检查项包括：

- `.wiki.env` / `WIKI_ENV_FILE` 是否已加载
- `WIKI_PATH`、`VAULT_PATH`、`WIKI_TEMPLATES_PATH` 是否存在且可读写
- `WIKI_DB_PATH` 是否可创建或可读写
- `wiki.config.json` 是否可加载，模板文件是否齐全
- embedding 配置是否完整；`--probe` 时额外测试 endpoint
- `WIKI_AGENT_*` 是否完整
- daemon 是否运行、PID/state 是否一致

有 error 时命令返回 exit code `2`，同时仍会把诊断结果输出到 stdout。

### init

```bash
wiki init
```

创建 index.db（如果不存在），根据 `wiki.config.json` 建表（含动态列），执行首次全量同步（两阶段渐进式）。

### sync

```bash
wiki sync                        # 全量同步（pages + embedding + vault 扫描）
wiki sync --path concepts/x.md   # page-only：仅索引指定文件，不扫描 vault
wiki sync --force                # 全量重建（忽略 content_hash）
wiki sync --skip-embedding       # 只更新结构，跳过 embedding（embedding_profile 漂移时会拒绝）
```

`--path` 是 page-only 操作：不触发 vault 扫描、不生成 vault sync_id，不会影响 `wiki vault diff` 的结果。**例外**：如果检测到 `config_version` 或 `embedding_profile` 全局失效，`--path` 自动升级为全量 sync 并输出提示。详细流程见 [runtime.md §2](./runtime.md)。

### create

```bash
wiki create --type concept --title "贝叶斯定理"
wiki create --type concept --title "贝叶斯定理" --node-id bayesian-theorem
wiki create --type person --title "张教授"
```

从 `wiki/templates/` 拉取对应 pageType 的模板（由 `wiki.config.json` 中的 `file` 字段指定），填入 frontmatter 基本字段（title, createdAt, updatedAt 等），写入 `wiki/pages/` 并立即索引。

输出：

```json
{ "created": "concepts/bayesian-theorem.md", "filePath": "/data/workspace/wiki/pages/concepts/bayesian-theorem.md" }
```

Agent 随后用 Write/Edit 工具填写 body 内容，完成后 `wiki sync --path <file>` 更新索引。

### find（结构化查询）

```bash
wiki find --type concept                            # 所有概念页
wiki find --type concept --course-id ML-2026        # 按部署列过滤（需在 customColumns 中声明）
wiki find --tag probability --status active          # 按标签+状态
wiki find --node-id bayesian-theorem                 # 按 nodeId
wiki find --visibility shared                        # 按可见性
wiki find --updated-after 2026-03-01                 # 按时间范围
wiki find --confidence high                          # 按模板列过滤（需在 template.columns 中声明）
wiki find --type concept --course-id ML-2026 --limit 10 --sort updated_at
```

输出：

```json
[
  {
    "id": "concepts/bayesian-theorem.md",
    "title": "贝叶斯定理",
    "pageType": "concept",
    "status": "active",
    "filePath": "/data/workspace/wiki/pages/concepts/bayesian-theorem.md",
    "tags": ["probability", "ml-foundations"],
    "updatedAt": "2026-04-05"
  }
]
```

### search（语义搜索）

```bash
wiki search "贝叶斯定理在机器学习中的应用"
wiki search "优化算法" --type concept --limit 5
```

流程：query 文本 → embedding API → vec_pages 相似度搜索 → 可选结构化后过滤。

输出：

```json
[
  {
    "id": "concepts/bayesian-theorem.md",
    "title": "贝叶斯定理",
    "pageType": "concept",
    "filePath": "/data/workspace/wiki/pages/concepts/bayesian-theorem.md",
    "similarity": 0.87,
    "summaryText": "[concept] 贝叶斯定理..."
  }
]
```

### fts（全文搜索）

```bash
wiki fts "贝叶斯"
wiki fts "贝叶斯" --type concept
```

在 `pages_fts` 虚拟表中搜索 title / tags / summary_text。

### graph（图遍历）

```bash
wiki graph bayesian-theorem                          # 一跳关联
wiki graph bayesian-theorem --depth 2                # 两跳关联
wiki graph bayesian-theorem --edge-type prerequisite # 只看前置关系
wiki graph bayesian-theorem --direction outgoing     # 只看出边
wiki graph bayesian-theorem --direction incoming     # 只看入边
```

输出：

```json
{
  "root": "bayesian-theorem",
  "nodes": [
    { "nodeId": "bayesian-theorem", "title": "贝叶斯定理", "pageType": "concept" },
    { "nodeId": "probability-basics", "title": "概率基础", "pageType": "concept" }
  ],
  "edges": [
    { "source": "bayesian-theorem", "target": "probability-basics", "edgeType": "prerequisite" }
  ]
}
```

### page-info

```bash
wiki page-info concepts/bayesian-theorem.md
```

返回单页完整索引信息：全部 frontmatter 字段、关联 edges（入边 + 出边）、embedding 状态、content_hash。

### list

```bash
wiki list                                            # 全部页面
wiki list --type concept --sort updated_at           # 按类型+排序
wiki list --limit 20                                 # 最近 20 页
```

输出精简列表，每项包含：`title | pageType | status | updatedAt | filePath`。

### stat

```bash
wiki stat
```

```json
{
  "totalPages": 142,
  "byType": { "concept": 58, "misconception": 12, "bridge": 8 },
  "byStatus": { "active": 130, "archived": 12 },
  "totalEdges": 234,
  "orphanPages": 3,
  "embeddingStatus": { "done": 138, "pending": 2, "error": 2 },
  "vaultFiles": 89,
  "lastSyncAt": "2026-04-06T10:00:00+08:00",
  "registeredTemplates": 11
}
```

### template（模板管理）

```bash
wiki template list                                   # 列出已注册的模板
wiki template show concept                           # 查看 concept 模板内容
wiki template create --type lab-report --title "实验报告"  # 创建新模板
```

`wiki template create` 做三件事：

1. 在 `wiki/templates/` 下生成一个 .md 骨架（通用 frontmatter + 空 body sections）
2. 在 `wiki.config.json` 中注册新类型（默认 columns/edges/summaryFields 为空）
3. 返回模板文件路径和 config 路径，提示用户细化配置

### type（类型发现与推荐）

```bash
wiki type list
wiki type list --format json
wiki type show concept --format json
wiki type recommend --text "A repeatable workflow for evidence review" --keywords "workflow,procedure" --limit 5 --format json
```

用途：

1. 让 Agent 在 runtime 发现当前 wiki 的已注册类型
2. 查询单个类型的 columns / edges / summaryFields 结构
3. 基于当前 `vec_pages` 中的相似页面分布做向量推荐，减少硬编码路由

`wiki type list --format json` 输出：

```json
[
  {
    "pageType": "concept",
    "file": "templates/concept.md",
    "filePath": "/data/workspace/wiki/templates/concept.md",
    "columns": ["confidence", "masteryLevel"],
    "edges": ["prerequisites"],
    "summaryFields": ["confidence", "masteryLevel", "prerequisites"]
  }
]
```

`wiki type show concept --format json` 输出：

```json
{
  "pageType": "concept",
  "file": "templates/concept.md",
  "filePath": "/data/workspace/wiki/templates/concept.md",
  "columns": {
    "confidence": "text",
    "masteryLevel": "text"
  },
  "edges": {
    "prerequisites": {
      "edgeType": "prerequisite",
      "resolve": "nodeId"
    }
  },
  "summaryFields": ["confidence", "masteryLevel", "prerequisites"]
}
```

 `wiki type recommend --format json` 输出：

```json
{
  "query": {
    "text": "A repeatable workflow for evidence review",
    "keywords": ["workflow", "procedure"]
  },
  "recommendations": [
    {
      "pageType": "method",
      "score": 2.3471,
      "signals": ["supportCount:4", "maxSimilarity:0.9123", "avgSimilarity:0.5868"],
      "similarPages": ["methods/evidence-review.md@0.9123", "methods/postmortem-loop.md@0.8110"]
    }
  ]
}
```

说明：

- `type recommend` 基于当前 wiki 已嵌入页面的向量相似度聚合，不使用硬编码关键词表
- 如果没有 embedding 配置或当前没有 `vec_pages` 数据，命令会要求先完成带 embedding 的 `wiki sync`
- `type recommend` 只是排序建议，不替 Agent 做最终决策
- Agent 仍需结合现有页面、来源内容和 ontology 结构自行判断

### vault list

```bash
wiki vault list                                      # 全部 vault 文件
wiki vault list --path projects/phoenix/             # 多级路径前缀过滤
wiki vault list --ext pdf                            # 按扩展名
wiki vault list --path projects/ --ext pdf           # 组合过滤
```

`--path` 参数对 `vault_files.id`（相对路径）做前缀匹配，天然支持多级嵌套目录。

输出：

```json
[
  {
    "id": "projects/phoenix/docs/spec.pdf",
    "fileName": "spec.pdf",
    "fileExt": "pdf",
    "fileSize": 204800,
    "filePath": "/data/workspace/vault/projects/phoenix/docs/spec.pdf",
    "indexedAt": "2026-04-06T10:00:00+08:00"
  }
]
```

### vault diff

```bash
wiki vault diff                                      # 最近一次 sync 检测到的变更
wiki vault diff --since 2026-04-01                   # 指定时间以来的全部变更
wiki vault diff --path projects/phoenix/             # 限定路径范围
```

从 `vault_changelog` 表读取变更记录（由 `wiki sync` 在扫描 vault 时写入）。**必须先运行 `wiki sync` 才能看到最新变更**——`vault diff` 不做实时文件系统扫描，仅读取 sync 已记录的 changelog。

默认返回最近一次 sync 的变更；`--since` 可跨多次 sync 查询，每条记录自带 `syncId` 和 `detectedAt`。

```json
{
  "changes": [
    { "fileId": "projects/phoenix/docs/new-spec.pdf", "action": "added", "detectedAt": "2026-04-06T10:00:00+08:00", "syncId": "sync-2026-04-06-100000" },
    { "fileId": "imports/old-draft.docx", "action": "removed", "detectedAt": "2026-04-05T10:00:00+08:00", "syncId": "sync-2026-04-05-100000" }
  ],
  "since": "2026-04-01T00:00:00+08:00",
  "totalChanges": 2
}
```

### vault queue

```bash
wiki vault queue
wiki vault queue --status pending
wiki vault queue --status error
```

查看 `vault_processing_queue` 的统计和明细，用于确认自动来源处理是否已经完成、是否有失败项需要重试。

`vault queue` 是 service 层的可观测性接口。对于走 Codex workflow 的项目，单条 item 至少应暴露：

- `threadId`
- `decision`
- `resultManifestPath`
- `skillsUsed`
- `createdPageIds`
- `updatedPageIds`
- `proposedTypeNames`

输出：

```json
{
  "items": [
    {
      "fileId": "imports/new-paper.pdf",
      "status": "done",
      "priority": 100,
      "queuedAt": "2026-04-06T10:00:00+08:00",
      "processedAt": "2026-04-06T10:01:22+08:00",
      "resultPageId": "methods/evidence-review.md",
      "errorMessage": null,
      "attempts": 1,
      "threadId": "thread_abc123",
      "workflowVersion": "2026-04-07",
      "decision": "apply",
      "resultManifestPath": "/data/workspace/wiki/.queue-artifacts/imports__new-paper-pdf/result.json",
      "lastErrorAt": null,
      "retryAfter": null,
      "createdPageIds": ["methods/evidence-review.md"],
      "updatedPageIds": ["concepts/evidence-ops.md"],
      "appliedTypeNames": ["method", "concept"],
      "proposedTypeNames": ["evidence-brief"],
      "skillsUsed": ["wiki-skill", "pdf"],
      "fileName": "new-paper.pdf",
      "fileExt": "pdf",
      "sourceType": "pdf",
      "fileSize": 204800,
      "filePath": "/data/workspace/vault/imports/new-paper.pdf"
    }
  ],
  "totalPending": 0,
  "totalProcessing": 0,
  "totalDone": 9,
  "totalSkipped": 1,
  "totalError": 0
}
```

这是 Agent 与运维侧共用的关键接口：

- Agent 可据此知道 vault 文件是 `skip`、`apply` 还是 `propose_only`
- 运维可据此追踪 thread、manifest 路径和技能使用情况

### lint

```bash
wiki lint                                            # 校验全部页面
wiki lint --path concepts/bayesian-theorem.md        # 校验单个页面
wiki lint --level error                              # 只显示 error（忽略 warn/info）
wiki lint --format json                              # JSON 输出（默认 human-readable）
```

对所有 wiki 页面执行完整性校验。检查项分三级：

**error**（数据损坏，必须修复）：

| 检查项 | 说明 |
| --- | --- |
| 必填字段缺失 | `pageType` 或 `title` 为空 |
| pageType 未注册 | frontmatter 中的 pageType 不在 `wiki.config.json` 的 templates 中 |
| vault 引用不存在 | `sourceRefs` 中 `vault/...` 指向的文件在 `vault_files` 表中不存在 |
| 页面引用不存在 | `sourceRefs` 中 `.md` 引用 / `relatedPages` / edge 字段指向不存在的页面或 nodeId |
| frontmatter 解析失败 | YAML 语法错误，gray-matter 无法解析 |

**warn**（质量问题，建议修复）：

| 检查项 | 说明 |
| --- | --- |
| 孤立页面 | 无入链也无出链（不参与知识图谱） |
| sourceRefs 为空 | 页面无来源归属（知识来自哪里？） |
| 长期未更新 | `status: active` 但 `updatedAt` 超过 6 个月 |
| 引用已归档页面 | relatedPages/sourceRefs 指向 `status: archived` 的页面 |

**info**（提示信息）：

| 检查项 | 说明 |
| --- | --- |
| 未注册字段 | frontmatter 中存在 config 未声明的字段（存入 extra，不影响功能） |
| draft 统计 | `status: draft` 的页面数量 |
| embedding 未完成 | `embedding_status` 非 done 的页面数量 |

输出示例（human-readable，默认）：

```text
wiki lint: 142 pages checked

  ERROR  concepts/bayesian-theorem.md
         sourceRefs: vault/courses/ML-2026/ch3.pdf does not exist in vault

  ERROR  misconceptions/bayes-vs-freq.md
         relatedPages: concepts/nonexistent.md not found

  WARN   methods/pomodoro.md
         orphan page: no incoming or outgoing links

  WARN   concepts/gradient-descent.md
         sourceRefs is empty: no provenance recorded

  INFO   3 pages in draft status
  INFO   2 pages with pending embedding

Summary: 2 errors, 2 warnings, 2 info
```

输出示例（`--format json`）：

```json
{
  "errors": [
    {
      "page": "concepts/bayesian-theorem.md",
      "check": "vault_ref_exists",
      "message": "sourceRefs: vault/courses/ML-2026/ch3.pdf does not exist in vault"
    }
  ],
  "warnings": [
    {
      "page": "methods/pomodoro.md",
      "check": "orphan_page",
      "message": "No incoming or outgoing links"
    }
  ],
  "info": [
    { "check": "draft_count", "message": "3 pages in draft status" }
  ],
  "summary": { "pages": 142, "errors": 2, "warnings": 2, "info": 2 }
}
```

### export-graph

```bash
wiki export-graph                                    # 输出到 stdout
wiki export-graph --output wiki/graph/nodes.json     # 写文件
```

从 `pages`（带 node_id 的页面）和 `edges` 表导出 JSON。

### export-index

```bash
wiki export-index                                    # 输出到 stdout
wiki export-index --output wiki/index.md             # 写文件
wiki export-index --group-by pageType                # 按类型分组（默认）
wiki export-index --group-by tags                    # 按标签分组
```

从 `pages` 表生成人类可读的 Markdown 索引。示例输出：

```markdown
# Wiki Index

Generated: 2026-04-06T10:00:00+08:00 | 142 pages | 234 edges

## concept (58)

- [贝叶斯定理](concepts/bayesian-theorem.md) — active, tags: probability, ml-foundations
- [梯度下降](concepts/gradient-descent.md) — active, tags: optimization
- ...

## method (6)

- [费曼技巧](methods/feynman-technique.md) — active, domain: study-technique
- ...
```

### daemon

```bash
wiki daemon start         # 启动守护进程（定时同步）
wiki daemon stop          # 停止
wiki daemon status        # 查看状态 + 下次同步时间
```

详见 [runtime.md §4](./runtime.md)。

### check-config

```bash
wiki check-config                    # 检查环境变量 + wiki.config.json
wiki check-config --probe            # 同上 + 测试 embedding API 连通性
```

---

## 输出约定

### Exit code

| code | 含义 |
| --- | --- |
| `0` | 成功 |
| `1` | 运行时错误 |
| `2` | 配置错误 |

### 输出格式（按命令类型）

| 类型 | 命令 | 默认输出 | 机器可读选项 |
| --- | --- | --- | --- |
| 查询 | find, search, fts, graph, page-info, list, stat, vault list, vault diff, vault queue | JSON to stdout | —（默认即 JSON） |
| 变更 | init, sync, create, template create | JSON result to stdout | —（默认即 JSON） |
| 向导 | setup | interactive text | — |
| 校验 | lint | human-readable text | `--format json` |
| 导出 | export-graph | JSON | — |
| 导出 | export-index | Markdown | — |
| 信息 | doctor, check-config, template list, template show, type list, type show, type recommend, daemon status | human-readable text | `--format json` |

### 错误输出

运行时错误和配置错误统一输出 JSON 到 stderr：

```json
{"error": "...", "type": "config | runtime | not_found | not_configured"}
```
