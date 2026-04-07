# Agent 指导

本文档定义 Agent 如何使用 Wiki Skill 的 CLI 工具，以及何时创建、更新、归档 wiki 页面。

这些内容不由 Wiki Skill 代码实现，而是写入 Agent 的行为指令（Instruction）中，让 AI 在合适的时机调用 CLI 命令。

---

## 1. 何时创建 wiki 页面

| 场景 | 目标 pageType | 判断标准 |
| --- | --- | --- |
| Agent 回答综合了 2+ 来源的新理解 | concept / bridge | 产生了来源中没有的综合洞察 |
| Agent 发现跨领域关联 | bridge | 涉及不同上下文的知识迁移 |
| 用户纠正了一个理解错误 | misconception | 有明确的"原来 → 正确"转变 |
| 用户形成了稳定方法论 | method | 经验证有效的做法，非一次性操作 |
| vault 新增重要来源材料 | 由当前 ontology 决定（可能是 source-summary / concept / method / lesson / research-note / ...） | 先查询现有类型系统与已有页面，再决定是 `skip`、`apply` 还是 `propose_only` |
| 用户反复问同一个问题 | faq | 第 3 次以上遇到类似问题 |
| 认识了新的人 | person | 有持续影响的关系 |
| 获得了荣誉/认证 | achievement | 有可验证的成就 |
| 纯事实查询（"这个公式是什么"） | — | **不创建**，不值得沉淀 |

---

## 2. 何时更新 wiki 页面

- 新证据补充了已有概念 → 更新 concept 页的相关 section
- 误解被解决 → 更新 misconception 页的 `resolvedAt` 和正确理解
- 对某个方法有了新的使用经验 → 更新 method 页的使用记录
- 人际关系变化 → 更新 person 页
- **所有更新必须同步修改 frontmatter 的 `updatedAt` 字段**

---

## 3. 何时归档

- 内容不再有跨领域迁移价值 → `status: archived`
- 被新页面完全取代的旧页面 → `status: archived`
- 长期未使用（> 6 个月未更新）且无入链 → 归档候选

---

## 4. 典型工作流

### 日常查询

```text
# 查找特定类型的页面
wiki find --type concept --status active

# 全文搜索
wiki fts "梯度下降"

# 语义搜索（需配置 Embedding）
wiki search "优化算法的收敛条件"

# 深度阅读（Agent 原生能力）
Read /data/workspace/wiki/pages/concepts/gradient-descent.md

# 在页面内容中搜索（Agent 原生能力）
Grep "学习率" wiki/pages/
```

### 知识沉淀

```text
# 1. 创建页面骨架
wiki create --type concept --title "朴素贝叶斯分类器" --node-id naive-bayes

# 2. 填写内容（Agent 原生能力）
Edit /data/workspace/wiki/pages/concepts/naive-bayes.md
  → 填写 ## 核心理解、## 关键公式 等 section

# 3. 立即索引
wiki sync --path concepts/naive-bayes.md
```

### 每日例行

```text
# 1. 更新索引（同时记录 vault 变更到 vault_changelog）
wiki sync

# 2. 查看全局状况
wiki stat

# 3. 检查 vault 本次 sync 检测到的新文件（读取 sync 写入的 changelog，必须在 sync 之后）
wiki vault diff

# 4. 对于新增的 vault 文件，查看详情
wiki vault list --path projects/phoenix/ --ext pdf

# 5. 通过 CLI discovery 当前 ontology
wiki type list --format json
wiki type show concept --format json
wiki type recommend --text "A reusable project decision workflow" --keywords "workflow,decision" --limit 5 --format json

# 6. 根据 AI 判断创建/更新页面
wiki create --type method --title "Phoenix Decision Review Workflow"
Edit <file_path>
wiki sync --path <file_path>

# 7. 可选：导出人类可读索引
wiki export-index --output wiki/index.md
```

### 知识探索

```text
# 查看某概念的知识图谱
wiki graph bayesian-theorem --depth 2

# 查看概念的前置依赖链
wiki graph bayesian-theorem --edge-type prerequisite --depth 3

# 查看某页面的完整信息
wiki page-info concepts/bayesian-theorem.md
```

---

## 5. 与其他 Skill 的协作模式

### Memory → Wiki

Memory Skill 记录每日事件。Wiki Skill 不主动从 memory 中提取信息，而是由 Agent Instruction 驱动：

```text
Agent 判断 memory 中某条记录值得沉淀:
  1. wiki find --type concept --node-id <相关概念>   ← 检查是否已有页面
  2. 如果有 → Edit 更新已有页面
  3. 如果没有 → wiki create --type concept ...       ← 创建新页面
  4. wiki sync --path <file>
```

### Vault → Wiki

vault 新增文件时：

```text
Agent 在日常例行中（wiki sync 之后）:
  1. wiki vault diff                                  ← 读取 sync 记录的新增文件
  2. wiki vault queue                                 ← 查看自动处理状态、thread、decision、skills
  3. wiki type list / show / recommend               ← discovery 当前 ontology
  4. 判断文件价值，以及是 skip / apply / propose_only
  5. 如果需要手动介入：创建或更新最合适的 page type，而不是默认写 source-summary
  6. 读取 vault 文件内容，提取关键信息填入 wiki 页面
  7. 更新相关页面的 sourceRefs / relatedPages
  8. wiki sync --path <file> 或 wiki sync
```

### Profile → Wiki

Profile Skill 维护结构化状态数据。Wiki 中的 achievement 页可以引用 Profile 中的数据：

```text
Agent 更新成就页时:
  1. 读取 Profile 中的相关数据
  2. 在 achievement 页的 frontmatter 中设置对应标签
  3. wiki sync --path <file>
```
