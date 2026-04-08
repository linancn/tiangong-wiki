# Wiki Skill

`@biaoo/wiki` — 本地优先的 Markdown 知识库索引与查询引擎。

将 Markdown 文件作为唯一真实来源（SSOT），通过 SQLite 构建结构化索引、全文搜索、语义向量检索和知识图谱，供 AI Agent 或人工直接使用。

## 技术架构

### 三层模型

```text
┌─────────────────────────────────────────────────────────┐
│  Agent Native（原生能力）                                │
│  深度阅读、正则搜索、直接编辑 Markdown                    │
├─────────────────────────────────────────────────────────┤
│  Agent Instruction（AI 决策）                            │
│  "这个文件该不该入库？" "用什么 pageType？"                │
├─────────────────────────────────────────────────────────┤
│  Wiki Skill（确定性逻辑）                                │
│  文件扫描 → YAML 解析 → SQLite UPSERT → 多维查询         │
└─────────────────────────────────────────────────────────┘
```

### 双引擎设计

| 引擎 | 存储 | 用途 |
|------|------|------|
| Markdown 文件 | `wiki/pages/` | SSOT，人和 AI 可直接读写 |
| SQLite 索引 | `index.db` | 结构化查询、FTS5 全文搜索、sqlite-vec 向量检索、图谱遍历 |

### 双目录管理

| 目录 | 索引深度 | 说明 |
|------|----------|------|
| `wiki/pages/` | 完整索引（frontmatter 解析、edges 提取、FTS、embedding） | 知识库页面 |
| `vault/` | 轻量索引（文件元数据：路径、大小、时间） | 外部素材待处理区 |

## 技术栈

| 组件 | 技术 | 版本 |
|------|------|------|
| 语言 | TypeScript (ESM) | ^6.0 |
| 运行时 | Node.js | >=18 |
| CLI 框架 | Commander.js | ^14.0 |
| 数据库 | better-sqlite3 | ^12.8 |
| 向量检索 | sqlite-vec | ^0.1.9 |
| Frontmatter 解析 | gray-matter | ^4.0 |
| 工作流引擎 | @openai/codex-sdk | ^0.118 |
| 测试框架 | Vitest | ^4.1 |

## 数据模型

### SQLite Schema（7 张表）

```text
pages             ─── 知识页面（固定列 + 动态列）
pages_fts         ─── FTS5 全文搜索（title, tags, summary_text）
vec_pages         ─── 向量表（sqlite-vec, metadata-only embedding）
edges             ─── 知识图谱边（source → target, edge_type）
vault_files       ─── Vault 文件索引
vault_changelog   ─── Vault 变更日志
vault_processing_queue ─── Vault 处理队列（Codex 工作流状态）
sync_meta         ─── 同步元数据（KV 存储）
```

### 三级索引列模型

1. **固定列** — 硬编码在 schema 中（id, title, pageType, status, tags...）
2. **部署列** — `wiki.config.json` 的 `customColumns`，全局生效
3. **模板列** — 各 `templates[type].columns`，按 pageType 生效

配置变更时自动 `ALTER TABLE` 添加新列，无需手动迁移。

### 11 种内置 pageType

concept · misconception · bridge · source-summary · lesson · method · person · achievement · resume · research-note · faq

每种类型有独立模板（`assets/templates/`），定义特有的 frontmatter 字段和 edge 规则。

## CLI 命令

```text
安装引导    setup · doctor
索引管理    init · sync · check-config
结构化查询  find [--type] [--status] [--tag]
全文搜索    fts <query>
语义搜索    search <query>               （需配置 embedding）
知识图谱    graph <nodeId> [--depth N]
自省        list · page-info · stat
创建页面    create --type <type> --title <title>
模板管理    template list|show|create
类型发现    type list|show|recommend
Vault      vault list|diff|queue
校验        lint [--level error|warn|info]
导出        export-graph · export-index
守护进程    daemon run|start|stop|status
```

所有查询命令输出 JSON 到 stdout，适合管道和脚本集成。

