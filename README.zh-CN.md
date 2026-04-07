# Wiki Skill 给 AI 安装与使用指南（中文）

这份 README 是写给“人”的，不是写给 skill 自己的。

你需要先分清 3 件事：

1. `README.zh-CN.md` 是给你看的，告诉你怎么把 `wiki-skill` 装给 AI。
2. `SKILL.md` 是给 AI 看的，决定 AI 在什么场景下会触发这个 skill。
3. `agents/openai.yaml` 是给 Codex UI 用的，影响技能卡片和默认提示词展示。

所以，这份文档重点回答的是下面 4 个问题：

1. 我应该把 `wiki-skill` 装到哪里，AI 才能看见它？
2. `npm install`、`npm run build`、`node dist/index.js init` 到底应该在哪个目录运行？
3. `init`、`sync`、`create` 真正修改的是哪个目录？
4. 我在对话里应该怎么要求 AI 使用这个 skill？

如果你只想先跑通一遍，直接看下面的 **“8. 一套可以直接照抄的完整流程”**。

## 1. 先分清三种目录

这是最关键的前提。`wiki-skill` 至少会涉及 3 套路径，混淆它们就一定会用错。

### A. Skill 源码目录

这是你克隆下来的仓库里的源码目录，例如：

```text
/Users/biao/Code/tiangong-ai-skills/wiki-skill
```

这里存放的是：

- `src/` TypeScript 源码
- `dist/` 编译后的 CLI
- `package.json`
- `SKILL.md`
- `agents/openai.yaml`
- `assets/` 默认模板和默认配置

这个目录主要用于：

- 开发或修改 `wiki-skill`
- 查看或编辑 `SKILL.md`
- 本地调试 CLI

### B. AI 已安装的 skill 目录

这是 Codex 实际会去读取 skill 的目录。对 Codex 来说，通常是：

```text
$CODEX_HOME/skills/wiki-skill
```

如果没有自定义 `CODEX_HOME`，它通常就是：

```text
~/.codex/skills/wiki-skill
```

这个目录的作用是：

- 让 Codex 发现 `wiki-skill`
- 让 Codex 读取 `SKILL.md`
- 让 Codex 在需要时运行这个 skill 自带的 CLI

非常重要：

- 如果你用的是 **symlink 安装**，那么 B 会指向 A，二者本质上是同一份文件。
- 如果你用的是 **copy 安装**，那么 A 和 B 是两套独立文件。你改了源码目录 A，不会自动影响 AI 正在使用的安装目录 B。

### C. 实际 wiki 工作区目录

这是你真正的知识库数据目录。例如：

```text
/Users/biao/Desktop/my-knowledge-workspace
```

它通常长这样：

```text
/Users/biao/Desktop/my-knowledge-workspace/
├── wiki/
│   ├── pages/
│   ├── templates/
│   ├── wiki.config.json
│   └── index.db
└── vault/
```

这个目录才是 `init`、`sync`、`create` 真正操作的目标。

它不是 skill 安装目录。

它不是 skill 源码目录。

它通过环境变量定位，最关键的是：

```bash
export WIKI_PATH=/Users/biao/Desktop/my-knowledge-workspace/wiki/pages
```

## 2. AI 到底是怎么“装上”这个 skill 的

你可以用两种方式把 `wiki-skill` 装给 Codex。

### 2.1 方法一：用 `skills` CLI 安装

这是面向普通使用者的方式。

先安装 CLI：

```bash
npm i -g skills
```

#### 2.1.1 全局安装给 Codex

如果你希望任何工作区里的 Codex 都能看到这个 skill，用全局安装。

这条命令可以在 **任意目录** 执行，因为它不依赖当前项目路径：

```bash
npx skills add https://github.com/tiangong-ai/skills --skill wiki-skill -a codex -g
```

执行完成后，用下面命令确认是否装上：

```bash
npx skills list
```

#### 2.1.2 项目级安装给 Codex

如果你只想让某一个项目里的 Codex 使用这个 skill，就做项目级安装。

这里当前目录非常重要：

- 你必须先 `cd` 到“AI 将来要工作的那个项目根目录”
- 然后再执行安装命令

例如：

```bash
cd /Users/biao/Code/my-ai-project
npx skills add https://github.com/tiangong-ai/skills --skill wiki-skill -a codex
```

为什么这里必须先 `cd`？

因为项目级安装会把 skill 安装到“当前项目”的 agent 技能目录里。也就是说：

- 当前目录如果错了
- skill 就会被装进错误的项目里
- 之后你在真正的目标项目里开 Codex，它就看不到这个 skill

