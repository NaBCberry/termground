# Zotero 插件：工作原理与 TermGround 适配方案

> 状态：设计文档，尚未写任何插件代码
> 目标读者：负责实现插件的人
> 事实来源：本地模板源码（`zotero-plugin-scaffold` 0.8.2 / `zotero-plugin-toolkit` 5.1.0-beta.13）、Zotero 官方开发者文档、社区插件开发文档（windingwind 的 doc-for-zotero-plugin-dev）

---

## 1. 插件是怎么跑起来的

### 1.1 形态：Bootstrapped 扩展

Zotero 7 之后插件只有一种形态——bootstrapped extension，由两个文件定义：

| 文件 | 作用 |
|---|---|
| `addon/manifest.json` | 清单：ID、名称、版本、`applications.zotero.strict_min_version` 与 `strict_max_version` |
| `addon/bootstrap.js` | 引导脚本：Zotero 在插件的每个生命周期节点回调它 |

代码运行在 Zotero 的**特权 chrome 上下文**里（Zotero 10 基于 Firefox 140 ESR）。这意味着插件能访问 `Components`、`Services`、本地文件系统，也能启动外部进程——这一点决定了第 3 节的技术选型。

### 1.2 生命周期

```
install       首次安装，做一次性初始化
  ↓
startup       注册 chrome 资源 → 加载编译后的插件脚本 → hooks.onStartup()
  ↓
onMainWindowLoad / onMainWindowUnload   每个主窗口打开/关闭时各一次
  ↓
shutdown      插件卸载或 Zotero 退出：hooks.onShutdown()
  ↓
uninstall     可选清理
```

模板把这套流程拆成两层，**这是个好设计，应该沿用**：

- `addon/bootstrap.js` 只做引导：注册 `chrome://` 资源、用 `Services.scriptloader.loadSubScript` 载入打包好的脚本、把生命周期事件转给 hooks。
- `src/hooks.ts` 只做**分发**：每个生命周期函数里只调用各 Factory 的注册方法，不写业务逻辑。模板里那句注释说得很直白——hooks 里不要做实事，否则代码会变得难以维护。

`onStartup` 里必须等三个 Promise：`Zotero.initializationPromise`、`unlockPromise`、`uiReadyPromise`。

### 1.3 TypeScript 脚手架做了什么

`zotero-plugin-scaffold` 负责把 TypeScript 打包成 Zotero 能加载的东西：

1. esbuild 把 `src/index.ts` 打包成 `addon/content/scripts/<addonRef>.js`，`target: firefox115`；
2. `addon/**/*.*` 原样拷进构建产物；
3. `package.json` 的 `config` 块里的占位符（`__addonName__`、`__addonID__` 等）在构建时被替换；
4. `prefs.js` 按 `prefsPrefix` 注入默认偏好。

开发时的三条命令：

```bash
npm start        # 开发模式：把插件装载进 Zotero 并热重载
npm run build    # 构建 + 类型检查
npm run release  # 打包发布（生成 xpi 与 update.json）
```

### 1.4 Zotero 10 的破坏性变更（动手前必须改掉）

| 项 | 现状 | 必须改成 |
|---|---|---|
| `strict_max_version` | 模板写 `8.*` | **`10.0.*`**。用户本机是 Zotero 10.0.2，不改这一项插件根本装不上 |
| 多选相关 API | —— | 官方已把 `getSelectedCollection()` 这类单数方法改为**抛错**，替换为 `getSelectedCollections()`、`getSelectedLibraryIDs()` 等复数版本。本次功能用不到，但一旦要读选中项就得按新 API 写 |

---

## 2. 可用的 UI 扩展点

全部在 `onStartup` 或 `onMainWindowLoad` 里注册，用模板里的 `ztoolkit` 包装调用：

