/*
 * TermGround 管理窗口脚本。
 *
 * 由 managerWindow.ts 通过 Services.scriptloader.loadSubScript 注入窗口作用域，
 * 数据一律经 api（addon.api.manager）读写，不直接触碰存储层。
 *
 * 两条硬规则，都是被真实故障换来的：
 *
 * 1) 本窗口是 application/xhtml+xml 文档，innerHTML 走严格 XML 片段解析，
 *    PDF 引文里一个非法字符就能让整段赋值抛错、容器渲染归零。所以这里
 *    一律用 createElementNS 建节点，不拼标记字符串——不是"过滤得更干净"，
 *    而是根本不经过解析器。
 *
 * 2) 任何一步失败都要在窗口里留下可见痕迹。以前失败只弹 3.6 秒的 toast，
 *    窗口里什么都留不下，于是"渲染压根没跑"和"渲染跑了但为空"长得一模
 *    一样。现在启动失败写进错误横幅，刷新失败写进列表本身，每一步记进
 *    诊断文件（页脚「导出诊断」按钮也会再写一次并提示文件路径）。
 */
(function () {
  "use strict";

  var XHTML = "http://www.w3.org/1999/xhtml";
  var SVGNS = "http://www.w3.org/2000/svg";
  var STYLESHEET_HREF = "chrome://termground/content/manager.css";

  /* ---------------- 宿主引用解析 ---------------- */
  /*
   * loadSubScript 的自由变量解析路径随宿主而异（裸全局 / 目标窗口属性），
   * 所以先看开窗方传进来的 window.arguments，再逐条兜底。取不到就明确
   * 报错，绝不静默降级成空界面。
   */
  /**
   * 宿主对象（api / Zotero / Services / 诊断路径）的取法。
   *
   * 实测 window.arguments 传进来是空的（一个参数、没有任何键），窗口作用域里
   * 也没有 Zotero，所以这里按可靠性逐条找：开窗方在 load 前挂的
   * window.__TermGroundHost（同时挂在 Xray 包装与 wrappedJSObject 上）优先，
   * 其次是 window.arguments，再是散装属性，最后退回裸全局。
   */
  function hostFrom(target) {
    if (!target) return null;
    try {
      if (target.__TermGroundHost) return target.__TermGroundHost;
    } catch {
      /* 跨 compartment 读取可能抛错 */
    }
    var assembled = {};
    var found = false;
    var mapping = {
      api: "termgroundApi",
      zotero: "termgroundZotero",
      services: "termgroundServices",
      diagnosticsPath: "termgroundDiagnosticsPath",
      basePath: "termgroundBasePath",
    };
    Object.keys(mapping).forEach(function (key) {
      try {
        if (target[mapping[key]] !== undefined) {
          assembled[key] = target[mapping[key]];
          found = true;
        }
      } catch {
        /* 忽略单键读取失败 */
      }
    });
    return found ? assembled : null;
  }

  function resolveHost() {
    var fromArgs =
      window && window.arguments && window.arguments[0]
        ? window.arguments[0]
        : null;
    var injected =
      hostFrom(window) ||
      hostFrom(
        (function () {
          try {
            return window.wrappedJSObject;
          } catch {
            return null;
          }
        })(),
      ) ||
      fromArgs;
    if (injected) return injected;
    return {};
  }

  var launchArgs = resolveHost();

  function resolveGlobal(name) {
    try {
      if (typeof window !== "undefined" && window && window[name]) {
        return window[name];
      }
    } catch {
      /* 跨 compartment 访问可能抛错，继续尝试下一条路径 */
    }
    try {
      return eval(name);
    } catch {
      return null;
    }
  }

  var ZoteroRef = launchArgs.zotero || resolveGlobal("Zotero");
  var ServicesRef = launchArgs.services || resolveGlobal("Services");

  /*
   * 探测 window.arguments 到底长什么样：它可能是 undefined（宿主没填充）、
   * 可能是死包装（取属性即抛），也可能只有部分键。这直接决定诊断文件路径
   * 是否可用，所以启动 trace 里必须能看到真实结论。
   */
  var launchArgsProbe = (function () {
    try {
      if (typeof window === "undefined" || !window) return "no-window";
      var args = window.arguments;
      if (args === undefined) return "undefined";
      if (args === null) return "null";
      return (
        "type=" +
        Object.prototype.toString.call(args) +
        " len=" +
        args.length +
        " keys=[" +
        Object.keys(args).join(",") +
        "] first=" +
        {}.toString.call(args[0])
      );
    } catch (error) {
      return (
        "threw:" + (error && error.message ? error.message : String(error))
      );
    }
  })();

  /**
   * 找到插件的管理接口。
   *
   * 实测：window.arguments 有参数但读不到键、窗口作用域里也没有 Zotero，
   * 所以按可靠性从高到低逐条试，并把命中的通道记下来（诊断里要能看出
   * 到底走的哪条，否则下次还会在同一个地方打转）：
   *
   * 1. 开窗方在 load 前挂到窗口上的 __TermGroundHost.api；
   * 2. 同上的 host.zotero → Zotero.TermGround；
   * 3. host.services 枚举主窗口 → win.Zotero.TermGround；
   * 4. 窗口作用域/arguments 里任何能拿到的 Zotero。
   */
  var apiChannel = "none";

  function apiFrom(root) {
    if (!root || typeof root !== "object") return null;
    var pluginRoot = root.TermGround;
    var manager = pluginRoot && pluginRoot.api ? pluginRoot.api.manager : null;
    if (manager && manager.snapshot) return manager;
    /* 插件实例被直接挂上来的情况：{ data, api } */
    if (root.api && root.api.manager && root.api.manager.snapshot) {
      return root.api.manager;
    }
    return null;
  }

  /** 从主窗口的 Zotero 上取插件实例：只依赖 Services。 */
  function apiFromMainWindow() {
    if (!ServicesRef || !ServicesRef.wm) return null;
    /* getMostRecentWindow 比枚举更可靠，两条都试 */
    try {
      if (ServicesRef.wm.getMostRecentWindow) {
        var recent = ServicesRef.wm.getMostRecentWindow("navigator:browser");
        if (recent && recent !== window) {
          var fromRecent = apiFrom(recent.Zotero);
          if (fromRecent) return fromRecent;
        }
      }
    } catch {
      /* 忽略，继续枚举 */
    }
    try {
      var enumerator = ServicesRef.wm.getEnumerator("navigator:browser");
      while (enumerator.hasMoreElements()) {
        var win = enumerator.getNext();
        if (!win || win === window) continue;
        var found = apiFrom(win.Zotero);
        if (found) return found;
      }
    } catch {
      /* 枚举失败则放弃这条路径 */
    }
    return null;
  }

  function resolveApi() {
    /* 开窗方注入的宿主优先：里面有直接的 api 引用，绕开所有作用域问题 */
    if (launchArgs.api && launchArgs.api.snapshot) {
      apiChannel = "host.api";
      return launchArgs.api;
    }
    var fromZoteroRoot = apiFrom(launchArgs.zotero);
    if (fromZoteroRoot) {
      apiChannel = "host.zotero";
      return fromZoteroRoot;
    }
    if (apiFrom(window)) {
      apiChannel = "window";
      return apiFrom(window);
    }
    var raw = (function () {
      try {
        return window.wrappedJSObject;
      } catch {
        return null;
      }
    })();
    if (apiFrom(raw)) {
      apiChannel = "wrappedJSObject";
      return apiFrom(raw);
    }
    if (apiFrom(window.opener)) {
      apiChannel = "opener";
      return apiFrom(window.opener);
    }
    var fromGlobal = apiFrom(ZoteroRef) || apiFrom(resolveGlobal("Zotero"));
    if (fromGlobal) {
      apiChannel = "global.Zotero";
      return fromGlobal;
    }
    var fromMain = apiFromMainWindow();
    if (fromMain) {
      apiChannel = "mainWindow";
      return fromMain;
    }
    return null;
  }

  var api = resolveApi();

  /* ---------------- 日志与诊断 ---------------- */
  var DIAG = [];

  /**
   * 官方日志通道：Zotero.debug -> Zotero.Debug.log，落到「帮助 -> 输出日志
   * 排错」的输出缓冲区/文本控制台（zotero.js 里 debug() 就是调 Debug.log）。
   * 它受 debug.log / debug.store / debug.level 约束，所以这里只当作"顺手记
   * 一笔"，界面诊断不依赖它。控制台通道是 Zotero.log / Zotero.logError，
   * 也不能替代——两者都不落成 .scaffold/logs 那种 .log 文件。
   */
  function logLine(message) {
    var prefixed = "TermGround[manager] " + message;
    try {
      if (ZoteroRef && ZoteroRef.debug) {
        ZoteroRef.debug(prefixed);
      } else if (typeof Zotero !== "undefined" && Zotero && Zotero.debug) {
        Zotero.debug(prefixed);
      }
    } catch {
      /* 日志通道不可用不影响界面 */
    }
    try {
      if (ZoteroRef && ZoteroRef.Debug && ZoteroRef.Debug.log) {
        ZoteroRef.Debug.log(prefixed);
      }
    } catch {
      /* Zotero.Debug 可能尚未初始化 */
    }
  }

  /** 记一行诊断：进官方日志，同时留给「导出诊断」按钮与诊断文件。 */
  function trace(message) {
    DIAG.push(message);
    if (DIAG.length > 300) {
      DIAG.shift();
    }
    logLine(message);
  }

  /**
   * 日志通道自检：只走官方 API（Zotero.debug / Zotero.Debug.log），避免用
   * console 这类没保证的全局。写完就可以在「输出日志排错」里直接看到结论。
   */
  function probeEnvironment() {
    var parts = [];
    parts.push("api=" + !!api);
    parts.push("hasZotero=" + !!ZoteroRef);
    parts.push("hasZoteroDebug=" + !!(ZoteroRef && ZoteroRef.debug));
    parts.push(
      "hasDebugLogger=" +
        !!(ZoteroRef && ZoteroRef.Debug && ZoteroRef.Debug.log),
    );
    parts.push("hasServices=" + !!ServicesRef);
    parts.push(
      "hasIOUtils=" +
        !!(ServicesRef && ServicesRef.IOUtils && ServicesRef.IOUtils.writeUTF8),
    );
    parts.push(
      "hasSaveFile=" +
        !!(
          ZoteroRef &&
          ZoteroRef.Utilities &&
          ZoteroRef.Utilities.Internal &&
          ZoteroRef.Utilities.Internal.saveFile
        ),
    );
    parts.push("windowArgs=" + launchArgsProbe);
    parts.push("candidates=" + diagnosticsCandidates().join(" | "));
    parts.push("styleSheets=" + document.styleSheets.length);
    parts.push("contentType=" + document.contentType);
    var summary = parts.join(" ");
    trace("probe -> " + summary);
    return summary;
  }

  function errorName(error) {
    return error && error.name ? error.name : "Error";
  }

  function shortError(error) {
    var message = error && error.message ? error.message : String(error);
    return message.length > 120 ? message.slice(0, 120) + "…" : message;
  }

  function styleOf(selector) {
    var node = document.querySelector(selector);
    if (!node || !window.getComputedStyle) return "n/a";
    return window.getComputedStyle(node);
  }

  function diagnosticsText() {
    var cards = document.querySelectorAll("#pending-list .card").length;
    var inputs = document.querySelectorAll("#pending-list input").length;
    var buttons = document.querySelectorAll("#pending-list button").length;
    var topbar = styleOf(".topbar");
    var search = styleOf("#q");
    var host = document.querySelector("#pending-list");
    return [
      "TermGround 管理窗口诊断",
      "contentType=" + document.contentType,
      "styleSheets=" + document.styleSheets.length,
      "topbarPosition=" + (topbar === "n/a" ? topbar : topbar.position),
      "searchBoxShadow=" + (search === "n/a" ? search : search.boxShadow),
      "hasZotero=" + !!ZoteroRef,
      "hasServices=" + !!ServicesRef,
      "hasApi=" + !!api,
      "cards=" + cards + " inputs=" + inputs + " buttons=" + buttons,
      "pendingListText=" + ((host && host.textContent) || "").slice(0, 80),
      "",
      "-- trace --",
    ]
      .concat(DIAG)
      .join("\n");
  }

  /* ---------------- 选择器与 DOM 工具 ---------------- */

  function $(sel, root) {
    return (root || document).querySelector(sel);
  }

  function $$(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  function text(value) {
    return document.createTextNode(
      value === null || value === undefined ? "" : String(value),
    );
  }

  function att(node, name, value) {
    if (value === null || value === undefined || value === false) return node;
    if (value === true) {
      node.setAttribute(name, name);
      return node;
    }
    node.setAttribute(name, String(value));
    return node;
  }

  function appendAll(host, children) {
    if (children === null || children === undefined || children === false) {
      return host;
    }
    var list = Array.isArray(children) ? children : [children];
    list.forEach(function (child) {
      if (child === null || child === undefined || child === false) return;
      host.appendChild(typeof child === "string" ? text(child) : child);
    });
    return host;
  }

  function el(tag, attrs, children) {
    var node = document.createElementNS(XHTML, tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        att(node, key, attrs[key]);
      });
    }
    return appendAll(node, children);
  }

  /** 用节点树替换宿主内容。 */
  function fill(host, children) {
    if (!host) return;
    host.replaceChildren();
    appendAll(host, children);
  }

  function span(className, children) {
    return el("span", { class: className }, children);
  }

  function emptyState(title, message) {
    return el("div", { class: "empty" }, [
      el("div", { class: "t-title" }, title),
      el("p", null, message),
    ]);
  }

  /** 同命名空间图标：直接建 SVG 元素，不经过任何解析。 */
  function svgIcon(size, viewBox, children) {
    var svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("viewBox", viewBox);
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.4");
    svg.setAttribute("aria-hidden", "true");
    return appendAll(svg, children);
  }

  function svgPart(tag, attrs) {
    var node = document.createElementNS(SVGNS, tag);
    Object.keys(attrs).forEach(function (key) {
      node.setAttribute(key, String(attrs[key]));
    });
    return node;
  }

  /* ---------------- 常量 ---------------- */
  var METHOD_LABELS = {
    author_note: "作者自注",
    english_note: "英文自注",
    bilingual_keyword: "中英关键词",
    zh_np_frequency: "词频候选",
  };
  /** 与 termExtract.ts 的 PROMOTE_SCORE 保持一致 */
  var PROMOTE_SCORE = 0.8;
  /** 批量驳回线：低于此分的候选成批出现时值得一次清掉 */
  var BULK_REJECT_BELOW = 0.6;

  var STORE = {
    pairs: [],
    evidence: [],
    items: {},
    pending: [],
    counts: { pairs: 0, evidence: 0, items: 0, verified: 0, pending: 0 },
  };
  var STATE = {
    view: "pending",
    q: "",
    drift: false,
    current: 0,
    docFilter: null,
    expanded: {},
    /* 正在行内编辑的术语 id；null 表示没有 */
    editing: null,
    /* 是否在表格顶部显示「新建术语」那一行 */
    creating: false,
    loading: false,
    loadError: null,
    errorKind: null,
    diagnosticsWritten: false,
    autoSnapshotLogged: false,
  };

  /* ---------------- 派生数据 ---------------- */

  /** 同一中文概念下并列的英文写法数 */
  function driftGroups() {
    var groups = {};
    var order = [];
    STORE.pairs.forEach(function (pair) {
      if (!groups[pair.zh]) {
        groups[pair.zh] = {};
        order.push(pair.zh);
      }
      groups[pair.zh][pair.en] = true;
    });
    return order
      .filter(function (zh) {
        return Object.keys(groups[zh]).length > 1;
      })
      .map(function (zh) {
        return { zh: zh, count: Object.keys(groups[zh]).length };
      });
  }

  /*
   * 证据优先按稳定 ID 关联。术语被人工改写之后，证据行上留的还是改写前的
   * 中英文，按文本比对会当场失联；只有缺 termId 的老数据才退回文本比对。
   */
  function evidenceForPair(pair) {
    return STORE.evidence.filter(function (ev) {
      if (ev.termId && pair.id) return ev.termId === pair.id;
      return ev.en === pair.en && ev.zh === pair.zh;
    });
  }

  function knownConflict(entry) {
    var same = STORE.pairs.filter(function (pair) {
      return pair.zh === entry.zh;
    });
    return same.filter(function (pair) {
      return !entry.en || pair.en !== entry.en;
    });
  }

  function pendingCountForItem(itemKey) {
    return STORE.pending.filter(function (entry) {
      return entry.itemKey === itemKey;
    }).length;
  }

  function itemTitle(itemKey) {
    return STORE.items[itemKey] ? STORE.items[itemKey].title : "";
  }

  /* ---------------- 渲染：错误横幅 ---------------- */

  /** 把失败摆在窗口最上方：界面"少东西"时先看这里。 */
  function renderErrorBanner() {
    var host = $("#error-banner");
    if (!host) {
      trace("renderErrorBanner: #error-banner 缺失");
      return;
    }
    if (!STATE.loadError) {
      host.hidden = true;
      fill(host, null);
      return;
    }
    host.hidden = false;
    fill(host, [
      el(
        "div",
        { class: "err-head" },
        STATE.errorKind === "markup" ? "界面标记未能渲染" : "术语库读取失败",
      ),
      el("div", { class: "err-body" }, STATE.loadError),
      el(
        "div",
        { class: "err-hint" },
        "点页脚「导出诊断」写入文件，或查看 Zotero 调试日志。",
      ),
    ]);
  }

  /* ---------------- 渲染：计数 ---------------- */

  function renderCounts() {
    var c = STORE.counts;
    var drift = driftGroups().length;
    $$("[data-count]").forEach(function (node) {
      var key = node.getAttribute("data-count");
      if (c[key] !== undefined) {
        node.textContent = c[key];
      }
    });
    var driftCount = $("#drift-count");
    if (driftCount) driftCount.textContent = drift;
    var footer = $("#footer-right");
    if (footer) {
      footer.textContent =
        "证据 " + c.evidence + " 条 · 已确认 " + c.verified + " 条";
    }
  }

  /* ---------------- 渲染：待确认 ---------------- */

  function flagsFor(entry) {
    var flags = [];
    if (!entry.en) flags.push("缺英文表述");
    if (entry.score < PROMOTE_SCORE) flags.push("低分候选");
    return flags;
  }

  /** 引文高亮：全程文本节点，引文里有什么字符都只是文本。 */
  function highlightQuote(entry) {
    var quote = entry.quote == null ? "" : String(entry.quote);
    var zh = entry.zh == null ? "" : String(entry.zh);
    var at = zh ? quote.indexOf(zh) : -1;
    if (at < 0) return [text(quote)];
    return [
      text(quote.slice(0, at)),
      el("mark", null, zh),
      text(quote.slice(at + zh.length)),
    ];
  }

  function cardNode(entry, index, total) {
    var score =
      typeof entry.score === "number"
        ? entry.score.toFixed(2)
        : String(entry.score);
    var origin = entry.itemTitle
      ? String(entry.itemTitle) + (entry.page ? " p." + entry.page : "")
      : "来源未知";

    var meta = [
      span(
        "pill pill-neutral",
        METHOD_LABELS[entry.method] || String(entry.method),
      ),
      span("pill pill-neutral pill-monosm", "score " + score),
      span("pill pill-neutral", origin),
    ];
    if (entry.section) {
      meta.push(span("pill pill-neutral", String(entry.section)));
    }
    if (entry.seenCount > 1) {
      meta.push(span("pill pill-neutral", "出现 " + entry.seenCount + " 次"));
    }

    var note = null;
    if (!entry.en) {
      note = el(
        "div",
        { class: "note t-cap" },
        "英文表述缺失，需补写后才能入库；中英任一为空时确认按钮禁用。",
      );
    } else if (entry.score < PROMOTE_SCORE) {
      note = el(
        "div",
        { class: "note t-cap" },
        "低分候选几乎都败在中文边界，中文框已默认聚焦全选，改一个词就能入库。",
      );
    }

    var conflicts = knownConflict(entry);
    var known = null;
    if (conflicts.length) {
      var names = conflicts
        .map(function (pair) {
          return (
            String(pair.en) +
            "（" +
            String(pair.role) +
            " · " +
            String(pair.status) +
            "）"
          );
        })
        .join("、");
      known = el("div", { class: "known" }, [
        text("库中已有："),
        el("b", null, names),
        text("。两种写法将在术语库的漂移视图中并列。"),
      ]);
    }

    var zhInput = el("input", {
      class: "input input-zh",
      value: entry.zh == null ? "" : String(entry.zh),
      "aria-label": "中文表述",
      "data-field": "zh",
    });
    var enInput = el("input", {
      class: "input input-en",
      value: entry.en == null ? "" : String(entry.en),
      placeholder: "填写英文表述",
      "aria-label": "英文表述",
      "data-field": "en",
    });

    return el(
      "article",
      {
        class: "card" + (index === STATE.current ? " is-current" : ""),
        "data-id": entry.id,
      },
      [
        el("div", { class: "card-head" }, [
          span("t-label idx", "候选 " + (index + 1) + " / " + total),
          el(
            "span",
            { class: "flags" },
            flagsFor(entry).map(function (flag) {
              return span("pill pill-flag", flag);
            }),
          ),
        ]),
        el("div", { class: "card-row" }, [
          zhInput,
          el("span", { class: "arrow", "aria-hidden": "true" }, "→"),
          enInput,
          el("span", { class: "actions" }, [
            el(
              "button",
              {
                class: "btn btn-primary btn-compact",
                type: "button",
                "data-act": "confirm",
                "aria-disabled": entry.en ? "false" : "true",
              },
              "确认入库",
            ),
            el(
              "button",
              {
                class: "btn btn-quiet btn-compact",
                type: "button",
                "data-act": "reject",
              },
              "驳回",
            ),
          ]),
        ]),
        el("div", { class: "meta" }, meta),
        el("blockquote", { class: "quote" }, highlightQuote(entry)),
        note,
        known,
      ],
    );
  }

  function renderPending() {
    var host = $("#pending-list");
    var bulk = $("#pending-bulk");
    if (!host) {
      trace("renderPending: #pending-list 缺失");
      return;
    }
    if (bulk) bulk.textContent = "";

    /* 失败优先于一切空态：先把原因摆出来 */
    if (STATE.loadError) {
      var failed = [emptyState("术语库读取失败", STATE.loadError)];
      /* 接口都没拿到时重试没有意义，别给假按钮 */
      if (api) {
        failed.push(
          el(
            "button",
            {
              class: "btn btn-ghost btn-compact",
              type: "button",
              "data-act": "retry",
            },
            "重试",
          ),
        );
      }
      fill(host, failed);
      return;
    }
    if (STATE.loading) {
      fill(host, [
        emptyState(
          "正在读取术语库",
          "首次打开会稍慢，数据来自磁盘上的 terms.json。",
        ),
      ]);
      return;
    }

    var q = STATE.q.trim().toLowerCase();
    var list = STORE.pending.filter(function (entry) {
      if (!q) return true;
      return (
        (
          entry.zh +
          " " +
          (entry.en || "") +
          " " +
          (entry.itemTitle || "") +
          " " +
          entry.method
        )
          .toLowerCase()
          .indexOf(q) >= 0
      );
    });

    if (!STORE.pending.length) {
      fill(host, [
        emptyState(
          "没有待确认候选",
          "术语库已收敛。右键一篇文献选择「提取术语」，引擎会重新跑一轮抽取。",
        ),
      ]);
      return;
    }
    if (!list.length) {
      if (bulk) bulk.textContent = "共 " + STORE.pending.length + " 条待确认";
      fill(host, [
        emptyState(
          "没有匹配的候选",
          "共 " + STORE.pending.length + " 条待确认，当前搜索结果为 0 条。",
        ),
      ]);
      return;
    }

    if (bulk) {
      bulk.textContent =
        "共 " + STORE.pending.length + " 条待确认 · 高分在前 · Enter 逐条过";
    }
    fill(
      host,
      list.map(function (entry) {
        return cardNode(
          entry,
          STORE.pending.indexOf(entry),
          STORE.pending.length,
        );
      }),
    );
  }

  function setCurrent(index) {
    STATE.current = Math.max(0, Math.min(index, STORE.pending.length - 1));
    var cards = $$("#pending-list .card");
    cards.forEach(function (card) {
      card.classList.remove("is-current");
    });
    var target = cards[STATE.current];
    if (!target) return;
    target.classList.add("is-current");
    if (target.scrollIntoView) {
      target.scrollIntoView({ block: "nearest" });
    }
    var zh = $('[data-field="zh"]', target);
    if (zh) {
      zh.focus();
      zh.select();
    }
  }

  function afterAction(index) {
    return refresh().then(function () {
      if (STATE.view === "pending") {
        setCurrent(index);
      }
    });
  }

  /* ---------------- 渲染：术语库 ---------------- */

  function statusBadge(status) {
    if (status === "verified") return span("pill pill-info", "verified");
    if (status === "suggested") return span("pill pill-flag", "suggested");
    return span("pill pill-neutral", "attested");
  }

  function evidenceNodes(pair) {
    var rows = evidenceForPair(pair).map(function (ev) {
      var title = ev.itemKey ? itemTitle(ev.itemKey) : "";
      var loc = ev.page > 0 ? " p." + ev.page : "";
      var srcChildren = [text("— " + (title || "来源未知") + loc + " ")];
      if (ev.itemKey) {
        srcChildren.push(
          el(
            "button",
            {
              class: "btn btn-quiet btn-compact",
              type: "button",
              "data-jump": ev.itemKey,
            },
            "定位条目",
          ),
        );
      }
      return el("div", { class: "ev-item" }, [
        text("「" + (ev.quote == null ? "" : String(ev.quote)) + "」"),
        el("span", { class: "ev-src" }, srcChildren),
      ]);
    });

    var drift = null;
    if (
      driftGroups().some(function (group) {
        return group.zh === pair.zh;
      })
    ) {
      drift = el(
        "div",
        { class: "known", style: "margin-top:12px" },
        "⚠ 术语漂移：同一中文概念存在多种英文写法，导出前建议人工择一。",
      );
    }

    return [
      el(
        "div",
        { class: "ev-title t-label" },
        "证据 " + evidenceForPair(pair).length + " 条",
      ),
    ]
      .concat(rows)
      .concat([drift]);
  }

  /* ---------------- 渲染：术语行的人工编辑 ---------------- */

  /*
   * 行内编辑态：中英文两格变成输入框。
   *
   * size="1" 不是随手写的：文本输入框默认按 20 字符计算固有宽度，而固有宽度
   * 会计入表格列的最小内容宽度——两个这样的输入框足以把「英文」「中文」两列
   * 顶宽，整张表跟着变形。归零固有宽度后，实际宽度完全由单元格加 CSS 的
   * width:100% 决定。
   */
  function termEditCells(pair) {
    return [
      el("td", { class: "cell-en" }, [
        el("input", {
          class: "input",
          type: "text",
          size: "1",
          value: pair.en == null ? "" : String(pair.en),
          "aria-label": "英文术语",
          "data-term-field": "en",
        }),
      ]),
      el("td", { class: "cell-zh" }, [
        el("input", {
          class: "input",
          type: "text",
          size: "1",
          value: pair.zh == null ? "" : String(pair.zh),
          "aria-label": "中文译名",
          "data-term-field": "zh",
        }),
      ]),
    ];
  }

  function termActionCell(pair) {
    if (STATE.editing === pair.id) {
      return [
        el(
          "button",
          {
            class: "btn btn-primary btn-compact",
            type: "button",
            "data-term-action": "save",
          },
          "保存",
        ),
        el(
          "button",
          {
            class: "btn btn-quiet btn-compact",
            type: "button",
            "data-term-action": "cancel",
          },
          "取消",
        ),
      ];
    }
    return [
      el(
        "button",
        {
          class: "btn btn-quiet btn-compact",
          type: "button",
          "data-term-action": "edit",
        },
        "编辑",
      ),
      el(
        "button",
        {
          class: "btn btn-quiet btn-compact",
          type: "button",
          "data-term-action": "delete",
        },
        "删除",
      ),
    ];
  }

  /** 表格顶部那一行「新建术语」。 */
  function termCreateRow() {
    if (!STATE.creating) return [];
    return [
      el("tr", { class: "row", "data-term": "new" }, [
        el("td", { class: "cell-en" }, [
          el("input", {
            class: "input",
            type: "text",
            size: "1",
            placeholder: "英文术语",
            "aria-label": "英文术语",
            "data-term-field": "en",
          }),
        ]),
        el("td", { class: "cell-zh" }, [
          el("input", {
            class: "input",
            type: "text",
            size: "1",
            placeholder: "中文译名",
            "aria-label": "中文译名",
            "data-term-field": "zh",
          }),
        ]),
        el("td", null, statusBadge("suggested")),
        el("td", null, [span("t-cap num", "human_review")]),
        el("td", null, [span("t-cap", "—")]),
        el("td", { style: "white-space:nowrap" }, [
          el(
            "button",
            {
              class: "btn btn-primary btn-compact",
              type: "button",
              "data-term-action": "create",
            },
            "保存",
          ),
          el(
            "button",
            {
              class: "btn btn-quiet btn-compact",
              type: "button",
              "data-term-action": "create-cancel",
            },
            "取消",
          ),
        ]),
      ]),
    ];
  }

  function termRowNodes(list) {
    var out = [];
    list.forEach(function (pair, i) {
      var key = pair.en + "|" + pair.zh;
      var open = !!STATE.expanded[key];
      var editing = STATE.editing === pair.id;
      var evCount = evidenceForPair(pair).length;
      var last = i === list.length - 1 && !open;
      var expandCell = evCount
        ? el(
            "button",
            {
              class: "expand",
              type: "button",
              "data-ev": key,
              "aria-expanded": open ? "true" : "false",
            },
            String(evCount),
          )
        : span("t-cap", "—");

      var role = span("t-cap", String(pair.role));
      role.setAttribute("style", "margin-right:6px");

      var identity = editing
        ? termEditCells(pair)
        : [
            el("td", { class: "cell-en" }, pair.en),
            el("td", { class: "cell-zh" }, pair.zh),
          ];

      out.push(
        el(
          "tr",
          { class: "row" + (last ? " is-last" : ""), "data-term": pair.id },
          identity.concat([
            el("td", null, [role, statusBadge(pair.status)]),
            el("td", null, [span("t-cap num", String(pair.source))]),
            el("td", null, [expandCell]),
            el("td", { style: "white-space:nowrap" }, termActionCell(pair)),
          ]),
        ),
      );

      if (open) {
        out.push(
          el("tr", null, [
            el("td", { class: "evidence", colspan: "6" }, evidenceNodes(pair)),
          ]),
        );
      }
    });
    return out;
  }

  function renderTerms() {
    var body = $("#terms-body");
    var empty = $("#terms-empty");
    var count = $("#terms-count");
    if (!body || !empty) {
      trace("renderTerms: 表格容器缺失");
      return;
    }

    var q = STATE.q.trim().toLowerCase();
    var list = STORE.pairs.filter(function (pair) {
      if (STATE.docFilter) {
        var fromDoc = evidenceForPair(pair).some(function (ev) {
          return ev.itemKey === STATE.docFilter;
        });
        if (!fromDoc) return false;
      }
      if (!q) return true;
      return (
        (pair.en + " " + pair.zh + " " + pair.source + " " + pair.status)
          .toLowerCase()
          .indexOf(q) >= 0
      );
    });

    if (!STORE.pairs.length && !STATE.creating) {
      body.replaceChildren();
      if (count) count.textContent = "";
      fill(empty, [
        emptyState(
          "术语库是空的",
          "右键一篇文献选择「提取术语」，或到「待确认」确认候选，术语对会出现在这里。",
        ),
      ]);
      return;
    }
    if (!list.length && !STATE.creating) {
      body.replaceChildren();
      if (count) count.textContent = "共 " + STORE.pairs.length + " 条术语对";
      fill(empty, [
        emptyState(
          "没有匹配的术语",
          "共 " +
            STORE.pairs.length +
            " 条术语对，当前筛选结果为 0 条" +
            (STATE.docFilter ? "（来自文献过滤）" : "") +
            "。",
        ),
      ]);
      return;
    }
    empty.replaceChildren();

    if (STATE.drift) {
      var groups = {};
      var order = [];
      list.forEach(function (pair) {
        if (!groups[pair.zh]) {
          groups[pair.zh] = [];
          order.push(pair.zh);
        }
        groups[pair.zh].push(pair);
      });
      var nodes = termCreateRow();
      order.forEach(function (zh) {
        var items = groups[zh];
        var warn =
          items.length > 1
            ? span("pill pill-flag", items.length + " 种写法")
            : span("pill pill-neutral", "单一写法");
        nodes.push(
          el("tr", null, [
            el("td", { class: "group-head", colspan: "6" }, [
              span("zh", zh),
              span("sub", items.length + " 个英文术语对").setAttribute(
                "style",
                "margin-left:8px",
              ),
              el("span", { style: "float:right" }, [warn]),
            ]),
          ]),
        );
        nodes.push.apply(nodes, termRowNodes(items));
      });
      fill(body, nodes);
      if (count) {
        count.textContent =
          "共 " +
          STORE.pairs.length +
          " 条 · 归并为 " +
          order.length +
          " 个中文概念 · 当前显示 " +
          list.length +
          " 条";
      }
    } else {
      fill(body, termCreateRow().concat(termRowNodes(list)));
      if (count) {
        count.textContent =
          "共 " + STORE.pairs.length + " 条 · 显示 " + list.length + " 条";
      }
    }
  }

  /* ---------------- 渲染：文献 ---------------- */

  function docNode(rec) {
    var pending = pendingCountForItem(rec.itemKey);
    return el(
      "button",
      { class: "doc", type: "button", "data-doc": rec.itemKey },
      [
        el("span", { class: "doc-main" }, [
          el("span", { class: "doc-title" }, rec.title),
          el("span", { class: "doc-meta" }, [
            text("PDF · "),
            span("num", String(rec.pages)),
            text(" 页 · 摄取于 "),
            span("num", String(rec.extractedAt).slice(0, 10)),
          ]),
        ]),
        el("span", { class: "doc-num" }, [
          el("span", { class: "metric" }, [
            span("v", String(rec.pairs)),
            el("br"),
            span("k", "术语对"),
          ]),
          el("span", { class: "metric" }, [
            span("v", String(pending)),
            el("br"),
            span("k", "待确认"),
          ]),
        ]),
        el("span", { class: "chev", "aria-hidden": "true" }, "→"),
      ],
    );
  }

  function renderDocs() {
    var host = $("#docs-list");
    var empty = $("#docs-empty");
    if (!host || !empty) {
      trace("renderDocs: 容器缺失");
      return;
    }
    var q = STATE.q.trim().toLowerCase();
    var list = Object.keys(STORE.items)
      .map(function (key) {
        return STORE.items[key];
      })
      .filter(function (rec) {
        return !q || String(rec.title).toLowerCase().indexOf(q) >= 0;
      })
      .sort(function (a, b) {
        return String(b.extractedAt).localeCompare(String(a.extractedAt));
      });

    if (!Object.keys(STORE.items).length) {
      host.replaceChildren();
      fill(empty, [
        emptyState(
          "还没有摄取过文献",
          "右键一篇文献选择「提取术语」，摄取完成后文献会出现在这里。",
        ),
      ]);
      return;
    }
    if (!list.length) {
      host.replaceChildren();
      fill(empty, [
        emptyState(
          "没有匹配的文献",
          "共 " +
            Object.keys(STORE.items).length +
            " 篇已摄取文献，当前搜索结果为 0 篇。",
        ),
      ]);
      return;
    }
    empty.replaceChildren();
    fill(host, list.map(docNode));
  }

  function renderAll() {
    renderErrorBanner();
    renderCounts();
    renderPending();
    renderTerms();
    renderDocs();
  }

  /* ---------------- 数据访问 ---------------- */

  function refresh() {
    if (!api) {
      STATE.loading = false;
      STATE.errorKind = "api";
      STATE.loadError = "插件接口不可用：窗口没能拿到 addon.api.manager。";
      trace(STATE.loadError);
      renderAll();
      return Promise.resolve();
    }
    STATE.loading = true;
    STATE.loadError = null;
    STATE.errorKind = null;
    renderAll();
    return api
      .snapshot()
      .then(function (snapshot) {
        STORE = snapshot;
        STATE.loading = false;
        trace(
          "snapshot ok: pairs=" +
            (snapshot.pairs || []).length +
            " pending=" +
            (snapshot.pending || []).length,
        );
        if (STATE.docFilter && !STORE.items[STATE.docFilter]) {
          STATE.docFilter = null;
        }
        renderAll();
        /*
         * 只在本次开窗的第一次成功读取后自动写库：开机那一份还没有数据，
         * 这一份才带得上渲染后的控件计数；之后每次刷新都写会把文件撑爆。
         */
        if (!STATE.autoSnapshotLogged) {
          STATE.autoSnapshotLogged = true;
          autoWriteDiagnostics(
            "snapshot-ok pairs=" +
              (snapshot.pairs || []).length +
              " pending=" +
              (snapshot.pending || []).length,
          );
        }
      })
      .catch(function (error) {
        STATE.loading = false;
        STATE.errorKind = "read";
        STATE.loadError =
          "读取术语库失败：" +
          shortError(error) +
          "（" +
          errorName(error) +
          "）";
        trace("snapshot failed: " + shortError(error));
        renderAll();
        autoWriteDiagnostics("snapshot-failed " + shortError(error));
      });
  }

  /* ---------------- 导出 ---------------- */

  function csvCell(value) {
    var cell = String(value == null ? "" : value);
    if (/[",\n\r]/.test(cell)) {
      return '"' + cell.replace(/"/g, '""') + '"';
    }
    return cell;
  }

  function copyToClipboard(value) {
    var utilities =
      ZoteroRef && ZoteroRef.Utilities ? ZoteroRef.Utilities : null;
    var internal = utilities && utilities.Internal ? utilities.Internal : null;
    if (internal && internal.copyTextToClipboard) {
      internal.copyTextToClipboard(value);
      return true;
    }
    trace("剪贴板接口不可用");
    return false;
  }

  function exportPairs() {
    var rows = ["en,zh,role,status"];
    STORE.pairs.forEach(function (pair) {
      rows.push(
        [pair.en, pair.zh, pair.role, pair.status].map(csvCell).join(","),
      );
    });
    if (!copyToClipboard(rows.join("\n"))) {
      toast("导出失败：无法访问剪贴板接口");
      return;
    }
    toast(
      "已复制 " +
        STORE.pairs.length +
        " 对术语（CSV 格式），可直接粘贴到翻译工作流",
    );
  }

  /* ---------------- toast ---------------- */

  var toastTimer = null;

  function toast(message, actionLabel, action) {
    var node = $("#toast");
    if (!node) return;
    clearTimeout(toastTimer);
    var children = [el("span", null, message)];
    if (actionLabel) {
      children.push(
        el("button", { type: "button", id: "toast-act" }, actionLabel),
      );
    }
    fill(node, children);
    node.classList.add("on");
    if (actionLabel && action) {
      var act = $("#toast-act");
      if (act) {
        act.addEventListener("click", function () {
          action();
          node.classList.remove("on");
        });
      }
    }
    toastTimer = setTimeout(function () {
      node.classList.remove("on");
    }, 3600);
  }

  /* ---------------- 视图切换 ---------------- */

  function setView(view) {
    STATE.view = view;
    $$('[role="tab"]').forEach(function (tab) {
      tab.setAttribute(
        "aria-selected",
        tab.getAttribute("data-view") === view ? "true" : "false",
      );
    });
    $$(".view").forEach(function (section) {
      section.hidden = section.getAttribute("id") !== "view-" + view;
    });
    var hints = $("#hints");
    if (hints) {
      hints.style.display = view === "pending" ? "" : "none";
    }
  }

  /* ---------------- 事件 ---------------- */

  function activeCard() {
    return $$("#pending-list .card")[STATE.current];
  }

  function onConfirm(card) {
    var id = card.getAttribute("data-id");
    var entry = STORE.pending.find(function (item) {
      return item.id === id;
    });
    if (!entry) return;
    var zhField = $('[data-field="zh"]', card);
    var enField = $('[data-field="en"]', card);
    var zh = zhField ? zhField.value.trim() : "";
    var en = enField ? enField.value.trim() : "";
    if (!zh || !en) return;
    var changed = zh !== entry.zh || en !== (entry.en || "");
    api
      .accept(id, { zh: zh, en: en })
      .then(function (ok) {
        if (!ok) {
          toast("入库失败：中英文表述不能为空");
          return;
        }
        toast(
          changed
            ? "已入库「" +
                zh +
                " / " +
                en +
                "」· 中文被改写，状态记为 suggested（human_review）"
            : "已入库「" +
                zh +
                " / " +
                en +
                "」· 引文逐字支撑，状态记为 verified",
        );
        return afterAction(STATE.current);
      })
      .catch(function (error) {
        toast("入库失败：" + shortError(error));
      });
  }

  function onReject(id, index) {
    api
      .reject(id)
      .then(function () {
        toast("已驳回该候选 · 同一候选不会再次弹出", "撤销", function () {
          api
            .reopen(id)
            .then(function () {
              return refresh();
            })
            .then(function () {
              setCurrent(index);
              toast("已恢复该候选");
            })
            .catch(function (error) {
              toast("撤销失败：" + shortError(error));
            });
        });
        return afterAction(index);
      })
      .catch(function (error) {
        toast("驳回失败：" + shortError(error));
      });
  }

  function onBulkReject() {
    var low = STORE.pending.filter(function (entry) {
      return entry.score < BULK_REJECT_BELOW;
    });
    if (!low.length) {
      toast("没有低于 " + BULK_REJECT_BELOW + " 分的候选");
      return;
    }
    api
      .rejectMany(
        low.map(function (entry) {
          return entry.id;
        }),
      )
      .then(function (count) {
        toast("已批量驳回 " + count + " 条低分候选");
        STATE.current = 0;
        return afterAction(0);
      })
      .catch(function (error) {
        toast("批量驳回失败：" + shortError(error));
      });
  }

  /* ---------------- 事件：术语库人工编辑 ---------------- */

  function termFieldValue(row, name) {
    var node = row ? $('[data-term-field="' + name + '"]', row) : null;
    return node ? String(node.value || "").trim() : "";
  }

  function focusTermField(selector) {
    var node = $(selector);
    if (node && node.focus) node.focus();
  }

  function onCreateTerm() {
    var row = $('[data-term="new"]');
    var en = termFieldValue(row, "en");
    var zh = termFieldValue(row, "zh");
    if (!en || !zh) {
      toast("英文术语和中文译名都要填");
      return;
    }
    api
      .create({ en: en, zh: zh })
      .then(function (pair) {
        STATE.creating = false;
        toast("已新建「" + pair.zh + " / " + pair.en + "」· 写入前已自动备份");
        return refresh();
      })
      .catch(function (error) {
        toast("新建失败：" + shortError(error));
      });
  }

  function onSaveTerm(id, row) {
    var en = termFieldValue(row, "en");
    var zh = termFieldValue(row, "zh");
    if (!en || !zh) {
      toast("英文术语和中文译名都要填");
      return;
    }
    api
      .update(id, { en: en, zh: zh })
      .then(function () {
        STATE.editing = null;
        toast("已保存「" + zh + " / " + en + "」· 写入前已自动备份");
        return refresh();
      })
      .catch(function (error) {
        toast("保存失败：" + shortError(error));
      });
  }

  function onDeleteTerm(id) {
    var pair = STORE.pairs.filter(function (item) {
      return item.id === id;
    })[0];
    var label = pair ? "「" + pair.zh + " / " + pair.en + "」" : "该术语";
    api
      .remove([id])
      .then(function (result) {
        toast(
          "已删除 " + label + "（连带证据 " + result.evidence + " 条）",
          "撤销",
          function () {
            api
              .restore(result.undo)
              .then(function () {
                return refresh();
              })
              .then(function () {
                toast("已恢复 " + label);
              })
              .catch(function (error) {
                toast("撤销失败：" + shortError(error));
              });
          },
        );
        return refresh();
      })
      .catch(function (error) {
        toast("删除失败：" + shortError(error));
      });
  }

  function onTermAction(action, id, row) {
    if (action === "create") {
      onCreateTerm();
      return;
    }
    if (action === "create-cancel") {
      STATE.creating = false;
      renderTerms();
      return;
    }
    /* 其余动作都需要一条具体术语；拿不到 id 就什么都不做 */
    if (!id) return;
    if (action === "edit") {
      STATE.editing = id;
      STATE.creating = false;
      renderTerms();
      focusTermField('[data-term="' + id + '"] [data-term-field="en"]');
      return;
    }
    if (action === "cancel") {
      STATE.editing = null;
      renderTerms();
      return;
    }
    if (action === "save") {
      onSaveTerm(id, row);
      return;
    }
    if (action === "delete") {
      onDeleteTerm(id);
    }
  }

  /**
   * 把诊断报告写入文件。
   *
   * Zotero 的调试日志只留在错误控制台内存里，不写 .scaffold/logs 那种 .log
   * 文件，剪贴板又可能拿不到——所以这里自己写文件，而且开窗就自动写，不等
   * 人去点按钮。
   *
   * 路径按候选顺序试：开窗方经 window.arguments 传入的路径（首选），加上
   * 本窗口 chrome:// URL 反推出来的插件目录（window.arguments 拿不到时的
   * 兜底）。不弹框问用户——出故障时人只想看到结果，不想先回答一个问题。
   */
  /**
   * 写文件的多策略兜底。
   *
   * 实测窗口里 Zotero.Utilities.Internal.saveFile 不存在，只剩 IOUtils 一条
   * 路；而 Services 又可能取到但缺 IOUtils。所以这里把能想到的官方写文件
   * 方式全列上，逐条试，并把每次失败都写进诊断——"没有可用的写文件接口"
   * 这种结论必须附带每条策略的失败原因，否则没法排查。
   */
  function writeAnyFile(path, textValue, append) {
    var attempts = [];

    /* 1. IOUtils（直接 import 或从任一可用 Services 拿）——Gecko 官方文件 API */
    try {
      var io = ioUtils();
      if (io && io.writeUTF8) {
        io.writeUTF8(path, textValue, append ? { mode: "append" } : undefined);
        return "IOUtils.writeUTF8";
      }
      attempts.push("IOUtils 不可用");
    } catch (error) {
      attempts.push("IOUtils.writeUTF8: " + shortError(error));
    }

    /* 2. Zotero 自己的保存接口（不同版本可能没有） */
    try {
      var internal =
        ZoteroRef && ZoteroRef.Utilities && ZoteroRef.Utilities.Internal
          ? ZoteroRef.Utilities.Internal
          : null;
      if (internal && internal.saveFile) {
        internal.saveFile(textValue, path);
        return "Zotero.Utilities.Internal.saveFile";
      }
      attempts.push("saveFile 不可用");
    } catch (error) {
      attempts.push("saveFile: " + shortError(error));
    }

    /*
     * 3. 直接 import 的 IOUtils：管理窗口里 Services.IOUtils 不存在，
     *    这条才是主路。
     */
    try {
      var ownIO = ioUtils();
      if (ownIO && ownIO.writeUTF8) {
        ownIO.writeUTF8(
          path,
          textValue,
          append ? { mode: "append" } : undefined,
        );
        return "IOUtils.writeUTF8(imported)";
      }
      attempts.push("import IOUtils 不可用");
    } catch (error) {
      attempts.push("import IOUtils: " + shortError(error));
    }

    /* 4. PathUtils 拼 file:// URI 再写 */
    try {
      var pu = pathUtils();
      var ioForUri = ioUtils();
      if (pu && ioForUri && pu.toFileURI) {
        var uri = pu.toFileURI(String(path).replace(/\\/g, "/"));
        ioForUri.writeUTF8(uri, textValue);
        return "IOUtils.writeUTF8(PathUtils.toFileURI)";
      }
      attempts.push("PathUtils 不可用");
    } catch (error) {
      attempts.push("PathUtils.toFileURI: " + shortError(error));
    }

    /* 5. nsIFile + NetUtil 的文件流 */
    try {
      var NetUtil = resolveGlobal("NetUtil");
      var file = newFile(path);
      if (NetUtil && NetUtil.writeFile && file) {
        NetUtil.writeFile(file, textValue);
        return "NetUtil.writeFile";
      }
      attempts.push("NetUtil 不可用");
    } catch (error) {
      attempts.push("NetUtil.writeFile: " + shortError(error));
    }

    /*
     * 6. 自己拼 nsIFileOutputStream。
     *
     * 注意：不要依赖 TextEncoder —— chrome 窗口作用域里它可能不存在，而
     * newFile() 已经把文件建出来了，于是表现为"文件在、内容为空、UI 报
     * 失败"。这里改用 chrome 里一定有的 writeString()，或
     * ScriptableInputStream 转换，两条都不碰 TextEncoder。
     */
    try {
      var fileForStream = newFile(path);
      var Cc6 = resolveGlobal("Cc") || resolveGlobal("Components");
      var Ci6 = resolveGlobal("Ci") || resolveGlobal("Components");
      var stream = newFileOutputStream(path);
      if (stream && Cc6 && Ci6) {
        var wrote = false;
        if (typeof stream.writeString === "function") {
          stream.writeString(textValue);
          wrote = true;
        } else if (stream.convertToInputStream) {
          var converted = stream.convertToInputStream(textValue);
          var scriptable = Cc6[
            "@mozilla.org/scriptableinputstream;1"
          ].createInstance(Ci6.nsIScriptableInputStream);
          scriptable.init(converted);
          while (scriptable.available() > 0) {
            scriptable.read(4096);
          }
          wrote = true;
        }
        stream.close();
        if (wrote) {
          return "nsIFileOutputStream(writeString)";
        }
        attempts.push("nsIFileOutputStream 无可用写入方法");
      } else if (fileForStream) {
        attempts.push("FileOutputStream 不可用");
      }
    } catch (error) {
      attempts.push("nsIFileOutputStream: " + shortError(error));
    }

    /*
     * 7. 借主窗口 Zotero 的数据目录：Zotero 自己读写 terms.json 就在那儿，
     *    主窗口一定有权限。只在前面都失败时用，且文件名固定为诊断名。
     */
    try {
      var mainWin3 = mainChromeWindow();
      var zoteroWin = mainWin3 ? mainWin3.Zotero : null;
      var dir =
        zoteroWin && zoteroWin.DataDirectory
          ? zoteroWin.DataDirectory.dir
          : null;
      var hostIO3 = mainWindowIOUtils();
      if (dir && hostIO3 && hostIO3.writeUTF8) {
        var target = joinPath(dir, "termground-diagnostics-latest.txt");
        hostIO3.writeUTF8(target, textValue);
        attempts.push("已改写到 " + target);
        return "Zotero.DataDirectory(" + target + ")";
      }
      attempts.push("主窗口 Zotero.DataDirectory 不可用");
    } catch (error) {
      attempts.push("Zotero.DataDirectory: " + shortError(error));
    }

    /*
     * 全部失败时清掉可能留下的空文件：策略 6 会先建文件再写，写失败就会
     * 剩一个 0 字节的文件，让人误以为"导出成功了但内容空"。
     */
    try {
      var leftover = newFile(path);
      if (leftover && leftover.exists() && leftover.fileSize === 0) {
        leftover.remove(false);
        attempts.push("已删除写失败留下的空文件");
      }
    } catch {
      /* 删不掉就算了，不影响错误信息 */
    }

    throw new Error("没有可用的写文件接口（" + attempts.join("；") + "）");
  }

  /**
   * 直接解析 IOUtils / PathUtils 模块。
   *
   * 实测管理窗口里 Services.IOUtils 不存在（Services 有 wm，但没有 IOUtils），
   * 主窗口又枚举不到，所以不能再指望"借别人的 Services"。这里按官方模块加载
   * 方式自己把 IOUtils.sys.mjs / PathUtils.sys.mjs 拿进来——只要窗口是 chrome
   * 特权作用域就成立，不依赖任何其它窗口。
   */
  var moduleCache = {};

  function importModule(uri) {
    if (moduleCache[uri] !== undefined) return moduleCache[uri];
    var found = null;
    var ChromeUtilsRef = resolveGlobal("ChromeUtils");
    try {
      if (ChromeUtilsRef && ChromeUtilsRef.importESModule) {
        found = ChromeUtilsRef.importESModule(uri);
      }
    } catch (error) {
      trace("import " + uri + " 失败: " + shortError(error));
    }
    if (!found) {
      try {
        if (typeof ChromeUtils !== "undefined" && ChromeUtils.importESModule) {
          found = ChromeUtils.importESModule(uri);
        }
      } catch (error) {
        trace("import(裸全局) " + uri + " 失败: " + shortError(error));
      }
    }
    moduleCache[uri] = found;
    return found;
  }

  function ioUtils() {
    var direct = ServicesRef && ServicesRef.IOUtils;
    if (direct && direct.writeUTF8) return direct;
    var host = launchArgs.services && launchArgs.services.IOUtils;
    if (host && host.writeUTF8) return host;
    var mod = importModule("resource://gre/modules/IOUtils.sys.mjs");
    if (mod && mod.IOUtils && mod.IOUtils.writeUTF8) return mod.IOUtils;
    if (mod && mod.writeUTF8) return mod;
    var main = mainWindowIOUtils();
    if (main && main.writeUTF8) return main;
    return null;
  }

  function pathUtils() {
    var mod = importModule("resource://gre/modules/PathUtils.sys.mjs");
    if (mod && mod.PathUtils) return mod.PathUtils;
    var main = mainWindowPathUtils();
    return main || null;
  }

  /**
   * 环境自检里再补一段文件 API 的实况：IOUtils 从哪来、各窗口什么类型、
   * 哪个窗口带 Zotero。下一次写文件再失败时，这条就是决定性的。
   */
  function probeFileApis() {
    var lines = [];
    lines.push(
      "ioUtils=" +
        (ioUtils() ? "yes" : "no") +
        " pathUtils=" +
        (pathUtils() ? "yes" : "no") +
        " directIOUtils=" +
        !!(ServicesRef && ServicesRef.IOUtils) +
        " hostServicesIOUtils=" +
        !!(launchArgs.services && launchArgs.services.IOUtils),
    );
    try {
      var ChromeUtilsRef = resolveGlobal("ChromeUtils");
      lines.push(
        "chromeUtils=" +
          (ChromeUtilsRef
            ? "yes importESModule=" + !!ChromeUtilsRef.importESModule
            : "no"),
      );
    } catch (error) {
      lines.push("chromeUtils threw " + shortError(error));
    }
    try {
      if (ServicesRef && ServicesRef.wm) {
        var all = ServicesRef.wm.getEnumerator(null);
        var count = 0;
        var kinds = [];
        while (all.hasMoreElements() && count < 12) {
          var w = all.getNext();
          count++;
          var type = "";
          try {
            type =
              w.document && w.document.documentElement
                ? String(w.document.documentElement.getAttribute("windowtype"))
                : "?";
          } catch {
            type = "unreadable";
          }
          var hasZotero = false;
          try {
            hasZotero = !!w.Zotero;
          } catch {
            hasZotero = false;
          }
          kinds.push(type + (hasZotero ? "+Zotero" : ""));
        }
        lines.push("windows=" + count + " [" + kinds.join(" | ") + "]");
      } else {
        lines.push("wm=missing");
      }
    } catch (error) {
      lines.push("wm enumerate threw " + shortError(error));
    }
    var summary = lines.join("；");
    trace("probeFileApis -> " + summary);
    return summary;
  }

  /** 主窗口作用域里的 Services（借用它的 IOUtils）。 */
  function mainWindowServices() {
    var mainWin = mainChromeWindow();
    if (!mainWin) return null;
    try {
      if (mainWin.Services) return mainWin.Services;
    } catch {
      /* 跨 compartment 读取可能抛错 */
    }
    try {
      if (mainWin.wrappedJSObject && mainWin.wrappedJSObject.Services) {
        return mainWin.wrappedJSObject.Services;
      }
    } catch {
      /* 同上 */
    }
    return null;
  }

  function mainWindowIOUtils() {
    var services = mainWindowServices();
    return services && services.IOUtils ? services.IOUtils : null;
  }

  function mainWindowPathUtils() {
    var mainWin = mainChromeWindow();
    if (!mainWin) return null;
    try {
      if (mainWin.PathUtils) return mainWin.PathUtils;
    } catch {
      /* 同上 */
    }
    try {
      if (mainWin.wrappedJSObject && mainWin.wrappedJSObject.PathUtils) {
        return mainWin.wrappedJSObject.PathUtils;
      }
    } catch {
      /* 同上 */
    }
    return null;
  }

  /** 找主窗口（navigator:browser），用于借用它的文件 API。 */
  function mainChromeWindow() {
    if (!ServicesRef || !ServicesRef.wm) return null;
    try {
      if (ServicesRef.wm.getMostRecentWindow) {
        var recent = ServicesRef.wm.getMostRecentWindow("navigator:browser");
        if (recent && recent !== window) return recent;
      }
    } catch {
      /* 忽略，继续枚举 */
    }
    try {
      var enumerator = ServicesRef.wm.getEnumerator("navigator:browser");
      while (enumerator.hasMoreElements()) {
        var win = enumerator.getNext();
        if (win && win !== window) return win;
      }
    } catch {
      return null;
    }
    return null;
  }

  /**
   * 建 nsIFile：优先 Components 的 file/local 服务，其次作用域里的 File
   * 构造器。两者都拿不到就没有文件对象可用。
   */
  function newFile(path) {
    var target = String(path);
    var parent = target.replace(/[\\/][^\\/]*$/, "");
    var Cc = resolveGlobal("Cc") || resolveGlobal("Components");
    var Ci = resolveGlobal("Ci") || resolveGlobal("Components");
    var file = null;
    try {
      if (Cc && Ci) {
        file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
        file.initWithPath(target);
      }
    } catch {
      file = null;
    }
    if (!file) {
      var FileCtor = resolveGlobal("File");
      if (FileCtor) file = new FileCtor(target);
    }
    if (!file) return null;
    try {
      var parentFile = file.parent;
      if (parentFile && !parentFile.exists()) {
        parentFile.create(parentFile.DIRECTORY_TYPE, 0o755);
      }
    } catch {
      /* 父目录已存在或无权创建，交给写入环节报错 */
    }
    void parent;
    return file;
  }

  function newFileOutputStream(path) {
    var file = newFile(path);
    var Cc = resolveGlobal("Cc") || resolveGlobal("Components");
    var Ci = resolveGlobal("Ci") || resolveGlobal("Components");
    if (!file || !Cc || !Ci) return null;
    return Cc["@mozilla.org/network/file-output-stream;1"]
      .createInstance(Ci.nsIFileOutputStream)
      .init(file, 0x02 | 0x08 | 0x20, 0o644, 0);
  }

  /** 自动写入路径用：保留旧签名，内部走多策略。 */
  function writeTextFile(path, textValue, append) {
    return writeAnyFile(path, textValue, append);
  }

  /** 从 chrome://<ref>/content/manager.xhtml 反推插件目录下的诊断文件路径。 */
  function fallbackDiagnosticsPath() {
    try {
      var href = String(window.location && window.location.href);
      var marker = "/content/";
      var at = href.lastIndexOf(marker);
      if (at < 0) return null;
      return href.slice(0, at + marker.length) + "manager-diagnostics.txt";
    } catch {
      return null;
    }
  }

  /** 与 termStore 同一套路径拼法：分隔符从数据目录自身推断。 */
  function diagnosticsPathFromZotero() {
    try {
      if (
        !ZoteroRef ||
        !ZoteroRef.DataDirectory ||
        !ZoteroRef.DataDirectory.dir
      ) {
        return null;
      }
      var dir = String(ZoteroRef.DataDirectory.dir);
      var separator = dir.indexOf("\\") >= 0 ? "\\" : "/";
      return (
        dir.replace(/[\\/]+$/, "") +
        separator +
        "termground-manager-diagnostics.txt"
      );
    } catch {
      return null;
    }
  }

  function diagnosticsCandidates() {
    var candidates = [];
    /* 运行根目录优先：自动写的那一份就落在插件旁边 */
    var auto = autoDiagnosticsPath();
    if (auto) candidates.push(auto);
    var given = launchArgs.diagnosticsPath;
    if (typeof given === "string" && given) {
      candidates.push(given);
    } else if (Array.isArray(given)) {
      candidates = candidates.concat(given);
    }
    /* window.arguments 在真实窗口里未必送达，那就用拿到的 Zotero 自己推 */
    var fromZotero = diagnosticsPathFromZotero();
    if (fromZotero && candidates.indexOf(fromZotero) < 0) {
      candidates.push(fromZotero);
    }
    var fallback = fallbackDiagnosticsPath();
    if (fallback && candidates.indexOf(fallback) < 0) {
      candidates.push(fallback);
    }
    return candidates.filter(function (path, index) {
      return candidates.indexOf(path) === index;
    });
  }

  function writeDiagnosticsFile(textValue, append) {
    var candidates = diagnosticsCandidates();
    if (!candidates.length) {
      trace("diagnostics: 没有任何可用路径（window.arguments 也没给）");
      return null;
    }
    for (var i = 0; i < candidates.length; i++) {
      try {
        var how = writeTextFile(candidates[i], textValue, append);
        return { path: candidates[i], how: how };
      } catch (error) {
        trace(
          "diagnostics: 写入 " + candidates[i] + " 失败 " + shortError(error),
        );
      }
    }
    return null;
  }

  /** 自动写一次当前诊断；开窗第一条截断旧内容，之后追加。 */
  function autoWriteDiagnostics(why) {
    var header =
      "\n===== " + new Date().toISOString() + " (" + why + ") =====\n";
    var report = header + diagnosticsText() + "\n";
    var written = writeDiagnosticsFile(report, STATE.diagnosticsWritten);
    if (written) {
      STATE.diagnosticsWritten = true;
    }
    trace(
      "autoWrite(" +
        why +
        ") -> " +
        (written ? written.path + " via " + written.how : "失败"),
    );
    return written;
  }

  /* ---------------- 导出诊断 ---------------- */

  /** 补零两位，用于文件名里的日期时间。 */
  function pad2(value) {
    return (value < 10 ? "0" : "") + value;
  }

  /** termground-diagnostics-20260929-1245.txt */
  function defaultDiagnosticsFileName() {
    var now = new Date();
    return (
      "termground-diagnostics-" +
      now.getFullYear() +
      pad2(now.getMonth() + 1) +
      pad2(now.getDate()) +
      "-" +
      pad2(now.getHours()) +
      pad2(now.getMinutes()) +
      ".txt"
    );
  }

  /** 保存对话框与自动写入的默认目录：开窗方给的插件根目录优先。 */
  function diagnosticsBaseDir() {
    if (launchArgs.basePath && typeof launchArgs.basePath === "string") {
      return launchArgs.basePath;
    }
    var fromZotero =
      ZoteroRef && ZoteroRef.DataDirectory ? ZoteroRef.DataDirectory.dir : null;
    return fromZotero || null;
  }

  function joinPath(dir, name) {
    var separator = String(dir).indexOf("\\") >= 0 ? "\\" : "/";
    return String(dir).replace(/[\\/]+$/, "") + separator + name;
  }

  /** 每次开窗自动写的那一份：固定文件名，直接落在运行根目录。 */
  function autoDiagnosticsPath() {
    var dir = diagnosticsBaseDir();
    if (!dir) return null;
    return joinPath(dir, "termground-diagnostics-latest.txt");
  }

  /** 导出用：与自动写入共用多策略写文件实现。 */
  function saveTextFile(path, textValue) {
    return writeAnyFile(path, textValue, false);
  }

  /**
   * 弹系统保存对话框（Zotero 的 FilePicker 就是 nsIFilePicker）：预填带
   * 日期时间的文件名，默认目录是插件运行根目录。取消则返回 null。
   */
  function pickDiagnosticsFile(defaultName, defaultDir) {
    var Cc = resolveGlobal("Cc") || resolveGlobal("Components");
    var Ci = resolveGlobal("Ci") || resolveGlobal("Components");
    if (!Cc || !Ci) {
      throw new Error("Cc/Ci 不可用，无法打开保存对话框");
    }
    var picker = Cc["@mozilla.org/filepicker;1"].createInstance(
      Ci.nsIFilePicker,
    );
    var filePicker = Ci.nsIFilePicker;
    /*
     * Gecko 105+ 用 browsingContext，更老的版本要窗口对象。取不到就退回去，
     * 别因为父窗口参数把整个导出搞失败。
     */
    try {
      picker.init(
        window.browsingContext || window,
        "导出诊断",
        filePicker.modeSave,
      );
    } catch {
      trace("导出诊断: browsingContext 作为父窗口失败，改用 window");
      picker.init(window, "导出诊断", filePicker.modeSave);
    }
    picker.defaultString = defaultName;
    picker.defaultExtension = "txt";
    picker.appendFilter("文本文件", "*.txt");
    picker.appendFilters(filePicker.filterAll);
    try {
      var FileUtils = resolveGlobal("FileUtils");
      if (defaultDir && FileUtils && FileUtils.File) {
        picker.displayDirectory = new FileUtils.File(defaultDir);
      }
    } catch (error) {
      trace("导出诊断: 默认目录设置失败 " + shortError(error));
    }
    return new Promise(function (resolve) {
      picker.open(function (result) {
        if (result === filePicker.returnCancel) {
          resolve(null);
          return;
        }
        resolve({
          path: picker.file.path,
          overwrote: result === filePicker.returnReplace,
        });
      });
    });
  }

  /** 返回 Promise，调用方（含自动化测试）可以等导出真正结束。 */
  function onDiagnostics() {
    var report =
      "\n===== " +
      new Date().toISOString() +
      " (导出) =====\n" +
      diagnosticsText() +
      "\n";
    var filename = defaultDiagnosticsFileName();
    var dir = diagnosticsBaseDir();

    return pickDiagnosticsFile(filename, dir)
      .then(function (picked) {
        if (!picked) {
          trace("导出诊断: 用户取消");
          if (copyToClipboard(report)) {
            toast("已取消导出，诊断信息已复制到剪贴板");
          } else {
            toast("已取消导出");
          }
          return;
        }
        try {
          var how = saveTextFile(picked.path, report);
          STATE.diagnosticsWritten = true;
          trace("导出诊断: 已写入 " + picked.path + "（" + how + "）");
          toast("诊断已导出到 " + picked.path);
        } catch (error) {
          trace("导出诊断: 写入失败 " + shortError(error));
          toast("导出失败：" + shortError(error));
        }
      })
      .catch(function (error) {
        trace("导出诊断: 对话框打开失败 " + shortError(error));
        /* 对话框不可用时退回自动写入，再退到剪贴板 */
        var written = autoWriteDiagnostics("导出回退");
        if (written) {
          toast("对话框不可用，已写入 " + written.path);
          return;
        }
        toast(
          copyToClipboard(report)
            ? "对话框不可用，诊断信息已复制到剪贴板"
            : "导出失败：" + shortError(error),
        );
      });
  }

  function bindEvents() {
    document.addEventListener("click", function (event) {
      var target = event.target;
      if (!target || !target.closest) return;

      var tab = target.closest("[data-view]");
      if (tab) {
        setView(tab.getAttribute("data-view"));
        return;
      }

      var act = target.closest("[data-act]");
      if (act) {
        var actName = act.getAttribute("data-act");
        if (actName === "retry") {
          refresh();
          return;
        }
        var card = act.closest(".card");
        if (!card) return;
        var index = $$("#pending-list .card").indexOf(card);
        if (actName === "confirm") {
          onConfirm(card);
        } else {
          onReject(card.getAttribute("data-id"), index);
        }
        return;
      }

      var evBtn = target.closest("[data-ev]");
      if (evBtn) {
        var key = evBtn.getAttribute("data-ev");
        STATE.expanded[key] = !STATE.expanded[key];
        renderTerms();
        return;
      }

      var jump = target.closest("[data-jump]");
      if (jump) {
        var itemKey = jump.getAttribute("data-jump");
        if (api && api.selectItem(itemKey)) {
          toast("已在文献面板定位该条目");
        } else {
          toast("无法定位条目：文献面板不可用");
        }
        return;
      }

      var doc = target.closest("[data-doc]");
      if (doc) {
        STATE.docFilter = doc.getAttribute("data-doc");
        setView("terms");
        renderTerms();
        toast("已按《" + itemTitle(STATE.docFilter) + "》过滤术语库");
        return;
      }

      var termAction = target.closest("[data-term-action]");
      if (termAction) {
        var termRow = termAction.closest("[data-term]");
        onTermAction(
          termAction.getAttribute("data-term-action"),
          termRow ? termRow.getAttribute("data-term") : null,
          termRow,
        );
        return;
      }

      if (target.closest("#term-new")) {
        STATE.creating = true;
        STATE.editing = null;
        setView("terms");
        renderTerms();
        focusTermField('[data-term="new"] [data-term-field="en"]');
        return;
      }

      if (target.closest("#export")) {
        exportPairs();
        return;
      }

      if (target.closest("#reject-low")) {
        onBulkReject();
        return;
      }

      if (target.closest("#drift-toggle")) {
        STATE.drift = !STATE.drift;
        var btn = $("#drift-toggle");
        if (btn) {
          btn.setAttribute("aria-pressed", STATE.drift ? "true" : "false");
          btn.classList.toggle("btn-ghost", !STATE.drift);
          btn.classList.toggle("btn-primary", STATE.drift);
        }
        renderTerms();
        return;
      }

      if (target.closest("#theme")) {
        var root = document.documentElement;
        root.setAttribute(
          "data-theme",
          root.getAttribute("data-theme") === "dark" ? "light" : "dark",
        );
        return;
      }

      if (target.closest("#diagnostics")) {
        return onDiagnostics();
      }
    });

    document.addEventListener("input", function (event) {
      var target = event.target;
      if (!target) return;
      if (target.id === "q") {
        STATE.q = target.value;
        renderPending();
        renderTerms();
        renderDocs();
        return;
      }
      /* 中英任一为空 → 确认按钮禁用 */
      var field = target.closest ? target.closest("[data-field]") : null;
      if (!field) return;
      var card = field.closest(".card");
      if (!card) return;
      var zhField = $('[data-field="zh"]', card);
      var enField = $('[data-field="en"]', card);
      var zh = zhField ? zhField.value.trim() : "";
      var en = enField ? enField.value.trim() : "";
      var btn = $('[data-act="confirm"]', card);
      if (btn) {
        btn.setAttribute("aria-disabled", zh && en ? "false" : "true");
      }
    });

    document.addEventListener("keydown", function (event) {
      var search = $("#q");
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        if (!search) return;
        event.preventDefault();
        search.focus();
        search.select();
        return;
      }
      if (
        event.key === "Escape" &&
        search &&
        document.activeElement === search
      ) {
        STATE.q = "";
        search.value = "";
        renderPending();
        renderTerms();
        renderDocs();
        search.blur();
        return;
      }
      if (STATE.view !== "pending") return;
      var active = document.activeElement;
      var typing = active && /^(INPUT|TEXTAREA)$/.test(active.tagName);
      if (typing && event.key !== "Enter") return;

      var key = event.key.toLowerCase();
      if (key === "r") {
        event.preventDefault();
        var cardR = activeCard();
        if (cardR) onReject(cardR.getAttribute("data-id"), STATE.current);
      } else if (key === "s") {
        event.preventDefault();
        setCurrent(STATE.current + 1);
      } else if (event.key === "Enter") {
        event.preventDefault();
        var cardE = activeCard();
        if (!cardE) return;
        var btn = $('[data-act="confirm"]', cardE);
        if (btn && btn.getAttribute("aria-disabled") !== "true") {
          onConfirm(cardE);
        }
      }
    });
  }

  /* ---------------- 启动 ---------------- */

  /** 未捕获错误也要可见，而不是"控件莫名不见了"。 */
  function installErrorSurface() {
    window.addEventListener("error", function (event) {
      STATE.errorKind = "markup";
      STATE.loadError =
        "窗口脚本报错：" +
        (event.message || "未知错误") +
        "（" +
        (event.filename || "?") +
        ":" +
        event.lineno +
        "）";
      trace("window error: " + STATE.loadError);
      try {
        renderErrorBanner();
      } catch {
        /* 兜底渲染失败时不再递归 */
      }
    });
    window.addEventListener("unhandledrejection", function (event) {
      trace("unhandled rejection: " + shortError(event.reason));
    });
  }

  /**
   * 样式表原本只靠 XHTML 里的 <?xml-stylesheet?> 声明式加载。一旦它取不到，
   * 页面就是无样式文档：input / button 会渲染成没有边框和底色的空板，看上
   * 去正是"没有输入框、没有按钮"。这里在脚本里再显式挂一次 chrome:// 样式表
   * 作为冗余，并把加载前后的 styleSheets 数量记进诊断。
   */
  function ensureStylesheet() {
    var before = document.styleSheets.length;
    /* <link> 只能进 <head>：挂到 <html> 上会直接抛 HierarchyRequestError */
    var head = document.head || document.getElementsByTagName("head")[0];
    if (!head) {
      trace("stylesheet: 找不到 <head>，跳过显式挂载");
      return;
    }
    if (head.querySelector("link#tg-manager-css")) {
      trace("stylesheet: 已挂载过，跳过");
      return;
    }
    try {
      var link = el("link", {
        id: "tg-manager-css",
        rel: "stylesheet",
        type: "text/css",
        href: STYLESHEET_HREF,
      });
      head.appendChild(link);
      trace(
        "stylesheet: appended " +
          STYLESHEET_HREF +
          " (styleSheets " +
          before +
          " -> " +
          document.styleSheets.length +
          ")",
      );
    } catch (error) {
      trace("stylesheet append failed: " + shortError(error));
    }
  }

  /**
   * 补静态标记里的图形与提示。
   *
   * XHTML 是严格 XML，内联 <svg> 只要有一处不合法，整个文档连同静态标记
   * 都会解析失败——实测窗口里 Zotero/Services 能拿到、脚本在跑，但静态头
   * 部的图标与页脚提示缺失，就是这一类。主题图标与页脚提示都改由脚本用
   * createElementNS 现造（本文件本来就不拼标记字符串）。
   */
  function hydrateStaticMarkup() {
    var theme = $("#theme");
    if (theme && !theme.querySelector("svg")) {
      try {
        var circle = svgPart("circle", { cx: "8", cy: "8", r: "3.2" });
        var path = svgPart("path", {
          d:
            "M8 1v2M8 13v2M1 8h2M13 8h2M3.2 3.2l1.4 1.4M11.4 11.4l1.4 1.4" +
            "M12.8 3.2l-1.4 1.4M4.6 11.4l-1.4 1.4",
          "stroke-linecap": "round",
        });
        theme.appendChild(svgIcon(15, "0 0 16 16", [circle, path]));
        trace("static icon rebuilt");
      } catch (error) {
        trace("static icon failed: " + shortError(error));
      }
    }

    var hints = $("#hints");
    if (hints && !hints.childNodes.length) {
      fill(hints, [
        el("span", { class: "h" }, [
          span("kbd", "Enter"),
          text(" 确认并下一条"),
        ]),
        el("span", { class: "h" }, [span("kbd", "R"), text(" 驳回")]),
        el("span", { class: "h" }, [span("kbd", "S"), text(" 跳过")]),
      ]);
      trace("static hints rebuilt");
    }
  }

  /**
   * 诊断日志的只读读取口：自动化测试与外部脚本用它确认启动各步是否走到，
   * 不参与界面逻辑（生产环境下没人会去读它）。
   */
  function exposeDiagnostics() {
    try {
      Object.defineProperty(window, "__TermGroundManagerDiagnostics", {
        value: function () {
          return DIAG.slice();
        },
        configurable: true,
      });
    } catch {
      /* 定义失败不影响界面 */
    }
  }

  function boot() {
    installErrorSurface();
    exposeDiagnostics();

    document.documentElement.setAttribute(
      "data-theme",
      window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light",
    );

    bindEvents();
    ensureStylesheet();
    hydrateStaticMarkup();

    trace(
      "boot: contentType=" +
        document.contentType +
        " api=" +
        !!api +
        " zotero=" +
        !!ZoteroRef +
        " services=" +
        !!ServicesRef +
        " styleSheets=" +
        document.styleSheets.length,
    );
    trace("boot: window.arguments -> " + launchArgsProbe);
    trace("boot: api channel -> " + apiChannel);
    trace(
      "boot: diagnostics candidates -> " + diagnosticsCandidates().join(" , "),
    );
    probeEnvironment();
    probeFileApis();

    /* 开窗即自动写一份：这份文件不依赖点按钮，界面坏了也留得下线索 */
    autoWriteDiagnostics("boot");

    /* 主窗口在提取完成后调用此函数刷新本窗口 */
    window.TermGroundManagerRefresh = function () {
      if (api) refresh();
    };

    if (!api) {
      STATE.errorKind = "api";
      STATE.loadError =
        "插件接口不可用：窗口没能拿到 addon.api.manager（Zotero=" +
        !!ZoteroRef +
        "、Services=" +
        !!ServicesRef +
        "）。请从 Zotero 工具菜单重新打开本窗口。";
      renderAll();
      autoWriteDiagnostics("api-missing");
      return;
    }

    setView("pending");
    refresh().then(function () {
      setCurrent(0);
      trace("boot complete");
    });
  }

  try {
    boot();
  } catch (error) {
    trace("boot threw: " + shortError(error));
    try {
      STATE.errorKind = "markup";
      STATE.loadError = "窗口初始化失败：" + shortError(error);
      renderAll();
    } catch {
      /* 极端情况：连兜底都渲染不出来，只能靠调试日志 */
    }
  }
})();