如果你不想让“安装位置”依赖当前目录，优先用全局安装，或者直接用下面的手工 symlink 安装。

### 2.2 方法二：手工 symlink 安装

这是最适合本地开发和精确控路径的方式。

它的优点是：

- 安装路径完全确定
- 你知道 Codex 实际读取的是哪一份文件
- 你改源码后，Codex 看到的也是同一份目录

#### 2.2.1 先确定源码目录

假设你的源码目录是：

```text
/Users/biao/Code/tiangong-ai-skills/wiki-skill
```

先设置变量：

```bash
export WIKI_SKILL_SRC=/Users/biao/Code/tiangong-ai-skills/wiki-skill
export CODEX_HOME=${CODEX_HOME:-$HOME/.codex}
```

#### 2.2.2 创建 symlink

这几条命令可以在 **任意目录** 执行，因为全部使用了绝对路径：

```bash
mkdir -p "$CODEX_HOME/skills"
ln -sfn "$WIKI_SKILL_SRC" "$CODEX_HOME/skills/wiki-skill"
```

#### 2.2.3 验证安装结果

```bash
ls -la "$CODEX_HOME/skills/wiki-skill"
```

如果输出中能看到：

```text
wiki-skill -> /Users/biao/Code/tiangong-ai-skills/wiki-skill
```

就说明 Codex 看到的 skill 目录，已经明确指向你的源码目录。

### 2.3 什么时候应该用哪一种

- 如果你只是想“装上就用”，优先用 `skills` CLI。
- 如果你还会继续改这个 skill，优先用手工 `symlink`。
- 如果你最在意“命令究竟落在哪个目录”，优先用手工 `symlink`，因为路径最透明。

## 3. 装好以后，哪些命令应该在哪个目录运行

这是第二个最容易混淆的点。

### 3.1 原则

下面这些命令，应该在 **AI 已安装的 skill 目录** 下运行：

```bash
npm install
npm run build
node dist/index.js --help
node dist/index.js check-config
node dist/index.js init
node dist/index.js sync
```

也就是应该在这里运行：

```text
$CODEX_HOME/skills/wiki-skill
```

而不是在你的 wiki 工作区目录里运行。

### 3.2 为什么是安装目录，而不是工作区目录

因为这些命令用到的是：

- `package.json`
- `node_modules/`
- `dist/index.js`

这些文件都在 skill 安装目录里，不在你的 wiki 工作区里。

### 3.3 `init` 虽然在 skill 目录运行，但它操作的不是 skill 目录

这是最关键的一句：

```bash
cd $CODEX_HOME/skills/wiki-skill
node dist/index.js init
```

这条命令的“执行位置”是 skill 安装目录。

但它真正初始化的，是下面这些环境变量所指向的位置：

- `WIKI_PATH`
- `VAULT_PATH`
- `WIKI_DB_PATH`
- `WIKI_CONFIG_PATH`
- `WIKI_TEMPLATES_PATH`

也就是说：

- 当前 shell 所在目录，只决定 `dist/index.js` 能不能找到
- 真正被写入的业务目录，是环境变量决定的

### 3.4 如果你是 symlink 安装

如果你用的是：

```bash
ln -sfn /Users/biao/Code/tiangong-ai-skills/wiki-skill ~/.codex/skills/wiki-skill
```

那么下面两个 `cd` 从文件内容上说是同一份目录：

```bash
cd /Users/biao/Code/tiangong-ai-skills/wiki-skill
```

和：

```bash
cd ~/.codex/skills/wiki-skill
```

为了避免思维混乱，仍然建议你以后统一使用：

```bash
cd ~/.codex/skills/wiki-skill
```

因为这代表的是“AI 实际使用的安装目录”。

## 4. 给 AI 准备真正的 wiki 工作区

下面这部分不是“给 skill 准备目录”，而是“给 skill 将来要操作的数据目录做准备”。

### 4.1 创建工作区

先选一个你真正想存放知识库数据的位置，例如：

```bash
export WORKSPACE_DIR=/Users/biao/Desktop/my-knowledge-workspace
mkdir -p "$WORKSPACE_DIR/wiki/pages"
mkdir -p "$WORKSPACE_DIR/vault"
```

### 4.2 设置环境变量

至少要设置：

```bash
export WIKI_PATH="$WORKSPACE_DIR/wiki/pages"
```

推荐完整设置为：

