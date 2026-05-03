# Troubleshooting

Diagnosis and configuration reference for the wiki skill. Start with `tiangong-wiki doctor` for automated health checks.

---

## Quick Diagnosis

```bash
# Run the built-in diagnostic
tiangong-wiki doctor

# Check configuration validity
tiangong-wiki check-config

# Check workspace health
tiangong-wiki stat
tiangong-wiki lint
```

---

## Environment Variables

All configuration is managed through `.wiki.env` (created by `tiangong-wiki setup`). Variables can also be set in shell environment or a `.env` file.

### Core

| Variable | Required | Description |
| --- | --- | --- |
| `WIKI_PATH` | Yes | Path to the Markdown pages directory |
| `WIKI_DB_PATH` | Yes | Path to the SQLite index database |
| `WIKI_CONFIG_PATH` | Yes | Path to `wiki.config.json` |
| `WIKI_TEMPLATES_PATH` | Yes | Path to the templates directory |
| `WIKI_SYNC_INTERVAL` | No | Auto-sync interval in seconds (default: `86400`) |

### Daemon and MCP

| Variable | Required | Description |
| --- | --- | --- |
| `WIKI_DAEMON_PORT` | No | Loopback daemon port |
| `WIKI_MCP_HOST` | No | MCP bind host (recommended: `127.0.0.1`) |
| `WIKI_MCP_PORT` | No | MCP bind port |
| `WIKI_MCP_PATH` | No | MCP HTTP path (default: `/mcp`) |
| `WIKI_DAEMON_BASE_URL` | For MCP service | Daemon base URL used by the MCP adapter |
| `WIKI_GIT_AUTO_PUSH` | No | Enable daemon-side async Git push batching |
| `WIKI_GIT_PUSH_REMOTE` | No | Git remote name for async push (default: `origin`) |
| `WIKI_GIT_PUSH_DELAY_MS` | No | Delay before async push (default: `3000`) |

For the full single-host deployment baseline, see [centralized-service-deployment.md](./centralized-service-deployment.md).

### Vault

| Variable | Required | Description |
| --- | --- | --- |
| `VAULT_PATH` | Yes | Path to the local vault directory |
| `VAULT_SOURCE` | Yes | Vault source type (`local` or `synology`) |
| `VAULT_HASH_MODE` | No | Hash mode for change detection (`content` or `mtime`, default: `mtime`) |
| `VAULT_SYNOLOGY_REMOTE_PATH` | If `synology` | Remote path on Synology NAS |

### Synology (when `VAULT_SOURCE=synology`)

| Variable | Required | Description |
| --- | --- | --- |
| `SYNOLOGY_BASE_URL` | Yes | Synology DSM base URL |
| `SYNOLOGY_USERNAME` | Yes | DSM username |
| `SYNOLOGY_PASSWORD` | Yes | DSM password |
| `SYNOLOGY_VERIFY_SSL` | No | Verify SSL certificates (default: `true`) |
| `SYNOLOGY_READONLY` | No | Read-only mode (default: `false`) |

### Embedding

| Variable | Required | Description |
| --- | --- | --- |
| `EMBEDDING_BASE_URL` | Yes | Embedding API base URL |
| `EMBEDDING_API_KEY` | Yes | Embedding API key |
| `EMBEDDING_MODEL` | Yes | Embedding model name |
| `EMBEDDING_DIMENSIONS` | No | Vector dimensions (default: `1536`, matching the default OpenAI `text-embedding-3-small`; set explicitly only when using a different dimension profile) |

### Agent (Agentic Workflow)

