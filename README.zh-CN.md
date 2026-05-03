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

如果启用自动 vault 处理，新的 setup 默认使用 `WIKI_AGENT_AUTH_MODE=codex-login`、当前用户 home 目录下的专用 Codex home 和 `WIKI_AGENT_MODEL=gpt-5.5`。启用前，macOS/Linux 执行 `CODEX_HOME="$HOME/.codex-tiangong-wiki" codex login`；Windows PowerShell 先设置 `$env:CODEX_HOME = "$env:USERPROFILE\.codex-tiangong-wiki"`，再执行 `codex login`。

```bash
tiangong-wiki find --type concept --status active     # 结构化查询
tiangong-wiki fts "贝叶斯"                             # 全文搜索
tiangong-wiki rebuild-fts --check                     # 检查 FTS 漂移 / 元数据
tiangong-wiki rebuild-fts                             # 显式重建 FTS 索引
tiangong-wiki search "优化算法的收敛条件"                # 语义搜索
tiangong-wiki graph bayes-theorem --depth 2           # 图遍历
```

`wiki.config.json` 现在支持：

```json
{
  "fts": {
    "tokenizer": "simple"
  }
}
```

现在默认就是 `simple`。只有在你想退回到基于 `Intl.Segmenter` 的旧 FTS 行为时，才需要把 `tokenizer` 显式设为 `default`。

```bash
tiangong-wiki daemon start                            # 后台启动 daemon
tiangong-wiki dashboard                               # 在浏览器中打开仪表盘
# 或者：tiangong-wiki daemon run                      # 前台运行 daemon，适合调试
```

> 环境变量通过 `.wiki.env` 管理（由 `tiangong-wiki setup` 创建）。CLI 会优先使用最近的本地 `.wiki.env`，找不到时再 fallback 到全局默认工作区配置。完整参考见 [references/troubleshooting.md](./references/troubleshooting.md)。如需部署中心化服务（Linux + `systemd` + Nginx），见 [references/centralized-service-deployment.md](./references/centralized-service-deployment.md)。该部署文档现在也包含了 Git 仓库初始化、GitHub remote 配置和 daemon 自动 push 的 Git 配置说明。

## MCP Server

Tiangong Wiki 提供了独立的 MCP 适配层，通过 HTTP 调用 daemon。它使用的是 MCP 的 Streamable HTTP 传输，不是 stdio。

启动 MCP 前，先确保 daemon 已经在监听：

```bash
tiangong-wiki daemon run
```

另开一个终端：

```bash
export WIKI_DAEMON_BASE_URL=http://127.0.0.1:8787
export WIKI_MCP_HOST=127.0.0.1
export WIKI_MCP_PORT=9400
export WIKI_MCP_PATH=/mcp

tiangong-wiki-mcp-server
```

启动后会输出一行 JSON，例如：

```json
{"status":"listening","host":"127.0.0.1","port":9400,"healthUrl":"http://127.0.0.1:9400/health","mcpUrl":"http://127.0.0.1:9400/mcp"}
```

如果你不是通过全局安装使用，而是在源码仓库里运行：

```bash
npm install
npm run build

WIKI_DAEMON_BASE_URL=http://127.0.0.1:8787 \
WIKI_MCP_PORT=9400 \
node mcp-server/dist/index.js

# 或者开发态运行
npm run dev:mcp-server
```

MCP 侧需要的环境变量：

- `WIKI_DAEMON_BASE_URL`：wiki daemon 的 base URL，例如 `http://127.0.0.1:8787`
- `WIKI_MCP_HOST`：MCP HTTP 服务绑定地址，默认 `127.0.0.1`
- `WIKI_MCP_PORT`：MCP HTTP 服务绑定端口，默认随机空闲端口
- `WIKI_MCP_PATH`：MCP 路由路径，默认 `/mcp`

Bearer token 说明：

- Bearer token 不配置在 `.wiki.env`、daemon env 或 MCP env 里
- 当前 V1 部署模型里，Bearer token 配在反向代理层
- 具体示例见 [references/examples/centralized-service/nginx-centralized-wiki.conf](./references/examples/centralized-service/nginx-centralized-wiki.conf) 中的 `map $http_authorization ...`
- 生产环境建议把 token 放在私有的 Nginx include 文件中，例如 `/etc/nginx/snippets/wiki-auth-tokens.conf`，再由主站点配置 `include` 进来，不要把真实密钥硬编码在仓库示例里

## 客户端如何使用这个 MCP

任何支持 Streamable HTTP 的 MCP client 都可以连接到这个服务：

- 本地调试地址：`http://127.0.0.1:9400/mcp`
- 健康检查：`http://127.0.0.1:9400/health`
- 生产环境建议：对外只暴露反向代理后的 `/mcp`，daemon 和 MCP 自身只监听 loopback

读工具可以直接调用。写工具，如 `wiki_page_create`、`wiki_page_update`、`wiki_sync`，额外要求这些 header：

- `x-wiki-actor-id`
- `x-wiki-actor-type`
- `x-request-id`

生产环境推荐模式是：客户端只向反向代理发送 `Authorization: Bearer ...`，由反向代理在代理层完成 token 校验，并在转发到 MCP server 前注入 actor headers。若你在本地直接连 MCP 做调试，则需要由客户端自己带上这些 header 才能调用写工具。

最小 Node.js MCP client 示例：

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:9400/mcp"), {
  requestInit: {
    headers: {
      "x-wiki-actor-id": "agent:demo",
      "x-wiki-actor-type": "agent",
      "x-request-id": "req-demo-1",
    },
  },
});

const client = new Client({ name: "demo-client", version: "1.0.0" });
await client.connect(transport);

const tools = await client.listTools();
const search = await client.callTool({
  name: "wiki_search",
  arguments: { query: "bayes", limit: 5 },
});
```

当前 MCP tools 包括：

- 查询：`wiki_find`、`wiki_fts`、`wiki_search`、`wiki_graph`
- 页面：`wiki_page_info`、`wiki_page_read`、`wiki_page_create`、`wiki_page_update`
- 类型：`wiki_type_list`、`wiki_type_show`、`wiki_type_recommend`
- Vault：`wiki_vault_list`、`wiki_vault_queue`
- 维护：`wiki_sync`、`wiki_lint`

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
