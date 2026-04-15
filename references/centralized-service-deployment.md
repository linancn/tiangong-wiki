# Centralized Service Deployment

Single-host deployment guide for running Tiangong Wiki as a centralized service with:

- a local daemon (`tiangong-wiki daemon run`)
- a local MCP adapter (`mcp-server/dist/index.js`)
- an Nginx reverse proxy handling TLS, static Bearer tokens, and trusted actor headers

This guide is the V1 baseline for issue `#040`. It assumes Linux + `systemd` and intentionally does not cover HA, load balancing, or cloud-vendor-specific templates.

---

## Topology

```text
Remote MCP client
  -> HTTPS /mcp (Nginx)
  -> local MCP service (127.0.0.1:9400)
  -> local daemon (127.0.0.1:8787)
  -> pages/ + index.db + templates/ + audit.ndjson + local Git repo
```

Rules for V1:

- Do not expose the daemon directly to the public internet.
- Only the reverse proxy should terminate TLS and validate Bearer tokens.
- The proxy must overwrite actor headers before traffic reaches MCP.
- MCP stays a thin adapter and must not write files directly.

---

## Directory Layout

Recommended server layout:

```text
/srv/tiangong-wiki/
├── current/                       # checked-out tiangong-wiki repo + built artifacts
├── workspace/
│   ├── pages/
│   ├── templates/
│   ├── wiki.config.json
│   ├── index.db
│   └── .queue-artifacts/
├── vault/
└── .wiki-runtime/
    └── audit.ndjson

/etc/tiangong-wiki/
└── centralized.env

/etc/systemd/system/
├── tiangong-wiki-daemon.service
└── tiangong-wiki-mcp.service
```

Recommended ownership:

- application repo: `root:root`
- runtime workspace and vault: `tiangong-wiki:tiangong-wiki`
- `systemd` services run as `tiangong-wiki`

---

## Build and Bootstrap

```bash
git clone <repo-url> /srv/tiangong-wiki/current
cd /srv/tiangong-wiki/current
npm ci
npm run build
```

Initialize the workspace once:

```bash
mkdir -p /srv/tiangong-wiki/workspace/pages
mkdir -p /srv/tiangong-wiki/workspace/templates
mkdir -p /srv/tiangong-wiki/vault

cat >/etc/tiangong-wiki/centralized.env <<'EOF'
WIKI_PATH=/srv/tiangong-wiki/workspace/pages
WIKI_DB_PATH=/srv/tiangong-wiki/workspace/index.db
WIKI_CONFIG_PATH=/srv/tiangong-wiki/workspace/wiki.config.json
WIKI_TEMPLATES_PATH=/srv/tiangong-wiki/workspace/templates
VAULT_PATH=/srv/tiangong-wiki/vault

WIKI_SYNC_INTERVAL=300
WIKI_DAEMON_PORT=8787

WIKI_MCP_HOST=127.0.0.1
WIKI_MCP_PORT=9400
WIKI_MCP_PATH=/mcp
WIKI_DAEMON_BASE_URL=http://127.0.0.1:8787

WIKI_GIT_AUTO_PUSH=true
WIKI_GIT_PUSH_REMOTE=origin
WIKI_GIT_PUSH_DELAY_MS=3000
EOF

cd /srv/tiangong-wiki/current
env $(grep -v '^#' /etc/tiangong-wiki/centralized.env | xargs) node dist/index.js init
```

An example env file is also provided at [references/examples/centralized-service/centralized.env.example](./examples/centralized-service/centralized.env.example).

Important:

- Bearer tokens are not part of `centralized.env`
- Bearer token validation belongs to Nginx, not the daemon or MCP process
- Keep real tokens in a private Nginx include file such as `/etc/nginx/snippets/wiki-auth-tokens.conf`

---

## Required Environment Variables

### Core runtime

- `WIKI_PATH`
- `WIKI_DB_PATH`
- `WIKI_CONFIG_PATH`
- `WIKI_TEMPLATES_PATH`
- `VAULT_PATH`
- `WIKI_SYNC_INTERVAL`

### Daemon

- `WIKI_DAEMON_PORT`

Notes:

- the daemon bind host is currently fixed to `127.0.0.1`
- the daemon should stay loopback-only in production

### MCP adapter

- `WIKI_MCP_HOST`
- `WIKI_MCP_PORT`
- `WIKI_MCP_PATH`
- `WIKI_DAEMON_BASE_URL`

Recommended values:

- `WIKI_MCP_HOST=127.0.0.1`
- `WIKI_MCP_PORT=9400`
- `WIKI_MCP_PATH=/mcp`
- `WIKI_DAEMON_BASE_URL=http://127.0.0.1:8787`

### Optional Git push batching

- `WIKI_GIT_AUTO_PUSH=true|false`
- `WIKI_GIT_PUSH_REMOTE`
- `WIKI_GIT_PUSH_DELAY_MS`

V1 decision:

- local Git commit is part of the write transaction
- async push batching stays inside the daemon process
- external cron is not required for the primary path

---

## `systemd` Units

Example unit files are provided under [references/examples/centralized-service/](./examples/centralized-service/).

Install them:

```bash
cp /srv/tiangong-wiki/current/references/examples/centralized-service/tiangong-wiki-daemon.service /etc/systemd/system/
cp /srv/tiangong-wiki/current/references/examples/centralized-service/tiangong-wiki-mcp.service /etc/systemd/system/

systemctl daemon-reload
systemctl enable --now tiangong-wiki-daemon
systemctl enable --now tiangong-wiki-mcp
```

