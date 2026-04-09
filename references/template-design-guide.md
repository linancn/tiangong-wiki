# Template 设计指南

本文档定义如何为 wiki 设计新的 page type 和对应 template。适用于手动创建和 AI 自动演化（`ALLOW_TEMPLATE_EVOLUTION=true`）两种场景。

---

## 1. Template 是什么

一个 template 由两部分组成：

### 模板文件（`templates/<type>.md`）

定义页面的 frontmatter 字段和 body section 骨架：

```yaml
---
pageType: <type>
title: <Type Title>
nodeId: <type-slug>
status: draft
visibility: private
sourceRefs: []
relatedPages: []
tags: []
createdAt: 2026-04-06
updatedAt: 2026-04-06
# ... type-specific fields
---

## Section 1

引导性提示文本，告诉作者这一节该写什么。

## Section 2

...
```

### 配置注册（`wiki.config.json` 的 `templates.<type>`）

定义该类型的索引行为：

```json
{
  "file": "templates/<type>.md",
  "columns": { },
  "edges": { },
  "summaryFields": [ ]
}
```

两者缺一不可。模板文件定义"写什么"，配置注册定义"怎么索引"。

---

## 2. 何时需要新 Type

创建新 type 之前，先确认现有类型是否能覆盖：

- 这类知识的**结构**是否与现有类型有本质差异？（字段不同、section 不同）
- 还是仅仅是**主题**不同？（同样的结构，只是内容领域不同）

**主题差异用 tags 区分，结构差异才建新 type。**

示例判断：
- "环境领域的研究笔记" vs "教育领域的研究笔记" → 用 `research-note` + 不同 tags
- "会议纪要" vs "研究笔记" → 结构不同（参会人、决议、待办 vs 研究问题、文献、发现），需要新 type

---

## 3. Frontmatter 字段设计

### 通用字段（不需要设计，自动继承）

所有 type 共享以下字段，模板中必须包含：

```yaml
pageType, title, nodeId, status, visibility,
sourceRefs, relatedPages, tags, createdAt, updatedAt
```

### Type-specific 字段设计原则

1. **只加对查询或分类有意义的字段**。如果一个字段只在 body 中出现，不需要放进 frontmatter
2. **字段值应该是短文本或枚举**，不是长段落。长内容放 body section
3. **字段命名使用 camelCase**，系统会自动映射为 snake_case 列名
4. **不要重复通用字段的语义**。比如不要加 `category` 字段，用 `tags` 代替

### 字段放哪一层

| 问题 | 放在 | 原因 |
| --- | --- | --- |
| 需要 `tiangong-wiki find --<field>` 过滤？ | `columns` | 建 SQLite 索引列，支持结构化查询 |
| 需要出现在 `tiangong-wiki search` / `tiangong-wiki fts` 的摘要中？ | `summaryFields` | 纳入 summary_text 用于检索 |
| 需要生成 edge（关联到其他页面/节点）？ | `edges` | 写入 edges 表，支持 graph 遍历 |
| 只是页面内的补充信息？ | 仍需显式登记到 schema | 当前实现不会接受“只写 frontmatter、不做声明”的字段 |

---

## 4. Columns 设计

`columns` 中的字段会在 `pages` 表上建列和索引，支持 `tiangong-wiki find` 的结构化过滤。

```json
"columns": {
  "severity": "text",
  "resolvedAt": "text"
}
```

**设计要点**：

- 类型目前只支持 `"text"`
- 只有需要频繁按值过滤的字段才值得建列
- 不同 type 的 columns 共存于同一张 `pages` 表，非该类型的页面该列值为 NULL
- 列名全局唯一 — 如果两个 type 都有 `severity` 字段，它们共享同一个列
- 任何模板 frontmatter 中出现的 type-specific 字段，都必须至少在 `columns`、`edges` 或 `commonEdges` 之一中声明；否则会被 lint 视为 `unregistered_fields`

---

## 5. Edges 设计

`edges` 定义 frontmatter 中的数组字段如何生成 graph 边。

```json
"edges": {
  "prerequisites": {
    "edgeType": "prerequisite",
    "resolve": "nodeId"
  }
}
```

**三个字段**：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `edgeType` | 是 | edge 类型标识，写入 `edges.edge_type` |
| `resolve` | 是 | 目标匹配方式：`"nodeId"` 匹配 `pages.node_id`；`"path"` 匹配 `pages.id` |
| `match` | 否 | 正则前置过滤，仅匹配的值参与 resolve |

**设计要点**：

