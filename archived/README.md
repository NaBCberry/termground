# TermGround

[![zotero target version](https://img.shields.io/badge/Zotero-7-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

TermGround 是一个 [Zotero](https://www.zotero.org/) 插件：从你库里已有的 PDF 里长出一份中英术语库。它读的是论文自有的双语夹注和中英关键词表，把每个术语对出现的原句留作证据，再提供一个管理窗口来确认候选、追溯出处并导出结果。

[English](./README-enUS.md) | [简体中文](./README-zhCN.md)

> [!tip]
> 👁 Watch 本仓库，以及时收到修复或更新的通知。

## Features 特性

- **数据源是论文，不是词典。** 术语对来自作者自己写下的句子，因此每一条都能追回它被引入的那句话。
- **四条抽取规则**，各有各的可信度：
  - 作者夹注 —— `超宽带（Ultra-Wideband, UWB）`；
  - 英文在前夹注 —— `Ultra-Wideband（超宽带）`；
  - 中文期刊必备的中英关键词表 —— 按位置两两对齐；
  - 领域后缀名词短语的频次扫描（`…算法`、`…精度`），进待确认队列，而不是被悄悄丢掉。
- **进库要么有规则撑腰，要么有人点头。** 得分 ≥ `0.8` 的候选自动入库，其余（≥ `0.4`）留在待确认队列里，不会被丢掉。
- **证据是数据，不是装饰。** 每个术语对都带原句、页码、章节、来源规则、置信度与入库时间；人工改写过的术语对降为 `suggested`，因为原引文已不再逐字支撑它。
- **管理窗口**（工具 → TermGround 术语库）分「待确认 / 术语库 / 文献」三视图，支持中英双语搜索（`Ctrl K`）、漂移分组、CSV 导出与一键诊断。
- **磁盘上就是一份普通 JSON**，位于 Zotero 数据目录的 `termground/terms.json` —— 不加数据库表，Zotero 升级不会碰坏它。
- **规则集可单元测试。** 全部文本与抽取逻辑都是不含 Zotero API 的纯 TypeScript，由 48 个单元测试覆盖。

## 工作原理 (How it works)

```
选中条目 ──▶ PDF 文本层 ──▶ 页 ──▶ 块 ──▶ 句子 ──▶ 候选
  (菜单)      (PDFWorker)  (换页符) (章节)          │
                                                   ├─ 得分 ≥ 0.8 ─▶ 术语库（自动）
                                                   └─ 得分 ≥ 0.4 ─▶ 待确认队列 ─▶ 人工确认
                                                                                    │
                                                              管理窗口 ◀─────────────┘
```

在条目菜单上点 **提取术语（TermGround）** 之后：

1. 把选中条目展开成真正能读的 PDF 附件（同一时刻只允许一个提取任务，运行中再点会被拒绝）；
2. 用 Zotero 自己的 `PDFWorker.getFullText()` 取文本层，页码随换页符（form feed）天然到来，无需自己解析 PDF；
3. 修掉文本层留下的问题 —— 每两个汉字之间被插入的空格、被连字符断开的英文换行、全角标点；
4. 切块时顺带识别章节标题，于是证据能标上 `abstract_zh`、`keywords_en`、`method`、`references` 等章节；
5. 跑四条规则，再按得分分流并去重写入术语库。

自动写入只发生在提取这一步，而且它从不覆盖人的决定：你驳回过的候选再次遇到时依然是驳回状态，只是出现次数继续累加。

### 抽取规则 (Extraction rules)

| 规则                | 接受什么                              | 置信度                 | 落点                  |
| ------------------- | ------------------------------------- | ---------------------- | --------------------- |
| `author_note`       | `中文术语（English Term, ABBR）`      | 确定 0.95 / 不确定 0.6 | 确定者进库为 verified |
| `english_note`      | `English Term（中文术语）`            | 0.9                    | 进库为 verified       |
| `bilingual_keyword` | `关键词` 与 `Keywords` 两行按位置对齐 | 0.88                   | 进库为 verified       |
| `zh_np_frequency`   | 含领域后缀、且出现 ≥ 2 次的名词短语   | ≤ 0.6                  | 只进待确认队列        |

真正花心思的地方是边界回收：`已有研究广泛采用超宽带（Ultra-Wideband, UWB）` 必须切出 `超宽带`，而不是括号前那一整串。最可靠的切法是用术语库里已知的词；否则剥掉前置动词与连接词（`提出`、`采用`、`基于`…），并在切口无法证明干净时把候选标为「不确定」。之后还做过滤 —— 被打碎的英文（`dist rib ut ed`）、期刊版式垃圾（`中图分类号`）、章节标题、基金号、被粘在一起的超长词（`Pathplanningalgorithm`）以及停用词组合都会被拒，并且**把丢弃数量报出来**而不是瞒着。

## Examples 示例

### 条目菜单 (Item menu)

| 菜单项                     | 作用                          |
| -------------------------- | ----------------------------- |
| `提取术语（TermGround）`   | 从选中条目及其 PDF 附件中抽取 |
| `术语库管理（TermGround）` | 打开管理窗口                  |

两项都在条目右键菜单里；管理窗口另有 **工具 → TermGround 术语库** 这一全局入口，因为术语库是整库共有的，与当前选中无关。

### 管理窗口 (Manager window)

> 🖼 这个窗口先有视觉稿后有实现：用浏览器打开 [`ui-prototype/termground-manager.html`](./ui-prototype/termground-manager.html) 即可不启动 Zotero 看到预期版式。

三个视图的数据都来自 `addon.api.manager`（定义于 `src/modules/managerWindow.ts`），它每次调用都重新从磁盘加载，因此窗口与主窗口的提取流程不会互相覆盖：

- **待确认** —— 规则不够自信、没有入库的候选。每张卡片给出保留它的理由、得分、带页码与章节的完整引文，以及可编辑的中英文输入框。`Enter` 确认并下一条，`R` 驳回，`S` 跳过，低分候选可批量驳回。确认为人工动作：被改写过的术语对会以 `suggested`（来源 `human_review`）入库。
- **术语库** —— 全部术语对及其状态、来源规则与证据条数，证据可就地展开。**漂移分组视图**把「同一中文概念存在多种英文写法」的概念归到一组 —— 这正是术语库长大时的真实故障模式；工具把多种译法并排摆出来，但不替你选。
- **文献** —— 已摄取的文献，以及各自读了多少页、找到多少候选、入库多少术语对、何时抽取。
- **导出术语表** —— 把整个术语库以 CSV（`en,zh,role,status`）复制到剪贴板，可直接粘进翻译流程。
- **导出诊断** —— 把窗口渲染与环境信息写成文件，放在正在运行的插件源码旁。之所以需要它，是因为这个窗口真实出过的问题就是「控件不显示」，而当界面本身就是待查对象时，调试日志和剪贴板都指望不上。

### 首选项面板 (Preference pane)

面板刻意做得很薄：它显示术语库文件所在路径（便于备份或直接打开），以及构建信息。见 [`addon/content/preferences.xhtml`](../addon/content/preferences.xhtml) 与 [`src/modules/preferenceScript.ts`](../src/modules/preferenceScript.ts)。

> [!note]
> `extensions.zotero.termground.enable` 这个开关在面板和 `addon/prefs.js` 里都有，但目前没有任何代码读它 —— 提取始终可用。写在这里是为了避免有人误以为它已经生效。

## 快速上手 (Quick Start Guide)

### 0 环境要求 (Requirement)

1. 安装 [beta 版 Zotero](https://www.zotero.org/support/beta_builds)
2. 安装 [Node.js 最新 LTS 版本](https://nodejs.org/zh-cn/download) 和 [Git](https://git-scm.com/)

> [!note]
> `zotero-plugin-scaffold` 要求 Node.js **≥ 22.8.0**；单元测试由 Node 直接执行 `.ts`，CI 固定在 Node 24。
>
> 本指南假定你已经对 Zotero 插件的基本结构和工作原理有初步了解。如果你还不了解，请先参考[官方文档](https://www.zotero.org/support/dev/zotero_7_for_developers) 和[官方插件样例 Make It Red](https://github.com/zotero/make-it-red)。

### 1 克隆仓库 (Clone the repo)

```sh
git clone https://github.com/NaBCberry/termground.git
cd termground
```

### 2 配置模板和开发环境 (Config Settings and Enviroment)

1. `./package.json` 里的设置已经是本插件的真实值，改动前请先看清它们：

   ```jsonc
   {
     "version": "0.1.0",
     "description": "TermGround Plugin",
     "config": {
       "addonName": "TermGround Plugin", // 插件名称
       "addonID": "nabc_zhou@tianyi.ink", // 插件 ID【重要：防止冲突】
       "addonRef": "termground", // 插件命名空间：元素前缀等
       "addonInstance": "TermGround", // 注册在 Zotero 根下的实例名：Zotero.TermGround
       "prefsPrefix": "extensions.zotero.termground", // 首选项的前缀
     },
     "repository": {
       "type": "git",
       "url": "git+https://github.com/NaBCberry/termground.git",
     },
     "author": "NaBCberry",
     "bugs": {
       "url": "https://github.com/NaBCberry/termground/issues",
     },
     "homepage": "https://github.com/NaBCberry/termground#readme",
   }
   ```

   > [!warning]
   > 如果你把它改成自己的插件，务必修改 `addonID` 与 `addonRef` 。

2. 复制环境变量文件，填入 Zotero 可执行文件路径与开发用 profile 路径：

   > (可选项) 创建开发用 profile 目录：
   >
   > 此操作仅需执行一次：使用 `/path/to/zotero -p` 启动 Zotero，创建一个新的配置文件并用作开发配置文件。

   ```sh
   cp .env.example .env
   vim .env
   ```

   如果你维护了多个插件，可以将这些内容存入系统环境变量，以避免在每个插件中都需要重复设置。

3. 运行 `npm install` 以安装相关依赖

   > 如果你使用 `pnpm` 作为包管理器，需要添加 `public-hoist-pattern[]=*@types/bluebird*` 到 `.npmrc`，详情见 [zotero-types](https://github.com/windingwind/zotero-types?tab=readme-ov-file#usage)。
   >
   > 如果 `npm install` 报 `npm ERR! ERESOLVE unable to resolve dependency tree`（上游 typescript-eslint 的问题），用 `npm i -f`。
   >
   > `package-lock.json` 是**故意提交**的：CI 使用 `npm ci` 安装。

### 3 开发插件 (Coding)

使用 `npm start` 启动开发服务器，它将：

- 在开发模式下预构建插件；
- 启动 Zotero，并让其从 `build/` 中加载插件；
- 监听 `src/**` 和 `addon/**`，当文件发生修改时重新构建并重新加载。)

#### 自动热重载 (Auto Hot Reload)

厌倦了无休止的重启吗？忘掉它，拥抱热加载！

1. 运行 `npm start`.
2. 编码。(是的，就这么简单)

当检测到 `src` 或 `addon` 中的文件修改时，插件将自动编译并重新加载。

<details style="text-indent: 2em">
<summary>💡 将此功能添加到现有插件的步骤</summary>

请参阅：[zotero-plugin-scaffold](https://github.com/northword/zotero-plugin-scaffold)。

</details>

#### 调试代码 (Debug in Zotero)

你还可以：

- 在 Tools → Developer → Run Javascript 中测试代码片段；
- 使用 `Zotero.debug()` 调试输出，在 Help → Debug Output Logging → View Output 查看；
- 调试 UI。Zotero 建立在 Firefox XUL 框架之上，可用 [XUL Explorer](https://udn.realityripple.com/docs/Archive/Mozilla/XUL_Explorer) 等软件调试 XUL UI。

  > XUL 文档：<http://www.devdoc.net/web/developer.mozilla.org/en-US/docs/XUL.html>

本插件自己的排查线索，按通常的使用顺序：

| 现象                      | 去哪儿看                                                              |
| ------------------------- | --------------------------------------------------------------------- |
| 点提取没有任何反应        | 进度窗口文字，再看调试日志里的 `termground extract report`            |
| 提取报告里有 skipped      | 报告里的 `skipped[]` —— 最常见是「没有可提取的文本」（扫描版无 OCR）  |
| 提取成功但术语库不对      | Zotero 数据目录下的 `termground/terms.json`，首选项面板会印出确切路径 |
| 管理窗口空白 / 控件不显示 | 窗口底部的 **导出诊断**，会把报告写在插件源码旁                       |

### 4 构建插件 (Build)

运行 `npm run build` 在生产模式下构建插件（`zotero-plugin build && tsc --noEmit`），构建结果位于 `.scaffold/build/` 目录。

构建步骤文档可参阅 [zotero-plugin-scaffold](https://northword.github.io/zotero-plugin-scaffold/build.html)，简单来说可分为以下几步：

- 创建/清空 `build/`；
- 复制 `addon/**` 到 `.scaffold/build/addon/**`；
- 替换占位符：替换在 `package.json` 中定义的关键字和配置；
- 准备本地化文件以避免冲突，查看 [zotero_7_for_developers](https://www.zotero.org/support/dev/zotero_7_for_developers#avoiding_localization_conflicts) 了解更多：
  - 重命名 `**/*.flt` 为 `**/${addonRef}-*.flt`；
  - 在每个消息前加上 `addonRef-`；
  - 为 FTL 消息生成类型声明文件；
- 准备首选项文件，在首选项键前添加前缀 `package.json#prefsPrefix`，并为首选项生成类型声明文件；
- 使用 ESBuild 将 `.ts` 源码构建为 `.js`，从 `src/index.ts` 构建到 `.scaffold/build/addon/content/scripts`；
- (仅生产模式) 压缩 `.scaffold/build/addon` 目录为 `.scaffold/build/*.xpi`；
- (仅生产模式) 准备 `update.json` 或 `update-beta.json`。

> [!note]
>
> **Dev & prod 两者有什么区别？**
>
> - 该环境变量存储在 `Zotero.${addonInstance}.data.env` 中，控制台输出在生产模式下被禁用。
> - 你可以根据此变量决定用户无法查看/使用的内容。
> - 在生产模式下，构建脚本将自动打包插件并更新 `update.json`。

### 5 测试 (Test)

```sh
npm run test:unit   # 48 个规则/存储单元测试，纯 Node（node:test），不需要 Zotero
npm run test        # headless Zotero 集成测试（test/）
```

`test-unit/` 覆盖 `src/modules/textUtils.ts`、`src/modules/termExtract.ts`、`src/modules/termStore.ts` 里的纯逻辑 —— 这也正是这些文件接收 `Set<string>` 已知术语、而不直接碰 Zotero 的原因。`test/` 由脚手架拉起真实 Zotero，断言插件实例存活。

### 6 发布 (Release)

如果要构建和发布插件，运行如下指令：

```shell
# version increase, git add, commit and push
# then on ci, npm run build, and release to GitHub
npm run release
```

> 📖 本仓库的代码检查、构建、自动发布与 `update.json` 机制的完整说明（含「本地 bump + CI 发布」与「Actions 一键发布」两条主线）见 [release.md](./release.md)。

> [!note]
> 在此模板中，发布流程被配置为在本地更新版本号、提交并推送标签，随后 GitHub Action 将重新构建插件并将 XPI 发布到 GitHub Release。

#### 关于预发布 (About Prerelease)

构建脚本把 `prerelease` 定义为插件的测试版：当你在版本选择中选中预发布版本（版本号中带 `-`）时，**只**刷新 `update-beta.json`，从而确保常规版本的用户不会自动更新到测试版；只有手动下载并安装了测试版的用户才能自动更新到下一个测试版。当下一个正式版发布时，`update.json` 与 `update-beta.json` 会同时更新，正式版和测试版用户都能更新到最新的正式版。

本仓库还提供 `.github/workflows/release-manual.yml`，不想在本地跑命令的人可以在 Actions 界面里一键完成「改版本号 → 提交 → 打标签 → 发布」。

> [!warning]
> 严格来说，区分 Zotero 6 与 Zotero 7 兼容的插件版本应该通过 `update.json` 的 `addons.__addonID__.updates[]` 中分别配置 `applications.zotero.strict_min_version`，这样 Zotero 才能正确识别，详情参阅 [Zotero 7 开发文档](https://www.zotero.org/support/dev/zotero_7_for_developers#updaterdf_updatesjson)。

## Details 更多细节

### 关于 Hooks (About Hooks)

> 详见 [`src/hooks.ts`](../src/hooks.ts)

1. 当在 Zotero 中触发安装/启用/启动时，`bootstrap.js` > `startup` 被调用
   - 等待 Zotero 就绪；
   - 加载 `index.js`（插件代码的主入口，从 `index.ts` 构建）；
   - 如果是 Zotero 7 以上版本则注册资源。
2. 主入口 `index.js` 中，插件对象被注入到 `Zotero`，并且 `hooks.ts` > `onStartup` 被调用。
   - 本插件的 `onStartup` 初始化语言资源、构建管理窗口 API（`setupManagerWindow`）、注册首选项面板，然后对每个主窗口执行 `onMainWindowLoad`。
3. 当在 Zotero 中触发卸载/禁用时，`bootstrap.js` > `shutdown` 被调用。
   - `hooks.ts` > `onShutdown` 被调用：注销经 `ztoolkit` 注册的 UI 元素、关闭管理窗口、从 `Zotero` 上删除插件实例。

Hooks 只做分发。业务逻辑放在它们旁边的模块里（`terminology.ts`、`managerWindow.ts`、`termPipeline.ts`…），因为在 hook 里做实事的代码会变得非常难维护。

### 关于数据模型 (About the data model)

> 详见 [`src/modules/termStore.ts`](../src/modules/termStore.ts)

术语库就是 `Zotero.DataDirectory.dir` 下的一个 JSON 文件 `termground/terms.json`：

```jsonc
{
  "version": 1,
  "pairs": [
    /* en, zh, abbr?, role, status, source, confidence, at */
  ],
  "evidence": [
    /* en, zh, quote, page, section, source, itemKey?, at */
  ],
  "items": {
    /* itemKey -> pages, candidates, pairs, extractedAt */
  },
  "pending": [
    /* id, zh, en?, method, score, quote, …, seenCount, status */
  ],
}
```

三个值得知道的决定：

- **用插件自己的文件，不加 Zotero 数据库表。** 没有 schema 耦合，Zotero 升级动不到它，几千条术语对内存里放得下。
- **路径分隔符从 `Zotero.DataDirectory.dir` 自身推断。** Mozilla 的文件 API 会把 `C:\…\Zotero` 与 `/termground/terms.json` 这种混搭判为 `NS_ERROR_FILE_UNRECOGNIZED_PATH`。
- **已知术语对也照样累积证据。** 重复出现的术语不会产生重复条目，但会追加证据 —— 正因如此，「一个中文概念、多种英文写法」的漂移才看得见，而不是先到先得之后被悄悄掩盖。

### 关于全局变量 (About Global Variables)

> 详见 [`src/index.ts`](../src/index.ts)

bootstrap 插件运行在沙盒中，沙盒里没有 `Zotero`、`window` 这类我们在 overlay 插件环境里习惯的全局变量。

本插件将以下变量注册到全局范围：

```plain
Zotero, ZoteroPane, Zotero_Tabs, window, document, rootURI, ztoolkit, addon;
```

`addon.data.env`（`"development"` / `"production"`）在构建时注入，是唯一的环境开关；`addon.api.manager` 是管理窗口脚本调用的接口面。

### 创建元素 API (Create Elements API)

插件使用 `ztoolkit` 的元素 API，而不是裸的 `createElement/createElementNS`：

- 在 bootstrap 模式下，插件必须在退出（禁用或卸载）时清理所有 UI 元素，这非常麻烦。使用 `createElement`，插件模板会维护这些元素，退出时只需 `unregisterAll`。
- Zotero 7 需要 createElement()/createElementNS() → createXULElement() 来表示其余的 XUL 元素，而 Zotero 6 并不支持 `createXULElement`。类似 React.createElement 的 API `createElement` 会检测 namespace(xul/html/svg) 并自动创建元素，返回值为对应的 TypeScript 元素类型。

```ts
createElement(document, "div"); // returns HTMLDivElement
createElement(document, "hbox"); // returns XUL.Box
createElement(document, "button", { namespace: "xul" }); // manually set namespace. returns XUL.Button
```

管理窗口是唯一的例外：它是自己的 chrome 窗口，加载 `addon/content/manager.xhtml` 与一份朴素的 `manager.js`，并在该窗口自己的 document 上建节点。

### 关于 Zotero API (About Zotero API)

Zotero 文档已过时且不完整，克隆 <https://github.com/zotero/zotero> 并全局搜索关键字。

> ⭐[zotero-types](https://github.com/windingwind/zotero-types) 提供了最常用的 Zotero API，默认包含在本插件中，你的 IDE 会为大多数 API 提供提示。

猜你需要：查找所需 API 的技巧 ——

在 `.xhtml`/`.flt` 文件中搜索 UI 标签，在 locale 文件中找到对应的键，再在 `.js`/`.jsx` 文件中搜索此键。

本插件依赖、且文档里不太看得出用法的两个调用：

- `Zotero.PDFWorker.getFullText(attachmentID, null)` —— PDF 文本层，页与页之间是换页符；
- `Services.ww.openWindow(...)` + `Services.scriptloader.loadSubScript(...)` —— 打开管理窗口并加载其脚本；插件接口必须在脚本运行**之前**注入窗口作用域（那里既没有可用的 `window.arguments`，也没有 `Zotero` 全局）。

### 目录结构 (Directory Structure)

- 所有 `.js/.ts` 代码都在 `./src`；
- 插件配置文件：`./addon/manifest.json`；
- UI 文件：`./addon/content/*.xhtml`；
- 区域设置文件：`./addon/locale/**/*.flt`；
- 首选项文件：`./addon/prefs.js`；
- 文档与界面视觉稿：`./doc`；
- 纯逻辑单元测试在 `./test-unit`，headless Zotero 集成测试在 `./test`。

```shell
.
|-- .github/                  # github conf (ci / release / release-manual / issue-bot)
|-- .vscode/                  # vscode conf
|-- addon                     # static files
|   |-- bootstrap.js
|   |-- content
|   |   |-- icons
|   |   |   |-- favicon.png
|   |   |   `-- favicon@0.5x.png
|   |   |-- manager.xhtml      # 术语库管理窗口
|   |   |-- manager.css
|   |   |-- manager.js         # 窗口脚本（调用 addon.api.manager）
|   |   |-- preferences.xhtml
|   |   `-- zoteroPane.css
|   |-- locale
|   |   |-- en-US
|   |   |   |-- addon.ftl
|   |   |   |-- mainWindow.ftl
|   |   |   `-- preferences.ftl
|   |   `-- zh-CN
|   |       |-- addon.ftl
|   |       |-- mainWindow.ftl
|   |       `-- preferences.ftl
|   |-- manifest.json
|   `-- prefs.js
|-- doc
|   |-- README-zhCN.md
|   |-- release.md             # CI 与发布流程
|   |-- zotero插件架构与最佳实践.md
|   `-- ui-prototype
|       `-- termground-manager.html
|-- src                        # source code of scripts
|   |-- addon.ts               # base class（含 addon.api.manager）
|   |-- hooks.ts               # lifecycle hooks（只做分发）
|   |-- index.ts               # main entry
|   |-- modules
|   |   |-- terminology.ts     # 条目菜单：提取 / 打开管理窗口
|   |   |-- termPipeline.ts    # 条目 -> PDF 文本 -> 分段
|   |   |-- termExtract.ts     # 四条抽取规则
|   |   |-- textUtils.ts       # 纯文本工具
|   |   |-- termStore.ts       # JSON 术语库
|   |   |-- managerWindow.ts   # 窗口宿主 + 管理接口
|   |   `-- preferenceScript.ts
|   `-- utils                  # utilities
|       |-- locale.ts
|       |-- prefs.ts
|       |-- wait.ts
|       |-- window.ts
|       `-- ztoolkit.ts
|-- test                       # headless Zotero 集成测试
|-- test-unit                  # 纯规则集单元测试
|-- typings                   # ts typings
|   `-- global.d.ts
|-- .env                      # enviroment config (do not check into repo)
|-- .env.example              # template of enviroment config
|-- .gitignore                # git conf
|-- .gitattributes            # git conf
|-- .gitmessage                # 提交信息模板
|-- .prettierignore            # prettier ignore
|-- eslint.config.mjs         # eslint conf, https://eslint.org/
|-- LICENSE
|-- package-lock.json
|-- package.json
|-- tsconfig.json             # typescript conf
|-- README.md
`-- zotero-plugin.config.ts   # scaffold conf, https://github.com/northword/zotero-plugin-scaffold
```

## 已知限制与后续 (Roadmap / Known limits)

- `enable` 首选项目前没有任何代码路径读取它（见上方说明）。
- 规则调参目前靠测试与领域后缀表（`DOMAIN_SUFFIXES`）支撑，尚不支持导入用户自带的术语表。
- 中文侧边界在匹配不到已知术语时会退化为定长启发式，并把结果标记为「不确定」，而不是瞎猜 —— 这类候选一定需要人工过一遍。
- 语言方向：抽取规则针对「中文论文 + 英文夹注/关键词」。其他语言对暂不在范围内。

## Disclaimer 免责声明

在 AGPL 下使用此代码。不提供任何保证。遵守你所在地区的法律！

本插件基于 [Zotero Plugin Template](https://github.com/windingwind/zotero-plugin-template) 搭建；模板自带的文档与社区插件列表属于上游仓库，与本仓库无关。