```bash
export WIKI_PATH="$WORKSPACE_DIR/wiki/pages"
export VAULT_PATH="$WORKSPACE_DIR/vault"
export WIKI_DB_PATH="$WORKSPACE_DIR/wiki/index.db"
export WIKI_CONFIG_PATH="$WORKSPACE_DIR/wiki/wiki.config.json"
export WIKI_TEMPLATES_PATH="$WORKSPACE_DIR/wiki/templates"
export WIKI_SYNC_INTERVAL=86400
```

### 4.3 这些环境变量必须让 AI 进程本身看得见

这里要特别小心。

`wiki-skill` 读取的是 `process.env`。也就是说：

- 它读取的是进程环境变量
- 它不会自动帮你解析一个普通的 `.env` 文件

因此，下面这种做法通常 **不够**：

```text
只是把变量写进某个 .env 文件，但没有 export，也没有让 Codex 进程重新读取
```

最稳妥的做法是二选一：

#### 做法 A：先在启动 Codex 的 shell 里 `export`

```bash
export WIKI_PATH=/Users/biao/Desktop/my-knowledge-workspace/wiki/pages
export VAULT_PATH=/Users/biao/Desktop/my-knowledge-workspace/vault
...
```

然后从这个 shell 启动 Codex。

#### 做法 B：写进你的 shell 配置文件，再重启 Codex

例如写到 `~/.zshrc`，然后：

```bash
source ~/.zshrc
```

之后彻底重启 Codex，让它带着这些环境变量重新启动。

### 4.4 语义搜索的额外环境变量

如果你只用：

- `init`
- `sync`
- `find`
- `fts`
- `graph`
- `page-info`
- `list`
- `stat`
- `create`
- `template`
- `vault`
- `lint`

那么不需要 embedding 配置。

如果你还要让 AI 使用 `search` 语义搜索，再补：

```bash
export EMBEDDING_BASE_URL=https://api.openai.com/v1
export EMBEDDING_API_KEY=your-api-key
export EMBEDDING_MODEL=text-embedding-3-small
export EMBEDDING_DIMENSIONS=384
```

## 5. 安装后，AI 会在什么情况下使用这个 skill

真正决定 AI 会不会触发 `wiki-skill` 的，不是这份 README，而是：

- `SKILL.md`
- `agents/openai.yaml`

当前 `wiki-skill` 的触发范围大致是：

- 初始化本地 wiki 工作区
- 同步 Markdown 页面到索引
- 按结构化 frontmatter 查找页面
- 做全文搜索
- 做语义搜索
- 做图谱遍历
- 查看 vault 变更
- 基于模板创建或更新 wiki 页面

### 5.1 最稳妥的触发方式：在 prompt 里显式点名

如果你希望 AI 明确使用这个 skill，直接在 prompt 里写：

```text
请使用 $wiki-skill ...
```

例如：

```text
请使用 $wiki-skill 初始化我的本地 wiki 工作区。
WIKI_PATH 和 VAULT_PATH 已经设置好。
先执行 check-config，再执行 init，最后告诉我实际创建了哪些文件。
```

### 5.2 不点名也可能自动触发

如果你的需求和 `SKILL.md` 的描述高度匹配，Codex 也可能自动触发这个 skill。

但如果你要的是“确定性”，不要赌自动触发，直接点名：

```text
$wiki-skill
```

## 6. 我应该怎么让 AI 使用这个 skill

下面这些 prompt 是“人对 AI 说的话”，不是你要亲自手敲的 CLI 命令。

### 6.1 初始化工作区

```text
请使用 $wiki-skill 初始化我的 wiki 工作区。
skill 安装目录不要当作数据目录。
实际工作区根目录是 /Users/biao/Desktop/my-knowledge-workspace。
WIKI_PATH=/Users/biao/Desktop/my-knowledge-workspace/wiki/pages 已设置。
先检查配置，再执行 init，再把实际创建的文件列给我。
```

AI 通常会做的事是：

1. 进入 skill 安装目录
2. 执行 `node dist/index.js check-config`
3. 执行 `node dist/index.js init`
4. 检查 `$WORKSPACE_DIR/wiki/` 下生成的文件

### 6.2 同步页面和 vault

```text
请使用 $wiki-skill 同步我的 wiki，并列出这次 sync 发现的 vault 新文件。
```

AI 通常会执行：

```bash
node dist/index.js sync
node dist/index.js vault diff
```

### 6.3 创建一篇新知识页

```text
请使用 $wiki-skill 为“贝叶斯定理”创建一篇 concept 页面，nodeId 用 bayes-theorem。
创建后请直接填写核心内容，再同步这一页。
```

AI 通常会执行：