- 只有**指向其他页面或节点**的数组字段才需要定义 edge
- `edgeType` 应该表达语义关系（`prerequisite`, `corrects`, `bridges_from`），不是字段名
- `resolve: "nodeId"` 适用于引用知识图谱中的概念节点
- `resolve: "path"` 适用于引用具体的页面文件路径
- `commonEdges`（`relatedPages`, `sourceRefs`）已全局生效，template 中不需要重复定义

---

## 6. SummaryFields 设计

`summaryFields` 中的字段值会拼接进 `pages.summary_text`，用于语义搜索和全文检索。

```json
"summaryFields": ["confidence", "masteryLevel", "prerequisites"]
```

**设计要点**：

- 选择能帮助检索的字段 — 如果知道 `domain: "环境工程"` 能帮搜索找到这个页面，就加进去
- 不要放长文本字段，summary_text 应保持简洁
- `defaultSummaryFields`（`title`, `tags`）自动包含，不需要重复
- `summaryFields` 只决定是否进入 `summary_text`，不会自动注册字段；字段本身仍必须先在 `columns`、`edges` 或 `commonEdges` 中声明

---

## 7. Body Section 设计

Body section 是模板文件中 frontmatter 之后的 Markdown 骨架，引导作者（人或 AI）写出结构化内容。

**设计原则**：

1. **每个 section 用 `##` 标题** 开头
2. **写一句引导性提示**，告诉作者这一节的目的和期望内容，不是模板占位符
3. **提示语应该是具体的引导**，不是"在此处填写内容"这样的泛泛之词
4. **Section 数量控制在 3-6 个** — 太少缺乏结构，太多增加写作负担
5. **Section 之间应该有逻辑递进** — 比如从"是什么"到"为什么重要"到"如何使用"

**好的提示语示例**：

```markdown
## 核心理解

用两到四句话说明这个概念到底是什么，以及它为什么值得记住。
```

**差的提示语示例**：

```markdown
## 内容

<!-- 在此处填写内容 -->
```

---

## 8. 完整示例

假设需要设计一个 `meeting-note` 类型：

### 模板文件 `templates/meeting-note.md`

```yaml
---
pageType: meeting-note
title: Meeting Note Title
nodeId: meeting-note-slug
status: draft
visibility: private
sourceRefs: []
relatedPages: []
tags: []
createdAt: 2026-04-06
updatedAt: 2026-04-06
meetingDate:
participants: []
decisions: []
---

## 背景

简要说明这次会议的目的和上下文，让没参加的人能快速理解为什么开这个会。

## 关键讨论

记录会上最重要的讨论点和不同意见，重点是分歧和最终共识，不是流水账。

## 决议

列出会议达成的具体决定，每条决议应该是可执行的，不是模糊的方向。

## 后续待办

列出需要跟进的行动项，标注负责人和预期完成时间。
```

### 配置注册

```json
"meeting-note": {
  "file": "templates/meeting-note.md",
  "columns": {
    "meetingDate": "text"
  },
  "edges": {},
  "summaryFields": ["meetingDate", "participants", "decisions"]
}
```

**设计决策说明**：

- `meetingDate` 建列 — 需要按日期过滤查找
- `participants` 不建列 — 查参会人用 `tiangong-wiki fts` 搜索 summary_text 即可
- `participants` 和 `decisions` 放入 summaryFields — 帮助搜索命中
- `decisions` 不建 edge — 决议是文本，不是指向其他页面的引用
- Body 4 个 section — 背景 → 讨论 → 决议 → 待办，逻辑递进

---

## 9. 检查清单

设计完 template 后，用以下问题自检：

- [ ] 新 type 的结构是否与所有现有 type 都有本质差异？
- [ ] 每个 frontmatter 字段都有明确的查询或分类用途？
- [ ] 需要 `tiangong-wiki find` 过滤的字段都放进了 `columns`？
- [ ] 生成 graph 边的数组字段都定义了 `edges`？
- [ ] `summaryFields` 包含了有助于检索的关键字段？
- [ ] 模板 frontmatter 里的每个 type-specific 字段都已在 `columns`、`edges` 或 `commonEdges` 中声明？
- [ ] Body section 数量在 3-6 个之间，有逻辑递进？
- [ ] Section 提示语具体而非泛泛？
- [ ] 通过 `tiangong-wiki template create --type <type> --title <title>` 创建后，可以先跑 `tiangong-wiki template lint`，再跑 `tiangong-wiki sync` + `tiangong-wiki lint`，且都无 error？
