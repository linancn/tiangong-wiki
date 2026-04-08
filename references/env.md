# Environment Variables

All configuration is managed through `.wiki.env` (created by `wiki setup`). Variables can also be set in shell environment or a `.env` file.

---

## Core

| Variable | Required | Description |
| --- | --- | --- |
| `WIKI_PATH` | Yes | Path to the Markdown pages directory |
| `WIKI_DB_PATH` | Yes | Path to the SQLite index database |
| `WIKI_CONFIG_PATH` | Yes | Path to `wiki.config.json` |
| `WIKI_TEMPLATES_PATH` | Yes | Path to the templates directory |
| `WIKI_SYNC_INTERVAL` | No | Auto-sync interval in seconds (default: `86400`) |

## Vault

| Variable | Required | Description |
| --- | --- | --- |
| `VAULT_PATH` | Yes | Path to the local vault directory |
| `VAULT_SOURCE` | Yes | Vault source type (`local` or `synology`) |
| `VAULT_HASH_MODE` | No | Hash mode for change detection (`content` or `mtime`, default: `mtime`) |
| `VAULT_SYNOLOGY_REMOTE_PATH` | If `synology` | Remote path on Synology NAS |

## Synology (when `VAULT_SOURCE=synology`)

| Variable | Required | Description |
| --- | --- | --- |
| `SYNOLOGY_BASE_URL` | Yes | Synology DSM base URL |
| `SYNOLOGY_USERNAME` | Yes | DSM username |
| `SYNOLOGY_PASSWORD` | Yes | DSM password |
| `SYNOLOGY_VERIFY_SSL` | No | Verify SSL certificates (default: `true`) |
| `SYNOLOGY_READONLY` | No | Read-only mode (default: `false`) |

## Embedding

| Variable | Required | Description |
| --- | --- | --- |
| `EMBEDDING_BASE_URL` | Yes | Embedding API base URL |
| `EMBEDDING_API_KEY` | Yes | Embedding API key |
| `EMBEDDING_MODEL` | Yes | Embedding model name |
| `EMBEDDING_DIMENSIONS` | No | Vector dimensions (default: model-dependent) |

## Agent (Agentic Workflow)

The agent uses [Codex SDK](https://www.npmjs.com/package/@openai/codex-sdk) to process vault items. When `WIKI_AGENT_BASE_URL` is set, a custom `model_provider` is injected to override any global `~/.codex/config.toml` settings, ensuring requests go to the correct endpoint.

| Variable | Required | Description |
| --- | --- | --- |
| `WIKI_AGENT_ENABLED` | No | Enable agentic workflow (`true` / `false`, default: `false`) |
| `WIKI_AGENT_BASE_URL` | No | LLM API base URL (e.g. `https://api.openai.com/v1`). When set, overrides global Codex config |
| `WIKI_AGENT_API_KEY` | If enabled | API key for the LLM provider |
| `WIKI_AGENT_MODEL` | No | Model name (e.g. `gpt-5.4`, `Qwen/Qwen3.5-397B-A17B-GPTQ-Int4`) |
| `WIKI_AGENT_BATCH_SIZE` | No | Max concurrent vault items per batch (default: `5`) |
| `WIKI_PARSER_SKILLS` | No | Comma-separated parser skill list (e.g. `pdf,docx,pptx,xlsx`) |

### OpenAI (default)

No special setup required. Set `WIKI_AGENT_BASE_URL` to `https://api.openai.com/v1` (or leave empty) and provide your API key.

```env
WIKI_AGENT_ENABLED=true
WIKI_AGENT_API_KEY=sk-...
WIKI_AGENT_MODEL=gpt-5.4
```

### vLLM

vLLM can serve as a self-hosted LLM provider via its OpenAI-compatible API. Wiki's agentic workflow communicates through the [Responses API](https://platform.openai.com/docs/api-reference/responses) (`/v1/responses`), which requires vLLM **v0.8.5+**.

```env
WIKI_AGENT_ENABLED=true
WIKI_AGENT_BASE_URL=http://<host>:<port>/v1
WIKI_AGENT_API_KEY=<your-token>
WIKI_AGENT_MODEL=Qwen/Qwen3.5-397B-A17B-GPTQ-Int4
```

#### Chat template: `developer` role support

The Codex CLI sends `developer`-role messages (the OpenAI equivalent of `system` that can appear mid-conversation). Most model chat templates only recognize `system`, `user`, `assistant`, and `tool` — they will reject `developer` with:

```
400 Bad Request: "Unexpected message role."
```

**Fix:** Use a modified chat template that maps `developer` → `system`. A ready-to-use template for Qwen3.5 is included at:

```
assets/vllm/qwen3_5_openai_developer.jinja
```

Launch vLLM with the custom template:

```bash
vllm serve <model> \
  --chat-template /path/to/qwen3_5_openai_developer.jinja \
  --port 7730
```

The template is derived from the official Qwen3.5 template with a single semantic change: `developer` messages are treated as `system` messages. Key modifications:

1. **Instruction prefix detection** — counts both `system` and `developer` at the start of the conversation (line 56)
2. **Role normalization** — `developer` → `system` throughout the conversation loop (lines 111, 160, 166)

> For other model families (LLaMA, Mistral, etc.), apply the same pattern: find `message.role == "system"` checks in the template and extend them to also match `"developer"`.

#### Verifying vLLM compatibility

```bash
# Test the /v1/responses endpoint directly
curl -s http://<host>:<port>/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "model": "<model-name>",
    "input": "Say hello.",
    "reasoning": {"effort": "low"}
  }' | head -c 500
```

A successful response returns a JSON object with `output` containing the model's reply.
