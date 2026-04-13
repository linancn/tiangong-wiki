# @biaoo/tiangong-wiki

[English](./README.md)

> 受 Karpathy 的 [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) 启发 —— 不再像 RAG 那样每次从原始文档重新推导答案，而是让 LLM **构建并维护一个持久化的 wiki**，知识随使用不断积累。

`@biaoo/tiangong-wiki` 为这个模式提供基础设施：一个 CLI，将 Markdown 文件目录变为可查询的知识库，支持全文搜索、语义搜索、知识图谱和交互式仪表盘。

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
npm install -g @biaoo/tiangong-wiki
```

## 更新

升级 npm 包本身：

```bash
npm install -g @biaoo/tiangong-wiki@latest
```

升级 CLI 后，或上游 skill 内容有更新时，刷新工作区本地 managed skills：

```bash
tiangong-wiki skill status
tiangong-wiki skill update --all
```

<details>
<summary><strong>作为 AI Agent Skill 使用</strong></summary>

安装 npm 包后，将其注册到你的 Agent：

```bash
npx skills add Biaoo/tiangong-wiki -a codex          # Codex
npx skills add Biaoo/tiangong-wiki -a claude-code    # Claude Code
npx skills add Biaoo/tiangong-wiki -a codex -g       # 全局安装（跨项目可用）
```

或使用配置向导一步完成：

```bash
tiangong-wiki setup
```

如果需要把任意 repo/path 来源的 skill 作为工作区本地 managed skill 管理，可以继续使用：

```bash
tiangong-wiki skill add ../my-skills --skill notes
tiangong-wiki skill status
tiangong-wiki skill update notes
tiangong-wiki skill update --all
```

</details>

## 快速开始

```bash
cd /path/to/your/workspace                           # 在工作区根目录执行命令
tiangong-wiki setup                                   # 交互式配置向导
tiangong-wiki doctor                                  # 验证配置
tiangong-wiki init                                    # 初始化工作区
tiangong-wiki sync                                    # 索引 Markdown 文件
```

`tiangong-wiki setup` 会创建工作区本地 `.wiki.env`，并将其记录为默认工作区配置。CLI 的配置解析优先级如下：

1. `--env-file <path>`
2. `WIKI_ENV_FILE`
3. 从当前目录向上查找最近的 `.wiki.env`
4. `tiangong-wiki setup` 写入的全局默认工作区配置

这意味着命令仍然最适合在 workspace 内执行；但 setup 之后，即使在 workspace 外运行，也可以通过默认配置正常工作，或者通过 `--env-file` 显式指定目标工作区。

```bash
tiangong-wiki find --type concept --status active     # 结构化查询
tiangong-wiki fts "贝叶斯"                             # 全文搜索
tiangong-wiki search "优化算法的收敛条件"                # 语义搜索
tiangong-wiki graph bayes-theorem --depth 2           # 图遍历
```

```bash
tiangong-wiki daemon start                            # 后台启动 daemon
tiangong-wiki dashboard                               # 在浏览器中打开仪表盘
# 或者：tiangong-wiki daemon run                      # 前台运行 daemon，适合调试
```

> 环境变量通过 `.wiki.env` 管理（由 `tiangong-wiki setup` 创建）。CLI 会优先使用最近的本地 `.wiki.env`，找不到时再 fallback 到全局默认工作区配置。完整参考见 [references/troubleshooting.md](./references/troubleshooting.md)。

## CLI

```
配置引导      setup · skill · doctor · check-config
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

![Tiangong-Wiki：持久化 AI 知识框架](./assets/tiangong-wiki-framework.png)

**Vault → Pages** — 原始素材进入 vault，Agentic Workflow 逐个阅读，通过 `tiangong-wiki type list / find / fts` 发现当前知识体系，决定跳过、创建或更新页面。

**双引擎** — Markdown 文件是唯一真实来源，SQLite 是由 `tiangong-wiki sync` 构建的衍生索引，提供纯文件无法实现的查询能力。

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
git clone https://github.com/Biaoo/tiangong-wiki.git
cd tiangong-wiki
npm install && npm run build

npm run dev -- --help        # 从源码运行 CLI
npm run dev:dashboard        # 仪表盘开发服务器
npm test                     # 运行测试
```

## 参与贡献

欢迎提 Issue 和 Pull Request。如果是较大的改动，请先开 Issue 讨论。