The agent uses [Codex SDK](https://www.npmjs.com/package/@openai/codex-sdk) to process vault items. It supports API-key auth and local Codex login auth. In `api-key` mode, when `WIKI_AGENT_BASE_URL` is set, a custom `model_provider` is injected to override any global `~/.codex/config.toml` settings. In `codex-login` mode, the workflow uses `WIKI_AGENT_CODEX_HOME` as `CODEX_HOME` and does not pass API key environment variables to Codex.

| Variable | Required | Description |
| --- | --- | --- |
| `WIKI_AGENT_ENABLED` | No | Enable agentic workflow (`true` / `false`, default: `false`) |
| `WIKI_AGENT_AUTH_MODE` | No | Auth mode: `api-key` or `codex-login`. Runtime default is `api-key` for backwards compatibility; `tiangong-wiki setup` defaults new agent configs to `codex-login` |
| `WIKI_AGENT_CODEX_HOME` | No | Codex home directory. Leave unset to use the current user's standard `${HOME}/.codex` (or the user profile `.codex` directory on Windows); if set in `.wiki.env`, use a real absolute path because shell variables are not expanded there |
| `WIKI_AGENT_BASE_URL` | No | LLM API base URL for `api-key` mode (e.g. `https://api.openai.com/v1`). When set, overrides global Codex config |
| `WIKI_AGENT_API_KEY` | In `api-key` mode | API key for the LLM provider |
| `WIKI_AGENT_MODEL` | No | Model name (default: `gpt-5.5`; e.g. `Qwen/Qwen3.5-397B-A17B-GPTQ-Int4`) |
| `WIKI_AGENT_BATCH_SIZE` | No | Max concurrent vault queue workers per cycle (default: `5`) |
| `WIKI_AGENT_SANDBOX_MODE` | No | Codex sandbox mode: `danger-full-access` (default) or `workspace-write` |
| `WIKI_PARSER_SKILLS` | No | Comma-separated parser skill list (e.g. `pdf,docx,pptx,xlsx`) |

`tiangong-wiki setup` now prompts for `WIKI_AGENT_SANDBOX_MODE` when automatic vault processing is enabled. The default is `danger-full-access`, and the setup wizard highlights that this mode grants full runtime access.

When `WIKI_AGENT_ENABLED=true` and `WIKI_AGENT_AUTH_MODE=codex-login`, `tiangong-wiki doctor` and `tiangong-wiki check-config` verify that `WIKI_AGENT_CODEX_HOME` exists and contains `auth.json`. They report the path and remediation command, but never print token or auth file contents.

Queue items that fail workflow execution are auto-retried up to 3 times. After that they remain in `error` until you manually retry them from the dashboard / queue tooling, or a later vault sync requeues the file because the source changed.

---

## Common Issues

### "WIKI_PATH is not set" or config errors

Run `tiangong-wiki setup` to create `.wiki.env` with all required paths. Verify with `tiangong-wiki check-config`.

### Semantic search returns no results

`tiangong-wiki search` and `tiangong-wiki type recommend` (with embeddings) require `EMBEDDING_*` variables. If not configured, use `tiangong-wiki fts` (full-text search) or `tiangong-wiki find` (metadata filter) instead.

### Index out of sync

Run `tiangong-wiki sync` to rebuild. For a single page: `tiangong-wiki sync --path <page-id>`.

### Lint errors after page edits

Always run `tiangong-wiki lint --path <page-id> --format json` after mutations. Common lint issues:
- Missing required frontmatter fields for the page type
- Broken `sourceRefs` pointing to non-existent pages
- Orphan pages with no graph connections

### Parser skills not found

Parser skills must be installed under `<workspace-root>/.agents/skills/`. Run `tiangong-wiki skill` to inspect installed skills. Use `tiangong-wiki skill update --all` to update.

### Windows opens "choose an app" instead of running tiangong-wiki

In Windows native shells, invoke the npm command shim with the `.cmd` suffix:

```powershell
tiangong-wiki.cmd daemon status
tiangong-wiki.cmd sync
tiangong-wiki.cmd lint --format json
```

Avoid bare `tiangong-wiki` in PowerShell, Command Prompt, daemon scripts, and Codex worker automation. npm installs a suffixless shebang script for POSIX-like environments, but Windows native shells do not execute it the same way as macOS, Linux, WSL, or Git Bash.

Vault workflow artifacts also include a workspace-local `tiangong-wiki.cmd` launcher. If a Windows agent opens a new command window or an app chooser while processing vault items, verify that it is calling `tiangong-wiki.cmd`, not the suffixless `tiangong-wiki` wrapper.

### Codex workflow sandbox fails to initialize

If the agent workflow fails with `bwrap`, `unshare`, `uid_map`, or similar sandbox startup errors, switch `WIKI_AGENT_SANDBOX_MODE` to `danger-full-access`. Use `workspace-write` only when you explicitly want that sandbox mode and know the host supports it.

---

## LLM Provider Setup

### Codex login (recommended local setup)

By default, use the current user's standard Codex home:

macOS/Linux:

```bash
codex login
codex login status
```

Windows PowerShell:

```powershell
codex login
codex login status
```

For an isolated Codex home, set `WIKI_AGENT_CODEX_HOME` to an absolute path and log in there first:

macOS/Linux:

```bash
mkdir -p "$HOME/.codex-tiangong-wiki"
CODEX_HOME="$HOME/.codex-tiangong-wiki" codex login
CODEX_HOME="$HOME/.codex-tiangong-wiki" codex login status
```

Windows PowerShell:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.codex-tiangong-wiki" | Out-Null
$env:CODEX_HOME = "$env:USERPROFILE\.codex-tiangong-wiki"
codex login
codex login status
```

Then configure the wiki agent:

```env
WIKI_AGENT_ENABLED=true
WIKI_AGENT_AUTH_MODE=codex-login
# Optional. Leave unset to use the current user's standard ~/.codex.
# WIKI_AGENT_CODEX_HOME=/absolute/path/to/.codex-tiangong-wiki
WIKI_AGENT_MODEL=gpt-5.5
```

### OpenAI API key

```env
WIKI_AGENT_ENABLED=true
WIKI_AGENT_AUTH_MODE=api-key
WIKI_AGENT_API_KEY=sk-...
WIKI_AGENT_MODEL=gpt-5.5
```

### vLLM (self-hosted)

Requires vLLM **v0.8.5+** for Responses API support (`/v1/responses`).

```env
WIKI_AGENT_ENABLED=true
WIKI_AGENT_AUTH_MODE=api-key
WIKI_AGENT_BASE_URL=http://<host>:<port>/v1
WIKI_AGENT_API_KEY=<your-token>
WIKI_AGENT_MODEL=Qwen/Qwen3.5-397B-A17B-GPTQ-Int4
```

#### Chat template: `developer` role support

The Codex CLI sends `developer`-role messages. Most model chat templates only recognize `system`, `user`, `assistant`, and `tool` — they will reject `developer` with `400 Bad Request: "Unexpected message role."`.

**Fix:** Use a modified chat template that maps `developer` → `system`. A ready-to-use template for Qwen3.5 is at `assets/vllm/qwen3_5_openai_developer.jinja`.

```bash
vllm serve <model> \
  --chat-template /path/to/qwen3_5_openai_developer.jinja \
  --port 7730
```

For other model families, apply the same pattern: extend `message.role == "system"` checks to also match `"developer"`.

#### Verifying vLLM compatibility

```bash
curl -s http://<host>:<port>/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "model": "<model-name>",
    "input": "Say hello.",
    "reasoning": {"effort": "low"}
  }' | head -c 500
```