```bash
node dist/index.js create --type concept --title "贝叶斯定理" --node-id bayes-theorem
node dist/index.js sync --path concepts/bayes-theorem.md
```

然后 AI 还会去编辑真正的工作区文件：

```text
$WIKI_PATH/concepts/bayes-theorem.md
```

### 6.4 结构化查找

```text
请使用 $wiki-skill 找出所有 status=active 的 concept 页面。
```

AI 通常会执行：

```bash
node dist/index.js find --type concept --status active
```

### 6.5 全文搜索

```text
请使用 $wiki-skill 全文搜索“贝叶斯”。
```

AI 通常会执行：

```bash
node dist/index.js fts "贝叶斯"
```

### 6.6 语义搜索

```text
请使用 $wiki-skill 搜索“优化算法的收敛条件”相关页面。
```

AI 通常会执行：

```bash
node dist/index.js search "优化算法的收敛条件"
```

前提是 embedding 环境变量已经配置好。

### 6.7 图谱查询

```text
请使用 $wiki-skill 查看 bayes-theorem 的 2 跳知识图谱。
```

AI 通常会执行：

```bash
node dist/index.js graph bayes-theorem --depth 2
```

## 7. 最容易搞错的路径语义

下面这些规则一定要明确。

### 7.1 `init` 应该在哪个目录运行

应该在：

```text
$CODEX_HOME/skills/wiki-skill
```

或者它对应的实际安装目录运行。

不是在：

```text
$WORKSPACE_DIR
```

更不是在：

```text
$WORKSPACE_DIR/wiki/pages
```

### 7.2 `init` 真正修改的是哪个目录

它修改的是：

- `WIKI_PATH`
- `VAULT_PATH`
- `WIKI_DB_PATH`
- `WIKI_CONFIG_PATH`
- `WIKI_TEMPLATES_PATH`

也就是你的真实 wiki 工作区。

### 7.3 `sync --path` 的路径相对于谁

`--path` 后面的值，是相对于 `WIKI_PATH` 的。

例如：

```bash
node dist/index.js sync --path concepts/bayes-theorem.md
```

它对应的真实文件是：

```text
$WIKI_PATH/concepts/bayes-theorem.md
```

不是相对于当前 shell 目录。

不是相对于 skill 安装目录。

### 7.4 `create` 创建的真实文件在哪里

例如：

```bash
node dist/index.js create --type concept --title "贝叶斯定理" --node-id bayes-theorem
```

它创建的是工作区里的真实页面，例如：

```text
$WIKI_PATH/concepts/bayes-theorem.md
```

它不会去改：

```text
$CODEX_HOME/skills/wiki-skill/assets/templates/concept.md
```

### 7.5 `template` 改的是哪里

`template list`、`template show`、`template create` 作用的是工作区模板目录：

- `WIKI_TEMPLATES_PATH`
- `WIKI_CONFIG_PATH`

不是 skill 自带的 `assets/templates/`。

### 7.6 `--output` 相对于谁

下面这类导出命令：

```bash
node dist/index.js export-index --output wiki/index.md
node dist/index.js export-graph --output graph.json
```

它们的 `--output` 如果写相对路径，是相对于 **当前 shell 目录** 解析的。

如果 AI 当前先执行了：

```bash
cd $CODEX_HOME/skills/wiki-skill
```

那么：

```bash
node dist/index.js export-index --output wiki/index.md
```

最终写到的就是：

```text
$CODEX_HOME/skills/wiki-skill/wiki/index.md
```

不是工作区里的：

```text
$WORKSPACE_DIR/wiki/index.md
```

所以，只要你是让 AI 导出文件，最安全的写法永远是：

```bash
node dist/index.js export-index --output "$WORKSPACE_DIR/wiki/index.md"
```

也就是直接给绝对路径。

## 8. 一套可以直接照抄的完整流程

下面这套流程假设你使用的是“手工 symlink 安装”，因为它的路径语义最清晰。

### 8.1 设置路径变量

```bash
export CODEX_HOME=${CODEX_HOME:-$HOME/.codex}
export WIKI_SKILL_SRC=/Users/biao/Code/tiangong-ai-skills/wiki-skill
export INSTALLED_SKILL_DIR=$CODEX_HOME/skills/wiki-skill
export WORKSPACE_DIR=/Users/biao/Desktop/my-knowledge-workspace
```

### 8.2 把 skill 装给 Codex

```bash
mkdir -p "$CODEX_HOME/skills"
ln -sfn "$WIKI_SKILL_SRC" "$INSTALLED_SKILL_DIR"
```

