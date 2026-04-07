# Service Administration

当你在运维 `wiki-skill` 的本地服务层，而不是把它当成问答 Agent 的即时 skill 接口使用时，阅读本文档。

---

## 1. 两层模型

`wiki-skill` 包含两个清晰分离的层：

```text
Layer 1: Skill Interface
  外部 Agent 按需调用 wiki CLI
  用途：查询现有知识、决定 ontology、创建或更新页面

Layer 2: Local Service
  daemon / sync / vault queue / Codex workflow runner
  用途：保持索引新鲜、处理 vault 文件、管理重试与工件
```

边界规则：

- `SKILL.md` 只描述 Layer 1。
- daemon、queue、NAS、自动 vault-to-wiki 工作流都属于 Layer 2。
- service 负责调度与回收，不负责知识判断。
- Codex workflow 负责读文件、查当前 wiki、决定 `skip/apply/propose_only`、执行页面动作并写 `result.json`。

---

## 2. Service 职责

service 层负责：

- 引导安装用户先完成 `wiki setup` / `wiki doctor`
- 定时或手动执行 `wiki sync`
- 写入 `vault_files`、`vault_changelog`、`vault_processing_queue`
- 维护 daemon PID、state、log
- 保证 vault 文件本地可读
- 创建 workflow 工件目录
- 使用 **Codex SDK** 启动或恢复 workflow thread
- 校验并回收 `result.json`
- 记录 thread、decision、skills、页面动作、错误、重试信息

service 层不负责：

- 判断某个文件是否应该变成 `source-summary`
- 判断应该落到哪个 page type
- 解析自然语言总结
- 直接替代 Agent 的页面写作判断

---

## 3. 运行时工件

service 在 `wiki/` 下维护以下状态：

```text
wiki/
├── index.db
├── .wiki-daemon.pid
├── .wiki-daemon.log
├── .wiki-daemon.state.json
└── .queue-artifacts/
    └── <queue-item-id>/
        ├── queue-item.json
        ├── prompt.md
        ├── result.json
        └── skill-artifacts/
```

其中：

- `queue-item.json`：本次 queue item 的最小输入元数据
- `prompt.md`：给 Codex workflow 的薄 prompt
- `result.json`：唯一可信的结构化结果契约
- `skill-artifacts/`：workflow 运行时各类 skill 的中间产物目录；其中的 `wiki` launcher 会直接执行当前包的 `dist/index.js`

service 依赖的核心表：

- `sync_meta`
- `vault_files`
- `vault_changelog`
- `vault_processing_queue`

---

## 4. 后端与环境变量

### 4.1 自动处理开关

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WIKI_AGENT_ENABLED` | `false` | 是否启用自动 vault-to-wiki 处理 |
| `WIKI_AGENT_API_KEY` | 无 | Codex workflow 使用的 API Key |
| `WIKI_AGENT_MODEL` | 无 | Codex workflow 使用的模型 |
| `WIKI_AGENT_BASE_URL` | `https://api.openai.com/v1` | 可选的 Codex/OpenAI API 基地址覆盖 |
| `WIKI_AGENT_BATCH_SIZE` | `5` | 每个周期最多处理的 queue 项数 |
| `WIKI_AGENT_BACKEND` | `codex-workflow` | queue backend；当前仅支持 `codex-workflow` |
| `WIKI_AGENT_ALLOW_TEMPLATE_EVOLUTION` | `false` | 是否允许自动执行 `create_template` |
| `WIKI_AGENT_TEMPLATE_EVOLUTION_MODE` | `proposal` | `proposal` 或 `apply`；只有 `apply` 才接受模板创建动作 |

校验规则：

- `WIKI_AGENT_ENABLED=false` 时忽略缺失的 agent 凭证
- `WIKI_AGENT_ENABLED=true` 时，`WIKI_AGENT_API_KEY` 与 `WIKI_AGENT_MODEL` 必填
- 生产路径应使用 `codex-workflow`

### 4.2 为什么是 Codex SDK