## Daemon 运行模型

- `wiki daemon run`：前台启动本地 HTTP daemon，适合 `launchd`、`systemd`、`pm2` 之类的进程管理器托管
- `wiki daemon start`：本机便利入口，本质是 detached spawn `wiki daemon run`
- daemon 只监听 `127.0.0.1`
- `WIKI_DAEMON_PORT` 可选；未设置时使用动态端口
- daemon 启动后会把实际 `host/port/pid/launchMode` 写入 `wiki/.wiki-daemon.state.json`
- daemon 健康时，`sync/find/fts/search/graph/page-info/list/stat/vault/*/create/lint/type*/template*/export-*` 优先走 HTTP
- daemon degraded 时，读命令回退到本地执行；写命令拒绝绕过 daemon 直写

## 同步流程

```text
sync
 ├─ 0. 检查 schema 版本（变更 → 全量重建）
 ├─ 1. 扫描文件（SHA-256 content_hash 变更检测）
 ├─ 2. 解析 frontmatter + 提取 edges
 ├─ 3. UPSERT 事务（insert / update / delete）
 ├─ 4. Embedding（metadata-only，增量处理）
 ├─ 5. Vault 扫描 + 队列管理
 └─ 6. 更新 sync_meta
```

支持 `--path` 单文件同步，自动检测配置/embedding profile 变更并升级为全量同步。

## Vault → Wiki 工作流

```text
vault 新文件 → vault_processing_queue (pending)
                     │
              Codex SDK 工作流
              ├─ 运行时发现（wiki type list / wiki find / wiki fts）
              ├─ 阅读文件内容
              └─ 产出 decision + actions[]
                     │
              ┌──────┼──────┐
              skip   apply   propose_only
                     │
              创建/更新 wiki pages
              模板演化守卫（默认 proposal_only）
```

## 安装

### 从 npm 安装

```bash
npm install -g @biaoo/wiki
wiki --version
```

### 本地开发安装

```bash
# 在 wiki 源码目录中
cd wiki/
npm install && npm run build

# 方式一：npm link（推荐，改代码后 rebuild 即生效）
npm link
wiki --version

# 方式二：直接运行编译产物
node dist/index.js --version
```

`npm link` 会在全局 bin 目录创建 `wiki` 符号链接，指向当前目录的 `dist/index.js`。卸载用 `npm unlink -g @biaoo/wiki`。

### 作为 Codex Skill 安装