| 扩展点 | API | TermGround 用它做什么 |
|---|---|---|
| 条目右键菜单 | `ztoolkit.Menu.register("item", {...})` | 「加入术语库」：把选中的文献摄取进引擎 |
| 条目面板区块 | `Zotero.ItemPaneManager.registerSection({paneID, pluginID, header, sidenav, onRender, onItemChange})` | 「本文献的术语」：显示该文献贡献了哪些术语对，可跳转证据 |
| **阅读器划词弹窗** | `Zotero.Reader.registerEventListener("renderTextSelectionPopup", cb, pluginID)` | 读 PDF 时划词，直接显示库里已有的英文表述与出处 |
| 阅读器侧栏批注头 | 同上，`renderSidebarAnnotationHeader` | 后续可做「批注里的术语校对」 |
| 阅读器工具栏 | 同上，`renderToolbar` | 可选：一键把当前文献加入术语库 |
| 条目列表自定义列 | `Zotero.ItemTreeManager` 系列 | 可选：给条目加一列「术语数」 |
| 偏好面板 | `Zotero.PreferencePanes.register` | 配置引擎路径、服务端口、目标语言 |
| 通知 | `Zotero.Notifier.registerObserver` | 监听条目与附件变化，自动触发摄取 |

**阅读器为什么必须走 `registerEventListener`**：阅读器界面在 iframe 里，插件无法直接注入 DOM，官方钩子是唯一正路。而且这些事件是**异步**的——弹窗渲染时先 append 一个占位元素，再异步填内容（官方示例就是这么写的）。

### 卸载必须干净

模板用 `ztoolkit.unregisterAll()` 统一撤销菜单、快捷键、列等注册；`Zotero.Reader.registerEventListener` 会随插件卸载自动移除。退出时还要 `delete Zotero[addonInstance]`，避免残留全局对象。

---

## 3. 关键决策：Python 引擎怎么接

引擎是 Python，插件是 JS，两者只能通过进程边界通信。三条路：

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A. 调用 CLI** | 插件用 `Zotero.Utilities.Internal.exec` 执行 `python -m termground <子命令> --json` | **引擎一行不用改**，与「引擎转存档」的定位一致；引擎可独立测试；失败边界清晰 | 每次调用有进程启动开销；拿不到进度；stdout 捕获麻烦（XPCOM 下通常要把输出重定向到文件再读） |
| **B. 常驻本地服务** | 引擎跑已有的 `termground review`，插件用 `Zotero.HTTP.request` 调 REST | 可做进度轮询；浏览器确认界面与插件共用同一份数据；天然支持长任务 | 需要给引擎**新增接口**（现在的服务只有 `/api/state`、`/api/accept`、`/api/reject`）；要处理端口占用与服务未启动 |
| **C. 用 JS 重写引擎** | —— | 没有进程边界 | 不现实：PDF 解析、抽取规则、SQLite 全在 Python，等于重做 |

`Zotero.HTTP.request` 的用法（来自社区文档）：

```javascript
const req = await Zotero.HTTP.request("POST", "http://127.0.0.1:8765/api/resolve", {
  data: { term: "交叉定位" },
  headers: { "Content-Type": "application/json" },
  responseType: "json",
});
```

### 推荐：A 起步，B 作为第二步

理由是**引擎仓库已经定为验证存档、后续只开发插件**：

- 方案 A 完全不需要动引擎。`resolve`、`check`、`evaluate` 都已经有 `--json`，插件的核心查询功能可以直接消费结构化结果。
- 引擎真正缺的只有 `ingest` 与 `stats` 的 `--json`。如果要做，那应该是一次**明确标记的、最后的最小改动**，而不是顺手改一批。
- 等到确实需要「摄取长任务的进度条」或「插件内嵌确认界面」时再切到方案 B。那时给引擎加一个 `termground serve` 是边界清晰、可单独测试的改动。

### 引擎调用契约（A、B 都适用）

插件必须显式传这几样，不能依赖工作目录：

| 项 | 为什么 |
|---|---|
| `--db <绝对路径>` | 引擎默认用相对路径 `data/termground.db`，而 Zotero 进程的工作目录不是插件目录 |
| 引擎仓库的绝对路径 | 由用户在偏好里配置；插件启动前检测它是否存在，不存在就给出可执行的提示 |
| 超时与错误分类 | 要区分「引擎没装」「PDF 解析失败」「该术语未收录」——最后一种不是错误，是本工具的正常结论 |

---

