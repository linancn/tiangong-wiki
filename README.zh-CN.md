# @biaoo/wiki

[English](./README.md)

> 受 Karpathy 的 [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) 启发 —— 不再像 RAG 那样每次从原始文档重新推导答案，而是让 LLM **构建并维护一个持久化的 wiki**，知识随使用不断积累。

`@biaoo/wiki` 为这个模式提供基础设施：一个 CLI，将 Markdown 文件目录变为可查询的知识库，支持全文搜索、语义搜索、知识图谱和交互式仪表盘。

## 特性

| | |
|---|---|
| **知识持续积累** | 每添加一个素材、每提出一个问题，wiki 都变得更丰富 —— 编译一次，持续更新 |
| **你的文件，你的数据** | 纯 Markdown，你完全拥有；无需云端、无需数据库服务、无锁定 |
| **随时找到任何知识** | 元数据过滤、关键词搜索、语义搜索，一个 CLI 搞定 |
| **看见知识关联** | 自动提取页面间关系，构建可导航的知识图谱 |
| **摄入原始素材** | 将文件放入 vault，AI 自动阅读并转化为结构化页面 |
| **AI Agent 原生** | 作为 [Codex / Claude Code Skill](./SKILL.md) 使用，支持自主知识工作 |
| **可视化仪表盘** | 通过 Web 界面浏览图谱、查看页面、搜索内容 |

## 安装

```bash
npm install -g @biaoo/wiki
```

<details>
<summary><strong>作为 AI Agent Skill 使用</strong></summary>

安装 npm 包后，将其注册到你的 Agent：

```bash
npx skills add Biaoo/wiki -a codex          # Codex
npx skills add Biaoo/wiki -a claude-code    # Claude Code
npx skills add Biaoo/wiki -a codex -g       # 全局安装（跨项目可用）
```

或使用配置向导一步完成：

```bash
wiki setup
```

</details>

## 快速开始

```bash
wiki setup                                   # 交互式配置向导
wiki doctor                                  # 验证配置
wiki init                                    # 初始化工作区
wiki sync                                    # 索引 Markdown 文件
```

```bash
wiki find --type concept --status active     # 结构化查询
wiki fts "贝叶斯"                             # 全文搜索
wiki search "优化算法的收敛条件"                # 语义搜索
wiki graph bayes-theorem --depth 2           # 图遍历
```

```bash
wiki daemon run                              # 启动仪表盘和 HTTP API
wiki dashboard                               # 在浏览器中打开仪表盘
```

> 环境变量通过 `.wiki.env` 管理（由 `wiki setup` 创建）。完整参考见 [references/env.md](./references/env.md)。

## CLI

```
配置引导      setup · doctor · check-config
索引管理      init · sync
查询          find · fts · search · graph
自省          list · page-info · stat · lint
创建          create · template · type
Vault        vault list | diff | queue
导出          export-graph · export-index
守护进程      daemon run | start | stop | status
仪表盘        dashboard
```

完整命令参考见 [references/cli-interface.md](./references/cli-interface.md)。

## 技术架构

```
┌──────────────────────────────────────────────────────────┐
│                    Vault（原始素材）                        │
│           PDF、文档、笔记、书签、剪藏                        │
└────────────────────────┬─────────────────────────────────┘
                         │ vault diff / vault queue
                         ▼
┌──────────────────────────────────────────────────────────┐
│              Agentic Workflow（Codex SDK）                 │
│                                                          │
│  ┌─────────┐  解析    ┌────────────┐  发现体系  ┌─────┐  │
│  │ Parser  │ ──────►  │ wiki-skill │ ────────► │ LLM │  │
│  │ Skills  │  素材    │ find / fts │  + 决策   │     │  │
│  └─────────┘          └────────────┘           └─────┘  │
│  pdf · docx · pptx                                       │
│                                                          │
│  → 跳过 / 创建页面 / 更新页面 / 仅提议                      │
└────────────────────────┬─────────────────────────────────┘
                         │ 写入页面
                         ▼
┌──────────────────────────────────────────────────────────┐
│               Markdown 页面（唯一真实来源）                  │
│                    wiki/pages/**/*.md                     │
└────────────────────────┬─────────────────────────────────┘
                         │ wiki sync
                         ▼
┌──────────────────────────────────────────────────────────┐
│                  SQLite 索引 (index.db)                    │
│                                                          │
│  pages          结构化元数据（动态列）                       │
│  pages_fts      FTS5 全文搜索                              │
│  vec_pages      sqlite-vec 向量嵌入                        │
│  edges          知识图谱（source → target）                 │
└──┬───────────┬───────────┬───────────┬───────────────────┘
   │           │           │           │
   ▼           ▼           ▼           ▼
  find        fts       search       graph
   │           │           │           │
   └───────────┴───────────┴───────────┘
                     │
                     ▼
          JSON stdout / HTTP daemon
                     │
        ┌────────────┴────────────┐
        ▼                         ▼
   CLI / 脚本              Web 仪表盘
```

**Vault → Pages** — 原始素材进入 vault，Agentic Workflow 逐个阅读，通过 `wiki type list / find / fts` 发现当前知识体系，决定跳过、创建或更新页面。

**双引擎** — Markdown 文件是唯一真实来源，SQLite 是由 `wiki sync` 构建的衍生索引，提供纯文件无法实现的查询能力。

**灵活 Schema** — 三级列模型（固定列、部署列、模板列），配置变更时自动 `ALTER TABLE`，无需手动迁移。

## 技术栈

| | |
|---|---|
| 语言 | TypeScript (ESM) |
| 运行时 | Node.js >= 18 |
| CLI 框架 | [Commander.js](https://github.com/tj/commander.js) |
| 数据库 | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) + [sqlite-vec](https://github.com/asg017/sqlite-vec) |
| 仪表盘 | [Preact](https://preactjs.com/) + [G6](https://g6.antv.antgroup.com/) |
| 构建 | [Vite](https://vite.dev/) |
| 测试 | [Vitest](https://vitest.dev/) |

## 开发

```bash
git clone https://github.com/Biaoo/wiki.git
cd wiki
npm install && npm run build

npm run dev -- --help        # 从源码运行 CLI
npm run dev:dashboard        # 仪表盘开发服务器
npm test                     # 运行测试
```

## 参与贡献

欢迎提 Issue 和 Pull Request。如果是较大的改动，请先开 Issue 讨论。