Startup order:

1. Build the repo (`npm ci && npm run build`)
2. Initialize the workspace (`node dist/index.js init`)
3. Start `tiangong-wiki-daemon`
4. Verify daemon health
5. Start `tiangong-wiki-mcp`
6. Verify MCP health
7. Reload Nginx

---

## Nginx Reverse Proxy

V1 authentication model:

- Nginx validates a static Bearer token
- Nginx maps token -> actor identity
- Nginx injects:
  - `X-Wiki-Actor-Id`
  - `X-Wiki-Actor-Type`
  - `X-Request-Id`
- MCP forwards these headers to the daemon on write requests

Important:

- never trust client-supplied actor headers directly
- always overwrite actor headers in the proxy
- clear `Authorization` before passing traffic upstream

Example config: [references/examples/centralized-service/nginx-centralized-wiki.conf](./examples/centralized-service/nginx-centralized-wiki.conf)

Recommended token placement:

1. Create a private include file, for example `/etc/nginx/snippets/wiki-auth-tokens.conf`
2. Move the `map $http_authorization ...` blocks into that file
3. `include` that file from your main Nginx config inside the `http {}` scope
4. Keep only placeholder tokens in repo-tracked example configs

This keeps static Bearer tokens out of the service env file and out of the checked-in site config.

Recommended exposure model:

- public: `/mcp` and `/mcp/health`
- private/admin only: daemon health and daemon HTTP routes

Because MCP uses streamable HTTP/SSE, keep:

- `proxy_http_version 1.1`
- `proxy_buffering off`
- generous read/send timeouts

---

## Health Checks

### Local daemon

```bash
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/status
curl http://127.0.0.1:8787/write-queue/summary
```

### Local MCP

```bash
curl http://127.0.0.1:9400/health
```

### Through Nginx

```bash
curl -H "Authorization: Bearer <token>" https://wiki.example.com/mcp/health
```

### `systemd`

```bash
systemctl status tiangong-wiki-daemon
systemctl status tiangong-wiki-mcp

journalctl -u tiangong-wiki-daemon -f
journalctl -u tiangong-wiki-mcp -f
```

---

## Runtime Contracts You Must Expect

These behaviors are intentional and should be documented to operators and MCP clients.

### Revision conflicts

- daemon returns HTTP `409`
- MCP returns a structured tool error with `code=revision_conflict`
- callers must re-read the page and retry intentionally

### Queue full

- daemon returns HTTP `503`
- cause: write queue depth exceeded the configured limit
- operators should inspect `/write-queue/summary`

### Degraded Git commit failure

- the write may already be applied locally
- daemon returns a degraded error with `code=git_commit_failed`
- inspect `audit.ndjson`, local Git state, and journal output before retrying

### Sync failure

- daemon does not commit to Git when sync fails
- audit log records `sync_failed`

### Audit and journal locations

- audit log: `/srv/tiangong-wiki/.wiki-runtime/audit.ndjson` in the recommended layout
- Git journal: local repo commit history in `/srv/tiangong-wiki/workspace` or your chosen wiki root repo

---

## Backup and Push Strategy

V1 baseline:

- every successful write attempts a local Git commit
- optional async push is handled by the daemon when `WIKI_GIT_AUTO_PUSH=true`
- async push failure does not roll back the successful local write

Recommended operator practice:

- keep the workspace as a real Git repository with a configured `origin`
- snapshot both the workspace and `/etc/tiangong-wiki/centralized.env`
- monitor daemon logs for `git push failed`

Manual recovery after push failure:

```bash
cd /srv/tiangong-wiki/workspace
git status
git log --oneline -n 5
git push origin HEAD
```

---

## Recovery Playbook

### Daemon is down

```bash
systemctl restart tiangong-wiki-daemon
curl http://127.0.0.1:8787/health
```

If it still fails:

- inspect `journalctl -u tiangong-wiki-daemon -n 200`
- verify `index.db`, `wiki.config.json`, and Git repo status

### MCP is down but daemon is healthy

```bash
systemctl restart tiangong-wiki-mcp
curl http://127.0.0.1:9400/health
```

Check:

- `WIKI_DAEMON_BASE_URL`
- `WIKI_MCP_PORT`
- Nginx upstream target

### Queue remains full

Check:

```bash
curl http://127.0.0.1:8787/write-queue/summary | jq
```

Look for:

- a long-running active job
- repeated failing jobs
- vault queue pressure caused by large `sync --process` workloads

### Revision conflict reported by clients

This is expected behavior, not an outage.

Action:

1. re-read the page
2. merge user intent with the latest revision
3. retry with the new `ifRevision`

### Degraded Git commit failure

Check:

```bash
journalctl -u tiangong-wiki-daemon -n 200
tail -n 50 /srv/tiangong-wiki/.wiki-runtime/audit.ndjson
cd /srv/tiangong-wiki/workspace && git status
```

Typical causes:

- workspace is not a Git repo
- Git identity or hooks are broken
- permissions do not allow commit creation

### Actor metadata missing

If MCP returns `missing_actor`:

- verify Nginx is overwriting the three actor headers
- verify the client is calling the proxied `/mcp` endpoint, not the loopback service directly

---

## What V1 Does Not Cover

- multi-host deployments
- active/active daemon replicas
- cloud-specific Terraform or Helm modules
- alternate reverse proxy examples beyond Nginx

If those are needed later, treat them as follow-up work after the single-host contract is stable.