wiki-skill 同时是一个标准的 [Agent Skill](https://github.com/vercel-labs/skills)，可以通过 `npx skills add` 注册到 AI Agent。

```bash
# 1. 先安装 npm 包（提供 wiki CLI + 编译产物 + native 依赖）
npm install -g @biaoo/wiki

# 2. 将 skill 注册到 agent（symlink SKILL.md + references/ 等到 agent skills 目录）
npx skills add Biaoo/wiki -a codex           # Codex agent
npx skills add Biaoo/wiki -a claude-code      # Claude Code
npx skills add Biaoo/wiki -a codex -g         # 全局安装（跨项目可用）
```

步骤 1 是必须的——`npx skills add` 只做文件 symlink，不会执行 `npm install` 或 `npm run build`。

也可以跳过手动注册，用 `wiki setup` 自动完成 skill 安装到当前 workspace：

```bash
wiki setup    # 交互式向导，自动将 wiki-skill 安装到 workspace/.agents/skills/，并可选择 local / Synology vault
```

安装后 agent 可以通过 `SKILL.md` 中的 `name` 和 `description` 自动发现并触发 wiki-skill。

## 快速开始

```bash
# 运行完整配置向导（写入 .wiki.env，并安装 workspace-local skills）
wiki setup

# 自检（含 workspace-local skills；如使用 Synology 可加 --probe）
wiki doctor
wiki doctor --probe

# 初始化工作区
wiki init

# 同步索引
wiki sync

# 查询
wiki find --type concept --status active
wiki fts "贝叶斯"
wiki search "优化算法的收敛条件"    # 需配置 EMBEDDING_*
wiki graph bayes-theorem --depth 2
```

## 环境变量

推荐做法：

- 首次安装时运行 `wiki setup`
- `wiki setup` 会写入当前工作目录下的 `.wiki.env`
- `wiki setup` 会把 `wiki-skill` 安装到 `workspace/.agents/skills/wiki-skill`
- 如果你选了 parser skills，setup 也会把它们安装到 `workspace/.agents/skills/`
- 如果你选了 `VAULT_SOURCE=synology`，setup 还会写入 `SYNOLOGY_*` 与 `VAULT_SYNOLOGY_REMOTE_PATH`
- CLI 启动时会自动发现最近的 `.wiki.env`
- 也可以显式设置 `WIKI_ENV_FILE=/absolute/path/to/.wiki.env`

| 变量 | 必需 | 说明 |
|------|------|------|
| `WIKI_ENV_FILE` | 否 | 显式指定要加载的 `.wiki.env` 文件 |
| `WIKI_PATH` | 是 | 知识库页面目录（精确到 `pages/`） |
| `VAULT_PATH` | 否 | 外部素材目录（默认 `../vault`）；在 Synology 模式下是本地 cache 目录 |
| `VAULT_SOURCE` | 否 | `local` 或 `synology` |
| `VAULT_HASH_MODE` | 否 | `content` 或 `mtime`；Synology 推荐 `mtime` |
| `VAULT_SYNOLOGY_REMOTE_PATH` | 否 | Synology vault 远端目录 |
| `SYNOLOGY_BASE_URL` | 否 | Synology DSM 地址 |
| `SYNOLOGY_USERNAME` | 否 | Synology DSM 用户名 |
| `SYNOLOGY_PASSWORD` | 否 | Synology DSM 密码 |
| `SYNOLOGY_VERIFY_SSL` | 否 | 是否校验 DSM TLS 证书 |
| `SYNOLOGY_READONLY` | 否 | Synology 安全策略开关；setup 默认写 `true` |
| `WIKI_DB_PATH` | 否 | SQLite 数据库路径（默认 `../index.db`） |
| `WIKI_CONFIG_PATH` | 否 | 配置文件路径（默认 `../wiki.config.json`） |
| `WIKI_PARSER_SKILLS` | 否 | 由 `wiki setup` 写入的逗号分隔 parser skill 列表，供 `wiki doctor` 校验 |
| `EMBEDDING_BASE_URL` | 否 | Embedding API endpoint |
| `EMBEDDING_API_KEY` | 否 | Embedding API key |
| `EMBEDDING_MODEL` | 否 | Embedding 模型名 |
| `EMBEDDING_DIMENSIONS` | 否 | 向量维度（默认 384） |

完整环境变量参考见 [docs/operations/env.md](../docs/operations/env.md)

## 测试

```bash
npm run test          # 编译 + 运行全部测试
npm run test:watch    # watch 模式
```

测试覆盖 4 个层级：unit (2) · integration (18) · acceptance (10) · e2e (2)

## 项目结构

```text
src/
├── commands/          # CLI 命令实现
├── core/              # 核心业务逻辑
│   ├── db.ts          # SQLite schema 初始化、动态列管理
│   ├── sync.ts        # 6 步同步编排
│   ├── indexer.ts     # 文件扫描、变更检测、UPSERT
│   ├── frontmatter.ts # YAML 解析、edge 提取、summary 生成
│   ├── embedding.ts   # OpenAI 兼容 embedding 客户端
│   ├── vault-processing.ts  # Vault 队列处理
│   ├── codex-workflow.ts    # Codex SDK runner
│   └── ...
├── types/             # TypeScript 接口定义
├── utils/             # 工具函数
└── index.ts           # CLI 入口
```

## 相关文档

- 安装指南：[README.zh-CN.md](./README.zh-CN.md)
- Skill 接口定义：[SKILL.md](./SKILL.md)
- 设计文档：[docs/design/](../docs/design/)
- 运维手册：[docs/operations/](../docs/operations/)
