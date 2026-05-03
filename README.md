# @biaoo/tiangong-wiki

[中文](./README.zh-CN.md)

> Inspired by Karpathy's [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — instead of re-deriving answers from raw documents on every query (like RAG), the LLM **builds and maintains a persistent wiki** that compounds over time.

`@biaoo/tiangong-wiki` is the infrastructure for this pattern: a CLI that turns a directory of Markdown files into a queryable knowledge base with full-text search, semantic search, knowledge graph, and an interactive dashboard.

## Features

| | |
|---|---|
| **Knowledge that compounds** | Every source and every question makes the wiki richer — compiled once, kept current |
| **Your files, your data** | Plain Markdown you own; no cloud, no database server, no lock-in |
| **Find anything** | Metadata filters, keyword search, and semantic search in one CLI |
| **See connections** | Relationships auto-extracted into a navigable knowledge graph |
| **Ingest raw materials** | Drop files into a vault; AI reads and converts them to structured pages |
| **AI-agent native** | Ships as a [Codex / Claude Code skill](./SKILL.md) for autonomous knowledge work |
| **Visual dashboard** | Browse the graph, inspect pages, and search from a web UI |

## Install

```bash
npm install -g @biaoo/tiangong-wiki
```

## Update

Upgrade the npm package itself:

```bash
npm install -g @biaoo/tiangong-wiki@latest
```

Refresh workspace-local managed skills after upgrading the CLI or when upstream skill content changes:

```bash
tiangong-wiki skill status
tiangong-wiki skill update --all
```

<details>
<summary><strong>Use as an AI Agent Skill</strong></summary>

After installing the npm package, register it with your agent:

```bash
npx skills add Biaoo/tiangong-wiki -a codex          # Codex
npx skills add Biaoo/tiangong-wiki -a claude-code    # Claude Code
npx skills add Biaoo/tiangong-wiki -a codex -g       # Global (cross-project)
```

Or let the setup wizard handle everything:

```bash
tiangong-wiki setup
```

To manage workspace-local skills from arbitrary repo/path sources after setup:

```bash
tiangong-wiki skill add ../my-skills --skill notes
tiangong-wiki skill status
tiangong-wiki skill update notes
tiangong-wiki skill update --all
```

</details>

## Quick Start

```bash
cd /path/to/your/workspace                           # run commands from the workspace root
tiangong-wiki setup                                   # interactive config wizard
tiangong-wiki doctor                                  # verify configuration
tiangong-wiki init                                    # initialize workspace
tiangong-wiki sync                                    # index Markdown pages
```

`tiangong-wiki setup` creates a workspace-local `.wiki.env` and records it as your default workspace config. Command resolution now follows this order:

1. `--env-file <path>`
2. `WIKI_ENV_FILE`
3. The nearest `.wiki.env` found by walking upward from your current directory
4. The global default workspace config written by `tiangong-wiki setup`

That means commands still work best from inside a workspace, but they can also run from outside the workspace after setup, or target a specific workspace explicitly with `--env-file`.

For automatic vault processing, new setup runs default to `WIKI_AGENT_AUTH_MODE=codex-login`, a dedicated Codex home under the current user's home directory, and `WIKI_AGENT_MODEL=gpt-5.5`. Run `CODEX_HOME="$HOME/.codex-tiangong-wiki" codex login` before enabling that mode.

```bash
tiangong-wiki find --type concept --status active     # structured query
tiangong-wiki fts "Bayesian"                          # full-text search
tiangong-wiki rebuild-fts --check                     # inspect FTS drift / metadata
tiangong-wiki rebuild-fts                             # rebuild FTS index explicitly
tiangong-wiki search "convergence conditions"         # semantic search
tiangong-wiki graph bayes-theorem --depth 2           # graph traversal
```

`wiki.config.json` now supports:

```json
{
  "fts": {
    "tokenizer": "simple"
  }
}
```

`simple` is now the default. Set `tokenizer` to `default` only if you want the legacy `Intl.Segmenter`-based FTS behavior instead of the bundled `wangfenjin/simple` SQLite extension.

```bash
tiangong-wiki daemon start                            # start the daemon in the background
tiangong-wiki dashboard                               # open dashboard in browser
# or: tiangong-wiki daemon run                        # run the daemon in the foreground for debugging
```

> Environment variables are managed via `.wiki.env` (created by `tiangong-wiki setup`). The CLI prefers the nearest local `.wiki.env`, then falls back to the global default workspace config. See [references/troubleshooting.md](./references/troubleshooting.md) for the full reference. For a centralized Linux + `systemd` + Nginx deployment, see [references/centralized-service-deployment.md](./references/centralized-service-deployment.md). That deployment guide now also includes Git repository / GitHub remote setup for daemon-side commit and optional auto-push.

## MCP Server

Tiangong Wiki ships a separate MCP adapter that talks to the daemon over HTTP. It uses the MCP Streamable HTTP transport, not stdio.

Start it after the daemon is already listening:

```bash
tiangong-wiki daemon run
```

