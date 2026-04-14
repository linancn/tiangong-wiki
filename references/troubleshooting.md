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
| `EMBEDDING_DIMENSIONS` | No | Vector dimensions (default: model-dependent) |

### Agent (Agentic Workflow)

The agent uses [Codex SDK](https://www.npmjs.com/package/@openai/codex-sdk) to process vault items. When `WIKI_AGENT_BASE_URL` is set, a custom `model_provider` is injected to override any global `~/.codex/config.toml` settings.

| Variable | Required | Description |
| --- | --- | --- |
| `WIKI_AGENT_ENABLED` | No | Enable agentic workflow (`true` / `false`, default: `false`) |
| `WIKI_AGENT_BASE_URL` | No | LLM API base URL (e.g. `https://api.openai.com/v1`). When set, overrides global Codex config |
| `WIKI_AGENT_API_KEY` | If enabled | API key for the LLM provider |
| `WIKI_AGENT_MODEL` | No | Model name (e.g. `gpt-5.4`, `Qwen/Qwen3.5-397B-A17B-GPTQ-Int4`) |
| `WIKI_AGENT_BATCH_SIZE` | No | Max concurrent vault items per batch (default: `5`) |
| `WIKI_AGENT_SANDBOX_MODE` | No | Codex sandbox mode: `danger-full-access` (default) or `workspace-write` |
| `WIKI_PARSER_SKILLS` | No | Comma-separated parser skill list (e.g. `pdf,docx,pptx,xlsx`) |

`tiangong-wiki setup` now prompts for `WIKI_AGENT_SANDBOX_MODE` when automatic vault processing is enabled. The default is `danger-full-access`, and the setup wizard highlights that this mode grants full runtime access.

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

### Codex workflow sandbox fails to initialize

If the agent workflow fails with `bwrap`, `unshare`, `uid_map`, or similar sandbox startup errors, switch `WIKI_AGENT_SANDBOX_MODE` to `danger-full-access`. Use `workspace-write` only when you explicitly want that sandbox mode and know the host supports it.

---

## LLM Provider Setup

### OpenAI (default)

```env
WIKI_AGENT_ENABLED=true
WIKI_AGENT_API_KEY=sk-...
WIKI_AGENT_MODEL=gpt-5.4
```

### vLLM (self-hosted)

Requires vLLM **v0.8.5+** for Responses API support (`/v1/responses`).

```env
WIKI_AGENT_ENABLED=true
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
