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
 *    诊断日志（页脚「诊断」按钮可直接复制）。
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
  var launchArgs = (window && window.arguments && window.arguments[0]) || {};

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

  /** 开窗方传入的接口优先，其次从 Zotero 上的插件实例取。 */
  function resolveApi() {
    if (launchArgs.api && launchArgs.api.snapshot) {
      return launchArgs.api;
    }
    var root = ZoteroRef && ZoteroRef.TermGround;
    var candidate = root && root.api ? root.api.manager : null;
    return candidate && candidate.snapshot ? candidate : null;
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

  /** 记一行诊断：进官方日志，同时留给「诊断」按钮与诊断文件。 */
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

  function evidenceForPair(pair) {
    return STORE.evidence.filter(function (ev) {
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
        "点页脚「诊断」复制完整信息，或查看 Zotero 调试日志。",
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

  function termRowNodes(list) {
    var out = [];
    list.forEach(function (pair, i) {
      var key = pair.en + "|" + pair.zh;
      var open = !!STATE.expanded[key];
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

      out.push(
        el("tr", { class: "row" + (last ? " is-last" : "") }, [
          el("td", { class: "cell-en" }, pair.en),
          el("td", { class: "cell-zh" }, pair.zh),
          el("td", null, [role, statusBadge(pair.status)]),
          el("td", null, [span("t-cap num", String(pair.source))]),
          el("td", null, [expandCell]),
        ]),
      );

      if (open) {
        out.push(
          el("tr", null, [
            el("td", { class: "evidence", colspan: "5" }, evidenceNodes(pair)),
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

    if (!STORE.pairs.length) {
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
    if (!list.length) {
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
      var nodes = [];
      order.forEach(function (zh) {
        var items = groups[zh];
        var warn =
          items.length > 1
            ? span("pill pill-flag", items.length + " 种写法")
            : span("pill pill-neutral", "单一写法");
        nodes.push(
          el("tr", null, [
            el("td", { class: "group-head", colspan: "5" }, [
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
      fill(body, termRowNodes(list));
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
  function writeTextFile(path, textValue, append) {
    var io = ServicesRef && ServicesRef.IOUtils;
    if (io && io.writeUTF8) {
      io.writeUTF8(path, textValue, append ? { mode: "append" } : undefined);
      return "IOUtils";
    }
    var internal =
      ZoteroRef && ZoteroRef.Utilities && ZoteroRef.Utilities.Internal
        ? ZoteroRef.Utilities.Internal
        : null;
    /* saveFile 只能整体覆盖，追加场景下退化为覆盖 */
    if (internal && internal.saveFile) {
      internal.saveFile(textValue, path);
      return "saveFile";
    }
    throw new Error("没有可用的写文件接口");
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

  function diagnosticsCandidates() {
    var candidates = [];
    var given = launchArgs.diagnosticsPath;
    if (typeof given === "string" && given) {
      candidates.push(given);
    } else if (Array.isArray(given)) {
      candidates = candidates.concat(given);
    }
    var fallback = fallbackDiagnosticsPath();
    if (fallback && candidates.indexOf(fallback) < 0) {
      candidates.push(fallback);
    }
    return candidates;
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
    return written;
  }

  function onDiagnostics() {
    var report = diagnosticsText();
    try {
      console.log(report);
    } catch {
      /* 忽略 */
    }
    var written = writeDiagnosticsFile(
      "\n===== " + new Date().toISOString() + " (手动) =====\n" + report + "\n",
      STATE.diagnosticsWritten,
    );
    if (written) {
      STATE.diagnosticsWritten = true;
    }

    if (written) {
      toast(
        copyToClipboard(report)
          ? "诊断已写入 " + written.path + "（并复制到剪贴板）"
          : "诊断已写入 " + written.path,
      );
      return;
    }
    toast(
      copyToClipboard(report)
        ? "诊断信息已复制到剪贴板"
        : "诊断没能写入文件：没有可用路径，剪贴板也不可用",
    );
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
        onDiagnostics();
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

  /** 顶部搜索框与导出按钮由 XHTML 提供；图标必须自己补上（见 manager.xhtml）。 */
  function hydrateStaticIcons() {
    var theme = $("#theme");
    if (!theme || theme.querySelector("svg")) return;
    try {
      var circle = svgPart("circle", { cx: "8", cy: "8", r: "3.2" });
      var path = svgPart("path", {
        d:
          "M8 1v2M8 13v2M1 8h2M13 8h2M3.2 3.2l1.4 1.4M11.4 11.4l1.4 1.4" +
          "M12.8 3.2l-1.4 1.4M4.6 11.4l-1.4 1.4",
        "stroke-linecap": "round",
      });
      theme.appendChild(svgIcon(15, "0 0 16 16", [circle, path]));
      trace("static icons hydrated");
    } catch (error) {
      trace("static icons failed: " + shortError(error));
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
    hydrateStaticIcons();
    hydrateStaticMarkupLosses();

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
    trace(
      "boot: diagnostics candidates -> " + diagnosticsCandidates().join(" , "),
    );
    probeEnvironment();

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

  /**
   * XHTML 是严格 XML：静态标记里出现未声明实体等问题会让整段标记失效。
   * 这里补回唯一一处需要图形的地方（主题图标），其余维持纯文本。
   */
  function hydrateStaticMarkupLosses() {
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
