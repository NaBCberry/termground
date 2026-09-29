# TermGround

[![zotero target version](https://img.shields.io/badge/Zotero-7-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

TermGround is a [Zotero](https://www.zotero.org/) plugin that grows a Chinese–English term base out of the PDFs you already keep in your library. It reads the papers' own bilingual glosses and keyword lists, keeps the sentence each term pair came from as evidence, and gives you a manager window to review candidates, inspect provenance, and export the result.

[English](README.md) | [简体中文](doc/README-zhCN.md)

- Documentation for plugins development
  - [📖 Plugin Development Documentation](https://zotero-chinese.com/plugin-dev-guide/) (Chinese, not yet complete)
  - [📖 Plugin Development Documentation for Zotero 7](https://www.zotero.org/support/dev/zotero_7_for_developers)
- Tools for plugins development
  - [🛠️ Zotero Plugin Toolkit](https://github.com/windingwind/zotero-plugin-toolkit) | [API Documentation](https://github.com/windingwind/zotero-plugin-toolkit/blob/master/docs/zotero-plugin-toolkit.md)
  - [🛠️ Zotero Plugin Scaffold](https://github.com/northword/zotero-plugin-scaffold)
  - [ℹ️ Zotero Type Definitions](https://github.com/windingwind/zotero-types)
  - [📜 Zotero Source Code](https://github.com/zotero/zotero)
  - [📌 Zotero Plugin Template](https://github.com/windingwind/zotero-plugin-template) (this repo is built on it)

> [!tip]
> 👁 Watch this repo so that you can be notified whenever there are fixes & updates.

## Features

- **The PDFs are the source, not a dictionary.** Term pairs come from what the author actually wrote, so every entry can be traced back to the sentence that introduced it.
- **Four extraction rules**, each with its own confidence:
  - author glosses — `超宽带（Ultra-Wideband, UWB）`;
  - English-first glosses — `Ultra-Wideband（超宽带）`;
  - the bilingual keyword list Chinese journals require — zipped pairwise by position;
  - a noun-phrase frequency pass over domain suffixes (`…算法`, `…精度`), kept as a review queue rather than silently discarded.
- **Nothing enters the base unreviewed by rules or by you.** Candidates scoring ≥ `0.8` are promoted automatically; the rest (≥ `0.4`) stay open in a review queue instead of being thrown away.
- **Evidence is data, not decoration.** Every pair carries quote, page, section, source rule, confidence and ingest time; a pair a human rewrote is downgraded to `suggested` because its original quote no longer matches it verbatim.
- **A manager window** (Tools → TermGround Term Library) with pending / term-base / documents views, bilingual search (`Ctrl K`), drift grouping, CSV export and one-click diagnostics.
- **Plain JSON on disk**, under `termground/terms.json` in Zotero's data directory — no extra database tables, nothing that Zotero upgrades can break.
- **Unit-testable rule set.** All text and extraction logic is pure TypeScript with no Zotero API in sight, exercised by 48 unit tests.

## How it works

```
item selection ──▶ PDF text layer ──▶ pages ──▶ blocks ──▶ sentences ──▶ candidates
   (menu)          (PDFWorker)     (form feed)  (sections)              │
                                                                       ├─ score ≥ 0.8 ─▶ term base (auto)
                                                                       └─ score ≥ 0.4 ─▶ pending queue ─▶ human review
                                                                                                             │
                                                                                    manager window ◀─────────┘
```

Pressing **Extract terms (TermGround)** on the item menu:

1. expands the selection into the PDF attachments it can actually read (max one item at a time; a second click while a run is in flight is refused);
2. pulls the text layer through Zotero's own `PDFWorker.getFullText()`, so page boundaries arrive as form feeds and no PDF parsing of our own is needed;
3. normalises what the text layer leaves behind — spaces injected between every pair of CJK glyphs, hyphenated English wraps, full-width punctuation;
4. detects section headings while splitting a page into blocks, so evidence is labelled `abstract_zh`, `keywords_en`, `method`, `references`, …;
5. runs the four rules, then splits candidates by score and deduplicates into the store.

Extraction is the only thing that ever writes automatically, and it never overwrites a decision: a candidate you rejected stays rejected when re-encountered, even though it keeps counting how often it was seen.

### Extraction rules

| Rule                | Accepts                                   | Confidence                   | Where it lands            |
| ------------------- | ----------------------------------------- | ---------------------------- | ------------------------- |
| `author_note`       | `中文术语（English Term, ABBR）`          | 0.95 certain / 0.6 uncertain | verified pair, if certain |
| `english_note`      | `English Term（中文术语）`                | 0.9                          | verified pair             |
| `bilingual_keyword` | `关键词` list zipped with `Keywords` list | 0.88                         | verified pair             |
| `zh_np_frequency`   | domain-suffix noun phrases seen ≥ 2 times | ≤ 0.6                        | pending only              |

Boundary recovery is where most of the care went: `已有研究广泛采用超宽带（Ultra-Wideband, UWB）` must yield `超宽带`, not the whole run before the bracket. A term already in the base is the most reliable cut; otherwise leading verbs and connectives (`提出`, `采用`, `基于`, …) are stripped and the result is marked uncertain if the cut is not provably clean. Candidates are then filtered — fragmented Latin (`dist rib ut ed`), journal boilerplate (`中图分类号`), section headings, grant numbers, over-long glued words (`Pathplanningalgorithm`) and stopword pairs are all rejected, and the count of what was dropped is reported instead of being hidden.

## Examples

### Item menu

| Menu entry                      | What it does                                                 |
| ------------------------------- | ------------------------------------------------------------ |
| `Extract terms (TermGround)`    | Extracts from the selected item(s) and their PDF attachments |
| `Manage term base (TermGround)` | Opens the manager window                                     |

Both live on the item context menu; the manager also has a library-wide entry under **Tools → TermGround Term Library**, because the term base is not tied to a selection. Labels are localized (`addon/locale/<lang>/addon.ftl`), so a Chinese UI shows `提取术语（TermGround）` and `术语库管理（TermGround）`.

### Manager window

> 🖼 The window started life as a standalone prototype: open [`doc/ui-prototype/termground-manager.html`](doc/ui-prototype/termground-manager.html) in a browser to see the intended layout without starting Zotero.

Three views, all fed by `addon.api.manager` (defined in `src/modules/managerWindow.ts`), which fresh-loads the store per call so the window and the extraction flow can never overwrite each other:

- **待确认 · Pending** — candidates the rules were not confident enough to store. Each card shows the reason it was kept, the score, the full quote with page and section, and editable Chinese/English fields. `Enter` accepts and moves on, `R` rejects, `S` skips, and low-score candidates can be bulk-rejected. Acceptance is a deliberate human act: an edited pair is stored as `suggested` with source `human_review`.
- **术语库 · Term base** — every pair with its status, source rule and evidence count. Evidence expands inline. A **漂移分组视图** toggle groups Chinese concepts that have more than one English rendering, which is the actual failure mode of a growing term base; the tool presents the alternatives and refuses to pick one for you.
- **文献 · Documents** — the papers already ingested, with pages read, candidates found, pairs promoted and when.
- **Export** — copies the whole base to the clipboard as CSV (`en,zh,role,status`) for a translation workflow.
- **Diagnostics** — writes a rendering/environment report to a file next to the running plugin, because the failure mode this window actually had was "controls do not show up", and neither the debug log nor the clipboard is any use when the interface itself is the thing under suspicion.

### Preference pane

The pane is deliberately thin: it shows where the term base file lives, so you can back it up or open it, plus the build stamp. See [`addon/content/preferences.xhtml`](./addon/content/preferences.xhtml) and [`src/modules/preferenceScript.ts`](./src/modules/preferenceScript.ts).

> [!note]
> The `extensions.zotero.termground.enable` switch is present in the pane and in `addon/prefs.js`, but no code path reads it yet — extraction is always on. It is listed here so nobody assumes it is wired up.

## Quick Start Guide

### 0 Requirement

1. Install a beta version of Zotero: <https://www.zotero.org/support/beta_builds>
2. Install [Node.js latest LTS version](https://nodejs.org/en/) and [Git](https://git-scm.com/)

> [!note]
> Node.js **≥ 22.8.0** is required by `zotero-plugin-scaffold`; the unit tests run `.ts` files directly and CI pins Node 24.
>
> This guide assumes a basic understanding of how a Zotero plugin is structured. If you don't have one, read the [documentation](https://www.zotero.org/support/dev/zotero_7_for_developers) and the official [Make It Red](https://github.com/zotero/make-it-red) example first — and see [`doc/zotero插件架构与最佳实践.md`](doc/zotero插件架构与最佳实践.md) for a Chinese walkthrough of the same material.

### 1 Clone the repo

```sh
git clone https://github.com/NaBCberry/termground.git
cd termground
```

### 2 Configure settings and environment

1. The settings in `./package.json` are already the real ones for this plugin — check them before you change anything:

   ```jsonc
   {
     "version": "0.1.0",
     "description": "TermGround Plugin",
     "config": {
       "addonName": "TermGround Plugin", // name shown in the plugin manager
       "addonID": "nabc_zhou@tianyi.ink", // ID to avoid conflict. IMPORTANT!
       "addonRef": "termground", // e.g. element ID prefix
       "addonInstance": "TermGround", // the plugin's root instance: Zotero.TermGround
       "prefsPrefix": "extensions.zotero.termground", // the prefix of prefs
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
   > If you fork this for your own plugin, change `addonID` and `addonRef` — they must not collide with another install.

   The XPI download link and the update URL are derived from these values in `zotero-plugin.config.ts`; the manifest (`addon/manifest.json`) interpolates them at build time, so nothing there needs editing by hand.

2. Copy the environment variable file and point it at your Zotero binary and development profile:

   > Create a development profile (optional). Start the beta Zotero with `/path/to/zotero -p`, create a new profile and use it as your development profile. Do this only once.

   ```sh
   cp .env.example .env
   vim .env
   ```

   If you develop more than one plugin, you can store the bin path and profile path in the system environment variables and leave this file alone.

3. Install dependencies with `npm install`

   > If you use `pnpm`, add `public-hoist-pattern[]=*@types/bluebird*` to `.npmrc`, see <https://github.com/windingwind/zotero-types?tab=readme-ov-file#usage>.
   >
   > If `npm install` fails with `npm ERR! ERESOLVE unable to resolve dependency tree` (an upstream typescript-eslint issue), use `npm i -f`.
   >
   > `package-lock.json` is committed on purpose: CI installs with `npm ci`.

### 3 Coding

Start the development server with `npm start`, it will:

- Prebuild the plugin in development mode;
- Start Zotero with the plugin loaded from `build/`;
- Watch `src/**` and `addon/**`, rebuild and reload the plugin in Zotero when source code changes.

#### Auto Hot Reload

Tired of endless restarting? Forget about it!

1. Run `npm start`.
2. Coding. (Yes, that's all)

When file changes are detected in `src` or `addon`, the plugin will be automatically compiled and reloaded.

<details style="text-indent: 2em">
<summary>💡 Steps to add this feature to an existing plugin</summary>

Please see [zotero-plugin-scaffold](https://github.com/northword/zotero-plugin-scaffold).

</details>

#### Debug in Zotero

You can also:

- Test code snippets in Tools -> Developer -> Run Javascript;
- Debug output with `Zotero.debug()`. Find the outputs in Help -> Debug Output Logging -> View Output;
- Debug UI. Zotero is built on the Firefox XUL framework. Debug XUL UI with software like [XUL Explorer](https://udn.realityripple.com/docs/Archive/Mozilla/XUL_Explorer).
  > XUL Documentation: <http://www.devdoc.net/web/developer.mozilla.org/en-US/docs/XUL.html>

This plugin's own debugging aids, in the order they are usually needed:

| Symptom                                         | Where to look                                                                                   |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Nothing happens on extract                      | Progress window text, then `termground extract report` in the debug log                         |
| Extract reports skips                           | The report's `skipped[]` — most often "no text layer" (scanned PDF without OCR)                 |
| Extraction succeeded, term base looks wrong     | `termground/terms.json` in the Zotero data directory; the preference pane prints the exact path |
| Manager window shows nothing / controls missing | **导出诊断** in the window footer — writes the report next to the plugin source                 |

### 4 Build

Run `npm run build` to build the plugin in production mode (`zotero-plugin build && tsc --noEmit`). The build output is located in the `.scaffold/build/` directory.

For detailed build steps, refer to the [zotero-plugin-scaffold documentation](https://northword.github.io/zotero-plugin-scaffold/build.html). In short, the process can be divided into the following steps:

- Create or clear the `build/` directory
- Copy `addon/**` to `.scaffold/build/addon/**`
- Replace placeholders: substitute keywords and configurations defined in `package.json`
- Prepare localization files to avoid conflicts (see [zotero_7_for_developers](https://www.zotero.org/support/dev/zotero_7_for_developers#avoiding_localization_conflicts) for more information):
  - Rename `**/*.flt` to `**/${addonRef}-*.flt`
  - Prefix each message with `addonRef-`
  - Generate type declaration files for FTL messages
- Prepare preferences files: prefix preference keys with `package.json#prefsPrefix` and generate type declaration files for preferences
- Use ESBuild to compile `.ts` source code to `.js`, building from `src/index.ts` to `.scaffold/build/addon/content/scripts`
- _(Production mode only)_ Compress the `.scaffold/build/addon` directory into `.scaffold/build/*.xpi`
- _(Production mode only)_ Prepare `update.json` or `update-beta.json`

> [!note]
>
> **What's the difference between dev & prod?**
>
> - This environment variable is stored in `Zotero.${addonInstance}.data.env`. The outputs to console is disabled in prod mode.
> - You can decide what users cannot see/use based on this variable.
> - In production mode, the build script will pack the plugin and update the `update.json`.

### 5 Test

```sh
npm run test:unit   # 48 rule/store unit tests, plain Node (node:test), no Zotero needed
npm run test        # headless Zotero integration test (test/)
```

`test-unit/` covers the pure logic in `src/modules/textUtils.ts`, `src/modules/termExtract.ts` and `src/modules/termStore.ts` — that is the reason those files take a `Set<string>` of known terms instead of reaching into Zotero. `test/` boots a real Zotero through the scaffold and asserts the plugin instance is alive.

### 6 Release

To build and release, use

```shell
# version increase, git add, commit and push
# then on ci, npm run build, and release to GitHub
npm run release
```

> 📖 本仓库的代码检查、构建、自动发布与 `update.json` 机制的完整说明（含本地 bump 与 Actions 一键发布两条主线）见 [doc/release.md](doc/release.md)。

> [!note]
> This will use [Bumpp](https://github.com/antfu-collective/bumpp) to prompt for the new version number, locally bump the version, run any (pre/post)version scripts defined in `package.json`, commit, build (optional), tag the commit with the version number and push commits and git tags. Bumpp can be configured in `zotero-plugin.config.ts`; for example, add `release: { bumpp: { execute: "npm run build" } }` to also build before committing.
>
> Subsequently GitHub Action will rebuild the plugin and use `zotero-plugin-scaffold`'s `release` script to publish the XPI to GitHub Release. In addition, a separate release (tag: `release`) will be created or updated that includes update manifests `update.json` and `update-beta.json` as assets. These will be available at `https://github.com/{{owner}}/{{repo}}/releases/download/release/update*.json`.

#### About Prerelease

The build script defines `prerelease` as the beta version of the plugin: when you pick a `prerelease` version in Bumpp (a `-` in the version number), only `update-beta.json` is refreshed, which ensures that users of the regular version won't be able to update to the beta. Only users who have manually downloaded and installed the beta will be able to update to the next beta automatically.

When the next regular release is updated, both `update.json` and `update-beta.json` will be updated (on the special `release` release, see above) so that both regular and beta users can update to the new regular release.

This repo also ships `.github/workflows/release-manual.yml`, which performs the whole bump → commit → tag → publish sequence from the Actions UI for people who would rather not run commands locally.

> [!warning]
> Strictly, distinguishing between Zotero 6 and Zotero 7 compatible plugin versions should be done by configuring `applications.zotero.strict_min_version` in `addons.__addonID__.updates[]` of `update.json` respectively, so that Zotero recognizes it properly, see <https://www.zotero.org/support/dev/zotero_7_for_developers#updaterdf_updatesjson>.

## Details

### About Hooks

> See also [`src/hooks.ts`](./src/hooks.ts)

1. When install/enable/startup triggered from Zotero, `bootstrap.js` > `startup` is called
   - Wait for Zotero ready
   - Load `index.js` (the main entrance of plugin code, built from `index.ts`)
   - Register resources if Zotero 7+
2. In the main entrance `index.js`, the plugin object is injected under `Zotero` and `hooks.ts` > `onStartup` is called.
   - This plugin's `onStartup` initialises the locale, builds the manager API (`setupManagerWindow`), registers the preference pane, and then runs `onMainWindowLoad` for every main window.
3. When uninstall/disabled triggered from Zotero, `bootstrap.js` > `shutdown` is called.
   - `hooks.ts` > `onShutdown` is called: UI elements registered through `ztoolkit` are unregistered, the manager window is closed, and the plugin instance is deleted from `Zotero`.

Hooks only dispatch. Business logic lives in the modules next to them (`terminology.ts`, `managerWindow.ts`, `termPipeline.ts`, …), because a hook that does real work becomes very hard to maintain.

### About the data model

> See also [`src/modules/termStore.ts`](./src/modules/termStore.ts)

The base is a single JSON file, `termground/terms.json` under `Zotero.DataDirectory.dir`:

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

Three decisions worth knowing about:

- **A plugin-owned file, not new Zotero tables.** No schema coupling, it survives Zotero upgrades untouched, and thousands of pairs fit comfortably in memory.
- **Path separators are taken from `Zotero.DataDirectory.dir` itself.** Mozilla's file APIs reject a mixed `C:\…\Zotero` + `/termground/terms.json` pair with `NS_ERROR_FILE_UNRECOGNIZED_PATH`.
- **Evidence accumulates even for pairs already known.** A repeated term does not create a duplicate pair, but it does add evidence — which is what makes drift (`一个中文概念，多种英文写法`) visible instead of silently first-wins.

### About Global Variables

> See also [`src/index.ts`](./src/index.ts)

The bootstrapped plugin runs in a sandbox, which does not have default global variables like `Zotero` or `window`, which we used to have in the overlay plugins' window environment.

This template registers the following variables to the global scope:

```plain
Zotero, ZoteroPane, Zotero_Tabs, window, document, rootURI, ztoolkit, addon;
```

`addon.data.env` (`"development"` / `"production"`) is injected at build time and is the only environment switch; `addon.api.manager` is the surface the manager window script calls.

### Create Elements API

The plugin uses `ztoolkit`'s element APIs rather than raw `createElement/createElementNS`:

- In bootstrap mode, plugins have to clean up all UI elements on exit (disable or uninstall), which is very annoying. Using `createElement`, the plugin template will maintain these elements. Just `unregisterAll` at the exit.
- Zotero 7 requires createElement()/createElementNS() → createXULElement() for remaining XUL elements, while Zotero 6 doesn't support `createXULElement`. The React.createElement-like API `createElement` detects namespace(xul/html/svg) and creates elements automatically, with the return element in the corresponding TS element type.

```ts
createElement(document, "div"); // returns HTMLDivElement
createElement(document, "hbox"); // returns XUL.Box
createElement(document, "button", { namespace: "xul" }); // manually set namespace. returns XUL.Button
```

The manager window is the one exception: it is its own chrome window loading `addon/content/manager.xhtml` plus a plain `manager.js`, and it builds nodes in that window's own document.

### About Zotero API

Zotero docs are outdated and incomplete. Clone <https://github.com/zotero/zotero> and search the keyword globally.

> ⭐The [zotero-types](https://github.com/windingwind/zotero-types) provides the most frequently used Zotero APIs. It's included in this plugin by default. Your IDE would provide hint for most of the APIs.

A trick for finding the API you want:

Search the UI label in `.xhtml`/`.flt` files, find the corresponding key in locale file. Then search this keys in `.js`/`.jsx` files.

Two calls this plugin depends on and that are not obvious from the docs:

- `Zotero.PDFWorker.getFullText(attachmentID, null)` — the PDF text layer, with a form feed between pages;
- `Services.ww.openWindow(...)` + `Services.scriptloader.loadSubScript(...)` — opening the manager window and loading its script, with the plugin API injected into the window scope _before_ that script runs (neither `window.arguments` nor a `Zotero` global is available there).

### Directory Structure

- All `.js/.ts` code files are in `./src`;
- Addon config files: `./addon/manifest.json`;
- UI files: `./addon/content/*.xhtml`;
- Locale files: `./addon/locale/**/*.flt`;
- Preferences file: `./addon/prefs.js`;
- Docs and the UI prototype: `./doc`;
- Unit tests (pure logic) in `./test-unit`, headless Zotero integration test in `./test`.

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
|   |   |-- manager.xhtml      # term-base manager window
|   |   |-- manager.css
|   |   |-- manager.js         # window script (talks to addon.api.manager)
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
|   |-- release.md             # CI & release pipeline
|   |-- zotero插件架构与最佳实践.md
|   `-- ui-prototype
|       `-- termground-manager.html
|-- src                        # source code of scripts
|   |-- addon.ts               # base class (+ addon.api.manager)
|   |-- hooks.ts               # lifecycle hooks (dispatch only)
|   |-- index.ts               # main entry
|   |-- modules
|   |   |-- terminology.ts     # item menu: extract / open manager
|   |   |-- termPipeline.ts    # items -> PDF text -> segments
|   |   |-- termExtract.ts     # the four extraction rules
|   |   |-- textUtils.ts       # pure text helpers
|   |   |-- termStore.ts       # the JSON term base
|   |   |-- managerWindow.ts   # window host + manager API
|   |   `-- preferenceScript.ts
|   `-- utils                  # utilities
|       |-- locale.ts
|       |-- prefs.ts
|       |-- wait.ts
|       |-- window.ts
|       `-- ztoolkit.ts
|-- test                       # headless Zotero integration test
|-- test-unit                  # unit tests for the pure rule set
|-- typings                    # ts typings
|   `-- global.d.ts
|-- .env                       # enviroment config (do not check into repo)
|-- .env.example               # template of enviroment config
|-- .gitignore                 # git conf
|-- .gitattributes             # git conf
|-- .gitmessage                # commit message template
|-- .prettierignore            # prettier ignore
|-- eslint.config.mjs          # eslint conf, https://eslint.org/
|-- LICENSE
|-- package-lock.json
|-- package.json
|-- tsconfig.json              # typescript conf
|-- README.md
`-- zotero-plugin.config.ts    # scaffold conf, https://github.com/northword/zotero-plugin-scaffold
```

## Roadmap / Known limits

- The `enable` preference is not read by any code path yet (see the note above).
- Rule tuning is currently justified by tests and by domain-suffix lists (`DOMAIN_SUFFIXES`); there is no per-user term-list import yet.
- Chinese-side boundary recovery falls back to a length-capped heuristic when no known term matches, and marks the result uncertain rather than guessing silently — those candidates always need a human.
- Languages: the extraction rules target Chinese papers with English glosses. Other language pairs are out of scope for now.

## Disclaimer

Use this code under AGPL. No warranties are provided. Keep the laws of your locality in mind!

This plugin is built on the [Zotero Plugin Template](https://github.com/windingwind/zotero-plugin-template); the template's own documentation and community list apply to its upstream repo, not to this one.