本项目的正式自动处理实现使用 **Codex SDK**，而不是把 `codex exec`/CLI 当作主 runtime。

原因：

- queue item 需要稳定绑定 `threadId`
- 失败后需要 resume 同一个 workflow thread
- service 需要结构化持久化 thread/decision/result 状态
- SDK 与这些需求天然一致
- SDK 允许在代码里统一声明 `workingDirectory`、`additionalDirectories`、sandbox 与网络权限，不必把这些运行时细节散落到外部脚本里

补充说明：

- `@openai/codex-sdk` 底层仍然会调用 `codex exec`，但对 service 来说它提供的是稳定的 thread API，而不是“把 CLI 当主执行协议”。
- workflow 运行在 `workspace-write` sandbox 时，必须显式开启网络访问；否则 workflow 内部调用 `wiki type recommend`、`wiki search`、`wiki sync` 等依赖 embedding API 的命令会失败。
- workflow 的 `workingDirectory` 固定为 workspace root，让 Codex 通过标准 skill discovery 自动发现 `workspace/.agents/skills/` 下的 `wiki-skill` 与 parser skills。
- workflow `prompt.md` 只保留 queue item、`result.json`、thread 回填和模板演化 guardrail 等最小契约；具体 wiki / parser 行为由运行时发现的 skills 提供。
- service 会把 `.queue-artifacts/<queue-item-id>/skill-artifacts/` 注入 `PATH`，其中的本地 `wiki` launcher 直接指向当前包的 `dist/index.js`，不依赖用户全局安装 CLI。

CLI 在 workflow 内部仍然重要，但角色是：

- `wiki` CLI discovery 当前 ontology
- 页面同步与 lint
- 手工调试

不是 service 层的主执行器。

---

## 5. Queue 生命周期

`vault_processing_queue` 的状态：

- `pending`
- `processing`
- `done`
- `skipped`
- `error`

典型生命周期：

```text
vault file added/modified -> pending
worker claim             -> processing
workflow apply/skip      -> done | skipped
workflow failure         -> error
retry                    -> processing again
vault file removed       -> queue row removed
```

queue 还会记录：

- `threadId`
- `workflowVersion`
- `decision`
- `resultManifestPath`
- `lastErrorAt`
- `retryAfter`
- `createdPageIds`
- `updatedPageIds`
- `appliedTypeNames`
- `proposedTypeNames`
- `skillsUsed`

---

## 6. 自动 Vault Processing 流程

service 在成功完成全量 `wiki sync` 后，可继续处理 queue：

```text
1. claim pending/error queue items
2. 确保 vault 文件本地可读
3. 生成 .queue-artifacts/<queue-item-id>/
4. start 或 resume Codex thread
5. Codex 在 workspace 内执行：
   - 以 workspace root 作为工作目录，自动发现 workspace-local skills
   - 读取文件
   - 调用所需 skills
   - 用 wiki CLI discovery 当前 ontology 与已有页面
   - 判断 skip / apply / propose_only
   - 执行 create/update/template proposal
   - 写 result.json
6. service 校验 result.json
7. 回写 queue row 与日志

实现细节：

- 对真实 Codex SDK runner，service 会在同一 batch 内对一次 runtime 失败做一次自动续跑，而不是立刻把 queue item 永久落成 `error`
- 自动续跑优先复用已持久化的 `threadId`，以便让同一个 workflow thread 自我修复并补写 `result.json`
```

关键原则：

- service 只信任结构化 manifest，不信任自然语言总结
- 所有 page type 完全平等，service 不给任何 type 默认优先级
- 是否创建 `source-summary` 由 workflow 自己判断，和任何其他 type 平等

---

## 7. `result.json` 契约

`result.json` 至少需要包含：

- `status`
- `decision`
- `reason`
- `threadId`
- `skillsUsed`
- `createdPageIds`
- `updatedPageIds`
- `appliedTypeNames`
- `proposedTypes`
- `actions`
- `lint`

service 会拒绝：