In another shell:

```bash
export WIKI_DAEMON_BASE_URL=http://127.0.0.1:8787
export WIKI_MCP_HOST=127.0.0.1
export WIKI_MCP_PORT=9400
export WIKI_MCP_PATH=/mcp

tiangong-wiki-mcp-server
```

The server prints a JSON line like:

```json
{"status":"listening","host":"127.0.0.1","port":9400,"healthUrl":"http://127.0.0.1:9400/health","mcpUrl":"http://127.0.0.1:9400/mcp"}
```

If you are running from a source checkout instead of a global install:

```bash
npm install
npm run build

WIKI_DAEMON_BASE_URL=http://127.0.0.1:8787 \
WIKI_MCP_PORT=9400 \
node mcp-server/dist/index.js

# or during development
npm run dev:mcp-server
```

Required MCP-side environment variables:

- `WIKI_DAEMON_BASE_URL`: base URL of the wiki daemon, for example `http://127.0.0.1:8787`
- `WIKI_MCP_HOST`: bind host for the MCP HTTP server, default `127.0.0.1`
- `WIKI_MCP_PORT`: bind port for the MCP HTTP server, default random free port
- `WIKI_MCP_PATH`: MCP route path, default `/mcp`

Bearer token note:

- Bearer tokens are not configured in `.wiki.env`, daemon env, or MCP env
- In the current V1 deployment model, Bearer tokens live in the reverse proxy config
- See [references/examples/centralized-service/nginx-centralized-wiki.conf](./references/examples/centralized-service/nginx-centralized-wiki.conf) for the current `map $http_authorization ...` example
- In production, keep token values in a private Nginx include file such as `/etc/nginx/snippets/wiki-auth-tokens.conf`, then `include` it from the main site config instead of hardcoding secrets in the repo

## Using the MCP From Clients

Any MCP client that supports Streamable HTTP can connect to the MCP endpoint:

- Local debug endpoint: `http://127.0.0.1:9400/mcp`
- Health check: `http://127.0.0.1:9400/health`
- Production recommendation: expose `/mcp` behind a reverse proxy and keep daemon/MCP bound to loopback

Read tools can be called directly. Write tools such as `wiki_page_create`, `wiki_page_update`, and `wiki_sync` require these headers:

- `x-wiki-actor-id`
- `x-wiki-actor-type`
- `x-request-id`

In production, the recommended model is: the client sends `Authorization: Bearer ...` to the reverse proxy, the proxy validates the token there, and the proxy injects the actor headers before forwarding to the MCP server. For local debugging without a proxy, your client must send those headers itself when calling write tools.

Minimal Node.js MCP client example:

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

Current MCP tools include:

- Query: `wiki_find`, `wiki_fts`, `wiki_search`, `wiki_graph`
- Page: `wiki_page_info`, `wiki_page_read`, `wiki_page_create`, `wiki_page_update`
- Type: `wiki_type_list`, `wiki_type_show`, `wiki_type_recommend`
- Vault: `wiki_vault_list`, `wiki_vault_queue`
- Maintenance: `wiki_sync`, `wiki_lint`

## CLI

```
Setup         setup · skill · doctor · check-config
Indexing      init · sync
Query         find · fts · search · graph
Inspect       list · page-info · stat · lint
Create        create · template · type
Vault         vault list | diff | queue
Export        export-graph · export-index
Daemon        daemon run | start | stop | status
Dashboard     dashboard
```

See [references/cli-interface.md](./references/cli-interface.md) for the full command reference.

## Architecture

![Tiangong-Wiki: The Persistent AI Knowledge Framework](./assets/tiangong-wiki-framework.png)

**Vault → Pages** — Raw materials land in the vault. An agentic workflow reads each file, discovers the current ontology via `tiangong-wiki type list / find / fts`, and decides whether to skip, create, or update a page.

**Dual engine** — Markdown files are the source of truth. SQLite is a derived index rebuilt by `tiangong-wiki sync`, enabling queries that plain files cannot support.

**Flexible schema** — Three-tier column model (fixed, deploy-level, template-level) with automatic `ALTER TABLE` on config changes.

## Tech Stack

| | |
|---|---|
| Language | TypeScript (ESM) |
| Runtime | Node.js >= 18 |
| CLI | [Commander.js](https://github.com/tj/commander.js) |
| Database | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) + [sqlite-vec](https://github.com/asg017/sqlite-vec) |
| Dashboard | [Preact](https://preactjs.com/) + [G6](https://g6.antv.antgroup.com/) |
| Build | [Vite](https://vite.dev/) |
| Test | [Vitest](https://vitest.dev/) |

## Development

```bash
git clone https://github.com/Biaoo/tiangong-wiki.git
cd tiangong-wiki
npm install && npm run build

npm run dev -- --help        # CLI from source
npm run dev:dashboard        # dashboard dev server
npm test                     # run tests
```

## Contributing

Issues and pull requests are welcome. For major changes, please open an issue first to discuss what you would like to change.
