# TermGround

TermGround 是一款面向学术阅读与翻译的 Zotero 本地术语库插件。它可以从文献 PDF 中提取带出处的中英术语，让用户在 Zotero 内完成审核、检索和维护，并把确认后的译名提供给 PDF2zh 及 Translate for Zotero 的 CNKI 翻译服务，从而提高专业术语的一致性。

术语库、证据和备份均保存在本机 Zotero 数据目录。TermGround 不会把完整术语库上传到第三方服务。

当前版本：**0.3.0**

> 当前插件清单允许 Zotero 7–10。Translate for Zotero 的 CNKI 适配按 2.4.7 版本实现，目前属于实验性功能。

## 核心功能

### 从文献建立术语库

- 从选中的 Zotero 条目或 PDF 附件读取文本层；
- 识别作者括注、中英关键词、英文全称与缩写等术语线索；
- 保存英文、中文、缩写、置信度、文献、页码、章节和原文证据；
- 高置信度结果自动入库，不确定结果进入人工审核队列。

### 在 Zotero 内管理术语

- 提供独立的术语库管理器；
- 支持浏览、搜索、状态与来源筛选、表头排序和分页；
- 支持人工新建、编辑、单条删除和批量删除；
- 可查看每条术语对应的来源文献和证据原句；
- 修改前自动备份，当前窗口内可以撤销最近一次删除。

### 协助文献翻译

- 自动生成 PDF2zh 可读取的 `pdf2zh-glossary.csv`；
- 在 Translate for Zotero 2.4.7 的 CNKI 模式下保护命中术语；
- 翻译完成后恢复为术语库指定的中文译名；
- 英文匹配不区分大小写，术语重叠时优先采用较长词组；
- 人工确认的译名具有更高优先级。

## 工作流程

```text
Zotero PDF
   ↓
术语规则提取
   ↓
高置信度术语入库 ── 不确定候选人工确认
   ↓
terms.json
   ├── pdf2zh-glossary.csv → PDF2zh（需另行配置读取）
   └── 术语保护 → Translate for Zotero / CNKI
```

## 安装

1. 从 GitHub Releases 下载最新 `.xpi`。
2. 打开 Zotero 的“工具 → 插件”。
3. 点击齿轮按钮，选择“从文件安装插件”。
4. 选择下载的 XPI，完成安装后重新启动 Zotero。

升级不会主动删除已有术语库，但仍建议先备份 Zotero 数据目录中的 `termground` 文件夹。

## 使用

### 提取术语

1. 在 Zotero 中选中一个或多个文献条目，也可以直接选中 PDF 附件。
2. 右键选择“提取术语（TermGround）”。
3. 等待进度提示完成。

TermGround 当前主要从含明确中英对照的文献中学习术语。纯英文论文如果只出现“英文全称（缩写）”，会形成需要人工补充中文的候选，而不会自动创造中文译名。

### 审核候选

右键选择“待确认候选（TermGround）”，然后根据证据选择入库、修正、补充、拒绝或跳过。

### 查看统计

右键选择“术语库统计”，可查看术语、证据、文献和待确认候选数量，以及数据文件位置。

### 管理术语库

从 Zotero“工具 → TermGround 术语库”打开管理器，也可以在条目上右键选择“TermGround 术语库”。管理器支持：

- 对英文、中文和缩写进行全库搜索；
- 按状态、来源筛选，并按表头排序；
- 查看术语对应的文献证据；
- 人工新建或修改术语；
- 选择当前页或多条术语后批量删除；
- 在窗口关闭前撤销最近一次删除。

每次保存或删除都会重新生成 PDF2zh CSV。Translate for Zotero 的 CNKI 适配会在下一次翻译时读取更新后的术语库。

## Translate for Zotero + CNKI

CNKI 没有术语表参数。TermGround 因此采用翻译前保护、翻译后恢复的适配方式：

```text
英文文本 → 匹配术语 → 临时保护 → CNKI 翻译 → 恢复指定中文译名
```