- 缺少 `threadId`
- 缺少 `decision`
- `decision=apply` 但没有 `actions[]`
- `create_template` 在 guard 未开启时被直接应用

---

## 8. Daemon 命令

```bash
wiki setup
wiki doctor
wiki daemon start
wiki daemon stop
wiki daemon status
wiki daemon status --format json
```

含义：

- `setup`：首次安装时生成 `.wiki.env`、scaffold 工作区，并安装 workspace-local `wiki-skill` / 可选 parser skills
- `doctor`：在启动服务前确认路径、配置、workspace-local skills 和 agent 凭证状态
- `start`：后台启动定时 worker
- `stop`：向 daemon 发送 `SIGTERM`
- `status`：查看运行状态、上次运行时间、下次同步时间

---

## 9. Queue 检查与日志

查看 queue：

```bash
wiki vault queue
wiki vault queue --status pending
wiki vault queue --status error
```

queue JSON 应能直接看到：

- `threadId`
- `decision`
- `resultManifestPath`
- `skillsUsed`
- `createdPageIds`
- `updatedPageIds`
- `proposedTypeNames`

daemon 日志应能追踪：

- sync 成功/失败
- queue summary
- 每个文件的 `threadId`
- `decision`
- `skillsUsed`
- created/updated pages
- proposed types
- `result.json` 路径
- 失败消息

如果 queue 出错，优先看 `.wiki-daemon.log`，再决定是否手工查看数据库。

---

## 10. Sync Interval

由 `WIKI_SYNC_INTERVAL` 控制：

- 默认 `86400`
- `0` 表示不做定时调度，但仍可手动 `wiki sync`

一个 daemon cycle 可理解为：

```text
1. full wiki sync
2. 更新 vault_changelog / queue
3. 如果启用了 agent automation，则处理 queue batch
4. 更新 daemon state 与 log
```

---

## 11. NAS / Synology

### 11.1 本地挂载 NAS

```bash
export WIKI_PATH=/data/workspace/wiki/pages
export VAULT_PATH=/Volumes/team-vault/wiki-vault
export VAULT_SOURCE=local
export VAULT_HASH_MODE=mtime
export WIKI_SYNC_INTERVAL=3600
export WIKI_AGENT_ENABLED=true
export WIKI_AGENT_API_KEY=...
export WIKI_AGENT_MODEL=gpt-5.4
```

推荐 `VAULT_HASH_MODE=mtime` 的原因：

- 大文件多时更快
- 网络挂载场景下通常足够稳定

### 11.2 Synology API 模式

```bash
export WIKI_PATH=/data/workspace/wiki/pages
export VAULT_PATH=/data/workspace/vault-cache
export VAULT_SOURCE=synology
export VAULT_SYNOLOGY_REMOTE_PATH=/homes/user/wiki-vault
export VAULT_HASH_MODE=mtime
export SYNOLOGY_BASE_URL=https://nas.example.com:5001
export SYNOLOGY_USERNAME=...
export SYNOLOGY_PASSWORD=...
export WIKI_AGENT_ENABLED=true
export WIKI_AGENT_API_KEY=...
export WIKI_AGENT_MODEL=gpt-5.4
```

说明：

- `VAULT_PATH` 在 Synology 模式下是本地 cache 目录
- queue worker 必须先把远端文件拉到本地，再交给 workflow 处理
- cache 路径应尽量镜像 vault 相对路径，便于排障

---

## 12. 运维 Playbook

### 12.1 启动服务

```text
1. wiki check-config
2. wiki daemon start
3. wiki daemon status --format json
4. 如有异常，查看 wiki/.wiki-daemon.log
```

### 12.2 处理 queue error

```text
1. wiki vault queue --status error
2. 查看 threadId / resultManifestPath / errorMessage
3. 查看 daemon log 中对应文件的 decision 与技能使用情况
4. 检查 WIKI_AGENT_* 配置
5. 检查 vault 文件是否本地可读或可下载
6. 修复后等待下次周期重试，或手动再次触发 wiki sync + queue 处理
```
