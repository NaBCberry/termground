# TermGround CI 与发布流程

本文说明本仓库的 GitHub Actions 流水线，以及 `zotero-plugin-scaffold` 下**规范化的自动发布流程**。
内容全部基于 `zotero-plugin-scaffold@0.9.2` 的实际实现（`node_modules/zotero-plugin-scaffold/dist`）核对。

## 1. 流水线总览

| 工作流               | 触发条件                               | 作用                                                                                                                            |
| -------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`             | push / PR 到 `main`，手动触发          | 代码检查（Prettier + ESLint，目前仅报告）、单元测试（mocha，48 例）、`tsc --noEmit`、生产构建、headless 集成测试、上传 XPI 产物 |
| `release.yml`        | 推送 `v*` 标签，或手动指定已存在的标签 | 在 CI 中重新构建并**正式发布** GitHub Release                                                                                   |
| `release-manual.yml` | 手动触发（填写版本号）                 | 一键完成「改版本号 → 提交 → 打标签 → 构建 → 发布」                                                                              |

`issue-bot.yml`、`dependabot.yml`、`renovate.json` 保持模板默认，与本流程无关。

> [!IMPORTANT]
> `ci.yml` 的 lint 关目前是**仅报告、不阻塞**：仓库中约有 10 个既有文件未按 Prettier 配置格式化（约 1480 行差异，主要是换行与缩进），CI 不会因此变红，但会在 job summary 里列出问题。本地执行 `npm run lint:fix` 修好后，删除 `ci.yml` 中 lint job 的 `continue-on-error: true`，即可恢复为硬性门禁。

## 2. 发布物与标签语义

发布一次会产出**两类** Release，这是 scaffold 的核心设计：

| 标签        | 内容                               | 说明                                                              |
| ----------- | ---------------------------------- | ----------------------------------------------------------------- |
| `v<版本号>` | `<addonRef>.xpi`（插件安装包）     | 用户在 Release 页面下载安装；版本号含 `-` 时自动标记为 prerelease |
| `release`   | `update.json` / `update-beta.json` | 固定不变的「更新清单」Release，**不要删除或手动修改**             |

Zotero 客户端轮询的更新地址由 `zotero-plugin.config.ts` 的 `updateURL` 决定：

```text
https://github.com/NaBCberry/termground/releases/download/release/update.json
```

- 正式版（版本号无 `-`）：同时刷新 `update.json` 与 `update-beta.json`。
- 预发布版（如 `0.2.0-beta.1`）：**只**刷新 `update-beta.json`，正式版用户不会被更新到 beta。

## 3. `zotero-plugin release` 在本地与 CI 的行为差异

同一条命令，行为取决于是否处于 CI 环境（`CI` 环境变量，GitHub Actions 默认设置）：

| 阶段        | 本地（`!isCI`）                                                       | CI（`isCI`）                                      |
| ----------- | --------------------------------------------------------------------- | ------------------------------------------------- |
| 版本号      | 交互式询问（`prompt`），写入 `package.json`                           | 不做任何 bump，直接使用 `package.json` 里的版本号 |
| git 操作    | `git commit`（`chore(publish): release v%s`）+ `git tag` + `git push` | 全部跳过                                          |
| 构建        | 若未配置 `bumpp.execute`，发布前自动执行 `npm run build`              | 同左                                              |
| GitHub 发布 | 默认关闭（`release.github.enable: "ci"`）                             | 创建 Release 并上传 XPI，随后刷新 `update.json`   |

由此得到两种正规用法：**本地负责 bump 与打标签，CI 负责构建与发布**（推荐），或**全程在 CI 中完成**（`release-manual.yml`）。

## 4. 流程 A：本地 bump + CI 发布（推荐主线）

这是上游模板与社区插件最通用的做法，版本号决策点留在开发者手里。

```bash
# 1. 确保 main 干净、CI 通过
git switch main && git pull

# 2. 交互式选择版本号（major / minor / patch / prerelease / 自定义）
npm run release
#    → 更新 package.json 版本（以及 package-lock.json）
#    → git commit "chore(publish): release v0.2.0"
#    → git tag v0.2.0
#    → git push（含标签）