### 8.3 在“安装目录”里安装依赖并编译

注意这里不是进入工作区，而是进入 skill 安装目录：

```bash
cd "$INSTALLED_SKILL_DIR"
npm install
npm run build
```

### 8.4 创建实际 wiki 工作区

```bash
mkdir -p "$WORKSPACE_DIR/wiki/pages"
mkdir -p "$WORKSPACE_DIR/vault"
```

### 8.5 导出环境变量

```bash
export WIKI_PATH="$WORKSPACE_DIR/wiki/pages"
export VAULT_PATH="$WORKSPACE_DIR/vault"
export WIKI_DB_PATH="$WORKSPACE_DIR/wiki/index.db"
export WIKI_CONFIG_PATH="$WORKSPACE_DIR/wiki/wiki.config.json"
export WIKI_TEMPLATES_PATH="$WORKSPACE_DIR/wiki/templates"
export WIKI_SYNC_INTERVAL=86400
```

### 8.6 先手动验证一次 CLI

还是在 skill 安装目录执行：

```bash
cd "$INSTALLED_SKILL_DIR"
node dist/index.js check-config
node dist/index.js init
```

### 8.7 你应该看到的结果

此时真实工作区里应该出现：

```text
$WORKSPACE_DIR/
├── wiki/
│   ├── pages/
│   ├── templates/
│   ├── wiki.config.json
│   └── index.db
└── vault/
```

### 8.8 然后再让 AI 使用它

这时你就可以对 Codex 说：

```text
请使用 $wiki-skill 接管这个本地 wiki 工作区。
以后遇到需要新建知识页、同步索引、查找页面、查看 vault 变化时，都优先用这个 skill。
当前工作区根目录是 /Users/biao/Desktop/my-knowledge-workspace。
```

## 9. README、SKILL.md、源码修改之间的关系

这部分很重要，因为很多人会改错文件。

### 9.1 改 README 不会直接改变 AI 的触发行为

`README.zh-CN.md` 主要是给你这个人看的。

它不会直接决定：

- AI 什么时候自动触发这个 skill
- AI 在技能列表里怎么显示

### 9.2 真正影响 AI 触发行为的是 `SKILL.md`

如果你想改变“AI 在什么情况下应该使用 `wiki-skill`”，应该改：

```text
wiki-skill/SKILL.md
```

### 9.3 真正影响显示文案的是 `agents/openai.yaml`

如果你想改变技能卡片、技能名称、默认提示词，应该改：

```text
wiki-skill/agents/openai.yaml
```

### 9.4 改了 TypeScript 源码以后要做什么

如果你改了：

```text
wiki-skill/src/**/*.ts
```

那么只改源码还不够，还必须在“安装目录”重新编译：

```bash
cd "$INSTALLED_SKILL_DIR"
npm run build
```

如果你使用的是 copy 安装，而不是 symlink 安装，那么你还需要把修改后的 skill 重新安装或重新复制到安装目录。

## 10. 最常见的错误

### 错误 1：把 skill 安装目录当成 wiki 数据目录

错。

skill 安装目录是给 Codex 读取和执行 CLI 的。

真实 wiki 数据目录是 `WORKSPACE_DIR` 对应的位置。

### 错误 2：在工作区里运行 `npm install`

错。

`npm install` 应该在：

```text
$CODEX_HOME/skills/wiki-skill
```

运行。

### 错误 3：只写了 `.env`，但没有让 Codex 进程读取到环境变量

错。

`wiki-skill` 看的是 `process.env`。

如果 Codex 启动时没有拿到这些环境变量，AI 就会报配置错误。

### 错误 4：把 `WIKI_PATH` 写成了 `.../wiki`

错。

正确的是：

```bash
export WIKI_PATH=/absolute/path/to/workspace/wiki/pages
```

必须精确到 `pages/`。

### 错误 5：把 `sync --path` 当成相对当前目录

错。

`sync --path concepts/bayes-theorem.md` 是相对于 `WIKI_PATH` 的。

### 错误 6：用相对 `--output`，结果文件导出到了 skill 目录

这也是常见坑。

如果你不想赌当前目录，直接给绝对路径。

## 11. 相关文件

- Skill 触发与行为定义：`SKILL.md`
- Codex UI 元数据：`agents/openai.yaml`
- 环境变量约定：`references/env.md`
- 数据模型：`references/data-model.md`
- CLI 设计：`references/cli-interface.md`
- 运行时设计：`references/runtime.md`
- Agent 使用指导：`references/agent-guide.md`