## 4. 最小可用插件：功能与引擎的映射

| 插件入口 | 引擎调用 | 引擎现状 |
|---|---|---|
| 阅读器划词「查术语」 | `resolve <选中文字> --json` | **有，可直接用** |
| 工具菜单「打开确认界面」 | 启动 `review` 服务并打开浏览器 | **有，可直接用**（复用现有页面，不重写 UI） |
| 工具菜单「导出术语表」 | `export <out> --format pair --target-lang en-US` | **有，可直接用** |
| 条目右键「加入术语库」 | `ingest <pdf路径>` | 有，但没有 `--json`，只能解析文本输出或先只报成功 |
| 条目面板「本文献的术语」 | 按文献列术语对 | 需要新查询（现有 `resolve` 是**按术语查**，不是按文献列） |

**划词查术语是最值得先做的一个**：引擎侧零改动，价值最直观。读者在 PDF 里选中一个中文术语，弹窗里直接显示库里既有的英文表述、可信度分级和出处——哪篇文献的哪一句。这正好把「错误自信比不会答更致命」这条原则落到用户眼前：查不到时它明说未收录，而不是编一个。

---

## 5. 落地时必须避开的坑

1. **PDF 路径要从附件子条目取**：条目是父项，PDF 是 attachment 子项，流程是 `item.getAttachments()` → `Zotero.Items.get(id).getFilePath()`。Zotero 6 以后 PDF 存在 `storage/<8位key>/文件名.pdf`，另外要处理**链接附件**（linked attachment）的情况。
2. **`strict_max_version` 不改就装不上**（见 1.4）。
3. **划词弹窗是异步的**：先 append 占位元素再填内容，不要在渲染回调里同步阻塞发请求。
4. **长任务不能卡界面**：一篇 PDF 的摄取要几秒到几十秒。要么异步加轮询，要么用 `ztoolkit.ProgressWindow` 给反馈，绝不能让主线程等。
5. **端口与鉴权**：服务只监听 `127.0.0.1`，但本机其他程序也能访问。若要收紧，可以在启动时生成随机 token 存进偏好，请求时带上。
6. **命名空间要一次改干净**：`package.json` 的 `config` 块里五个占位符都得换，否则 `chrome://` 资源路径、FTL 前缀、偏好前缀会互相打架。

| 占位符 | 模板值 | 应改为 |
|---|---|---|
| `addonName` | Zotero Plugin Template | TermGround（待定） |
| `addonID` | addontemplate@euclpts.com | 唯一的邮箱式 ID |
| `addonRef` | addontemplate | termground（小写，用于 chrome:// 与 FTL 前缀） |
| `addonInstance` | AddonTemplate | TermGround（挂在 Zotero 上的全局对象名） |
| `prefsPrefix` | extensions.zotero.addontemplate | extensions.zotero.termground |

7. **模板的示例代码要清掉**：`src/modules/examples.ts` 有 800 多行演示（额外列、对话框、快捷键、剪贴板、右键菜单……），`hooks.ts` 里逐个调用它们。留着会让调试输出充满噪声，也会在 Zotero 界面上多出一堆无意义的菜单项。

---

## 6. 建议的实施顺序

1. 改五个占位符与 `strict_max_version`，清掉示例代码，跑通一次空的 `npm start`——确认能在 Zotero 10 里加载、并且卸载干净。
2. 做**阅读器划词查术语**：引擎零改动，价值最直观，同时把整条通信链路验证掉。
3. 做条目右键「加入术语库」，处理 PDF 路径与长任务的反馈。
4. 做条目面板「本文献的术语」。
5. 视需要再决定是否推进到方案 B（给引擎加服务接口）。

---

## 7. 待确认

| # | 问题 | 影响 |
|---|---|---|
| 1 | 引擎仓库是否真的冻结？`ingest` 与 `stats` 要不要补 `--json` | 决定第 3 节选 A 还是 A+B |
| 2 | 插件的产品名与 `addonID` 取什么 | 决定第 5 节第 6 条的五个占位符取值 |
| 3 | 第一版是否只做「划词查术语」 | 决定第 6 节的实施顺序 |