配置方法：

1. 安装并启用 Translate for Zotero 2.4.7。
2. 将文本翻译服务设置为 `CNKI`，目标语言设置为简体中文。
3. 建议开启 CNKI 的“超过 800 字符自动拆分翻译”。
4. 在 TermGround 设置中开启插件，并勾选 CNKI 术语协助。
5. 重新启动 Zotero。

注意：这是基于 Translate for Zotero 内部服务对象的兼容层。对方插件升级后，如果内部结构发生变化，TermGround 适配也需要同步更新。

## PDF2zh

TermGround 每次保存术语库时都会生成：

```text
Zotero数据目录/termground/pdf2zh-glossary.csv
```

格式：

```csv
source,target,tgt_lng
"Automated Machine Learning","自动化机器学习","zh-CN"
```

TermGround **不会自行修改标准 PDF2zh 安装**。用户需要让 PDF2zh 读取该 CSV，并选择支持外部 glossary 的翻译引擎。Bing、Google、DeepL 等不读取外部 glossary 的服务不会仅因文件存在而使用这些术语。

## 数据文件

```text
Zotero数据目录/termground/terms.json
Zotero数据目录/termground/pdf2zh-glossary.csv
Zotero数据目录/termground/backups/terms-时间戳.json
```

`terms.json` 包含术语、证据、候选和处理过的文献记录。建议定期备份整个 `termground` 文件夹。

## 术语冲突优先级

同一英文术语存在多个译名时，当前依次优先：

1. 人工审核或人工修改的译名；
2. 状态为 `verified` 的译名；
3. 状态为 `attested` 的译名；
4. 同优先级下置信度较高的译名。

当前术语库是全局库，尚未按学科或项目隔离。同一缩写在不同领域含义不同时，需要人工检查。

## 隐私

术语提取和术语库存储在本地进行。使用在线翻译时：

- CNKI 会收到当前待翻译文本以及当前文本中命中的术语，不会收到完整 `terms.json`；
- PDF2zh 是否上传文本取决于所选翻译引擎；
- 处理敏感、未公开或受保密约束的文献前，请确认服务商政策和单位规定。

## 已知限制

- 扫描 PDF 或损坏的文本层无法可靠提取；
- 自动提取仍可能产生错误边界、错误缩写或多义词；
- CNKI 可能改写临时保护标记，极少数术语可能恢复失败；
- CNKI 单次文本长度约 800 字符，长文本依赖 Translate for Zotero 拆分；
- CNKI 请求过快可能触发验证码或临时限制；
- 错误术语一旦入库，可能被翻译适配强制采用，因此人工审核很重要。

## 开发与验证

```bash
npm install
npm run build
npm run lint:check
node --test test-unit/*.test.ts
```

v0.3.0 已通过 TypeScript 类型检查、代码规范检查、构建检查和 56 项单元测试。当前尚未建立 Zotero + Translate for Zotero + CNKI 的自动化端到端测试。

## 详细文档

- [TermGround 中文插件说明](doc/TermGround-0.2.0-插件说明.md)
- [Zotero 插件架构与最佳实践](doc/zotero插件架构与最佳实践.md)

## 版本

- `v0.0.1`：原始版本留档；
- `v0.1.0`：增加 PDF2zh CSV 术语表协作；
- `v0.2.0`：增加 Translate for Zotero 2.4.7 的实验性 CNKI 术语保护；
- `v0.2.1`：补充 pnpm 锁文件和包管理器声明；
- `v0.2.2`：尝试声明构建链依赖脚本许可；
- `v0.2.3`：将 pnpm 构建许可迁移至工作区配置；
- `v0.2.4`：改用 pnpm 11 的 `allowBuilds` 安全策略，修复 GitHub Actions。
- `v0.3.0`：新增完整术语库管理器、稳定术语 ID、证据关联、自动备份和旧数据迁移。

## 许可证

[AGPL-3.0-or-later](LICENSE)