# 3. 标签推送自动触发 .github/workflows/release.yml
#    → npm ci && npm run build
#    → npm run release（CI 模式：创建 Release v0.2.0 并上传 XPI）
#    → 刷新 release 标签下的 update.json
```

要点：

- 标签与 `package.json` 版本必须一致，`release.yml` 里有一步 `Verify tag matches package.json` 会提前拦下不一致的情况（否则 scaffold 会为错误版本创建 Release）。
- 提交信息遵循 Conventional Commits（`feat:` / `fix:` / `chore:` …），Release 正文的 changelog 由 changelogen 依据**上一个标签到当前标签之间的提交**自动生成，因此 `release.yml` 必须 `fetch-depth: 0`。
- 想跳过交互：`npx zotero-plugin release minor -y`（或在 `zotero-plugin.config.ts` 里配置 `release.bumpp`）。

## 5. 流程 B：Actions 一键发布

`.github/workflows/release-manual.yml` 适合「不想在本地跑命令」的场景：

1. 打开 **Actions → Release (Manual Bump) → Run workflow**；
2. 分支选 `main`，填写版本号（如 `0.2.0`、`0.2.0-beta.1`，**不要**带 `v` 前缀）；
3. 工作流依次执行：校验分支为 `main` → `npm version` 改写版本 → 提交并推送 `v<版本>` 标签 → `npm run release` 完成发布。

两个必须知道的限制：

- 工作流用 `GITHUB_TOKEN` 推送标签，而 **`GITHUB_TOKEN` 推送产生的事件不会触发其他工作流**（GitHub 防递归规则），所以发布动作在同一工作流内完成，不会与 `release.yml` 重复。
- 若 `main` 启用了分支保护（要求 PR / 要求签名），机器人推送会被拒绝。此时请改用流程 A。

## 6. 流程 C：官方复用工作流

`release.yml` 末尾以注释形式给出了官方等价实现：

```yaml
jobs:
  create-release:
    uses: zotero-plugin-dev/workflows/.github/workflows/release-plugin.yml@main
    with:
      build: "npm run build"
      release: "npm run release"
    secrets: inherit
```

它与本仓库手写实现的差别：多一步「在 Release 后给相关 Issue/PR 留通知评论」，代价是依赖上游 `@main`（行为随之变动）。如需使用，建议改为固定到某个 commit SHA。注意该复用工作流内部依赖 `setup-js` 自动识别包管理器，**仓库必须提交锁文件**才会走 npm。

## 7. 为什么不接 release-please / changesets

常见的「PR 驱动自动发版」方案（release-please、changesets）与本脚手架冲突：它们会**自己创建 GitHub Release**，而 scaffold 的发布逻辑是无条件 `createRelease(tag_name: "v<version>")`，标签对应的 Release 已存在时 GitHub 返回 422，scaffold 直接抛错 `Create release failed.`。若坚持使用，需要放弃 `npm run release`，改由 `softprops/action-gh-release` 上传 XPI，并另外维护 `release` 标签下的 `update.json`（需自行处理 XPI 文件名、hash、`strict_min_version` 等字段），维护成本明显更高。

## 8. 权限与密钥

| 场景                       | 需要的配置                                                              |
| -------------------------- | ----------------------------------------------------------------------- |
| CI（`ci.yml`）             | 无需任何密钥，`permissions: contents: read` 即可，fork 的 PR 也能跑     |
| 发布（`release.yml`）      | 默认 `GITHUB_TOKEN`（`permissions: contents: write`）足够               |
| 需要标签推送触发后续工作流 | 需用 PAT（classic 需 `repo`，fine-grained 需 Contents: RW）并自定义密钥 |

仓库的 `Settings → Actions → General → Workflow permissions` 需允许 `Read and write permissions`，否则 `GITHUB_TOKEN` 无法创建 Release。

## 9. 首次发布前的准备

1. **提交锁文件**：`package-lock.json` 已从 `.gitignore` 中移除，请务必提交，CI 使用 `npm ci` + 缓存需要它（同时避免上游 `setup-js` 因找不到锁文件而回退到 pnpm）。
2. 确认 `package.json` 的 `repository.url` / `homepage` / `config.addonID` / `addonRef` 正确（`updateURL`、`xpiDownloadLink` 由它们插值生成）。
3. 确认 `zotero-plugin.config.ts` 的 `updateURL` 指向 `releases/download/release/`（本仓库已如此，正式版 `update.json`、预发布 `update-beta.json`）。
4. 首次发布没有历史标签，changelog 会退化为「全部提交」或 `_No significant changes._`，属正常现象。
5. Node.js 版本：本地与 CI 均需 **≥ 22.8.0**（scaffold `engines` 要求），工作流中固定为 Node 24。

## 10. 本地预检与发布后校验

```bash
npm ci
npm run lint:check   # prettier --check . && eslint .
npm run test:unit   # test-unit/ 下的 48 个单元测试（mocha，Node 24 直接跑 .ts）
npm run build        # 构建 + tsc --noEmit，产物在 .scaffold/build
npm run test         # headless Zotero 集成测试（test/ 目录）
```

发布成功后依次确认：

- `https://github.com/NaBCberry/termground/releases/tag/v<版本>` 存在，资产里有 `.xpi`；
- `https://github.com/NaBCberry/termground/releases/download/release/update.json` 的 `version` 已指向新版本；
- 在 Zotero 中「检查更新」能看到新版本（预发布版需先手动安装过 beta）。
