# @biaoo/wiki

[English](./README.md)

[LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) 模式的实现 —— 不再每次从原始文档重新推导答案（如 RAG），而是让 LLM **增量构建并维护一个持久化的 wiki**：一个结构化、互相链接的 Markdown 页面集合，随着使用不断丰富。你负责添加素材、提出问题、探索知识；AI 负责摘要、交叉引用和日常维护。

`@biaoo/wiki` 为这个模式提供基础设施：一个 CLI 和索引引擎，将 Markdown 文件目录变为可查询的知识库，支持全文搜索、语义搜索和知识图谱。

## 特性

- **知识持续积累** — 每添加一个素材、每提出一个问题，wiki 都会变得更丰富；知识编译一次并持续更新，而非每次查询重新推导
- **你的文件，你的数据** — 纯 Markdown 页面，你完全拥有和控制；无需云端、无需数据库服务、无供应商锁定
- **随时找到任何知识** — 按元数据、关键词或自然语言语义搜索整个知识库
- **看见知识之间的关联** — 自动从页面中提取关系，构建可导航的知识图谱
- **摄入原始素材** — 将 PDF、文档、笔记放入 vault，AI 自动阅读并转化为结构化的 wiki 页面
- **内置 AI Agent** — 作为 [Codex / Claude Code Skill](./SKILL.md) 使用，让 Agent 代你查询、创建和维护知识
- **可视化仪表盘** — 通过交互式 Web 界面探索知识图谱、浏览页面、搜索内容

## 安装

```bash
npm install -g @biaoo/wiki
```

需要 Node.js >= 18。

### 作为 AI Agent Skill 使用

`@biaoo/wiki` 同时也是 Codex 和 Claude Code 的 [Agent Skill](./SKILL.md)。安装 npm 包后，将其注册到你的 Agent：

```bash
# Codex
npx skills add Biaoo/wiki -a codex

# Claude Code
npx skills add Biaoo/wiki -a claude-code

# 全局安装（跨项目可用）
npx skills add Biaoo/wiki -a codex -g
```

也可以使用内置的配置向导，一步完成 npm 安装和 skill 注册：

```bash
wiki setup
```

## 快速开始

`wiki setup` 会交互式创建 `.wiki.env` 文件，包含所有必要的环境变量（`WIKI_PATH`、`VAULT_PATH`、embedding 配置等）。完整变量说明见 [references/env.md](./references/env.md)。

```bash
# 交互式配置向导 — 创建 .wiki.env 配置文件并初始化工作区
wiki setup

# 验证配置
wiki doctor

# 初始化工作区（创建目录、配置、模板）
wiki init

# 索引你的 Markdown 文件
wiki sync

# 查询
wiki find --type concept --status active
wiki fts "贝叶斯"
wiki search "优化算法的收敛条件"    # 需要配置 embedding
wiki graph bayes-theorem --depth 2
```

## 守护进程

守护进程提供本地 HTTP 服务，用于 Web 仪表盘和更快的查询响应。仅监听 `127.0.0.1`。

```bash
# 前台运行（推荐配合 pm2、launchd、systemd 等进程管理器）
wiki daemon run

# 后台运行（便捷方式，启动 detached 子进程）
wiki daemon start

# 查看状态 / 停止
wiki daemon status
wiki daemon stop
```

守护进程运行时，查询命令（`find`、`fts`、`search`、`graph` 等）会自动通过 HTTP 路由以获得更好的性能。如果守护进程不可用，则回退到本地直接执行。

## CLI 概览

```
配置引导      setup · doctor · check-config
索引管理      init · sync
查询          find · fts · search · graph
自省          list · page-info · stat · lint
创建          create · template · type
Vault        vault list|diff|queue
导出          export-graph · export-index
守护进程      daemon run|start|stop|status
仪表盘        dashboard
```

运行 `wiki --help` 或 `wiki <command> --help` 查看用法。完整命令参考见 [references/cli-interface.md](./references/cli-interface.md)。

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
                         │ wiki sync — 解析 frontmatter
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
(元数据)     (关键词)    (语义)      (图遍历)
   │           │           │           │
   └───────────┴───────────┴───────────┘
                     │
                     ▼
          JSON stdout / HTTP daemon
                     │
        ┌────────────┴────────────┐
        ▼                         ▼
   CLI / 脚本              Web 仪表盘
                         (Preact + G6 图谱)
```

**Vault → Pages 流水线** — 原始素材（PDF、文档、笔记）进入 Vault。由 Codex SDK 驱动的 Agentic Workflow 逐个阅读文件，通过 `wiki type list / find / fts` 发现当前知识体系，然后决定是跳过、创建新页面还是更新已有页面。最终产出结构化的 Markdown 页面到 `wiki/pages/`。

**双引擎设计** — Markdown 页面是唯一真实来源，人和 AI Agent 可以直接读写。SQLite 数据库是由 `wiki sync` 构建的衍生索引，提供纯文件无法实现的结构化查询、全文搜索、向量相似度和图谱遍历。

**三级列模型** — 页面元数据使用灵活的列体系：固定列（硬编码 schema）、部署列（`wiki.config.json` 自定义字段，全局生效）、模板列（按 pageType 生效的字段）。Schema 变更通过 `ALTER TABLE` 自动处理，无需手动迁移。

## 技术栈

| 组件 | 技术 |
|------|------|
| 语言 | TypeScript (ESM) |
| 运行时 | Node.js >= 18 |
| CLI 框架 | [Commander.js](https://github.com/tj/commander.js) |
| 数据库 | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) |
| 向量检索 | [sqlite-vec](https://github.com/asg017/sqlite-vec) |
| 仪表盘 | [Preact](https://preactjs.com/) + [G6](https://g6.antv.antgroup.com/) |
| 构建 | [Vite](https://vite.dev/) |
| 测试 | [Vitest](https://vitest.dev/) |

## 开发

```bash
git clone https://github.com/Biaoo/wiki.git
cd wiki
npm install
npm run build

# 从源码运行 CLI
npm run dev -- --help

# 启动仪表盘开发服务器
npm run dev:dashboard

# 运行测试
npm test
```

## 许可证

[MIT](./LICENSE)
