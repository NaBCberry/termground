/*
 * TermGround 管理窗口脚本。
 *
 * 由 managerWindow.ts 通过 Services.scriptloader.loadSubScript 注入窗口作用域，
 * 数据一律经 Zotero.TermGround.api.manager 读写，不直接触碰存储层。
 */
(function () {
  "use strict";

  /* loadSubScript 的作用域解析两种来源都可能出现，做一次防御性解析 */
  function resolveZotero() {
    if (typeof Zotero !== "undefined") {
      return Zotero;
    }
    return window.Zotero;
  }

  var ZoteroRef = resolveZotero();
  var api =
    ZoteroRef && ZoteroRef.TermGround ? ZoteroRef.TermGround.api.manager : null;

  var $ = function (sel, root) {
    return (root || document).querySelector(sel);
  };
  var $$ = function (sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  };
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  };

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
  };

  function ensureApi() {
    if (api) return true;
    var host = $("#pending-list");
    if (host) {
      host.innerHTML =
        '<div class="empty"><div class="t-title">插件接口不可用</div>' +
        "<p>请从 Zotero 的条目菜单或工具菜单重新打开本窗口。</p></div>";
    }
    return false;
  }

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
    var others = same.filter(function (pair) {
      return !entry.en || pair.en !== entry.en;
    });
    return others;
  }

  function pendingCountForItem(itemKey) {
    return STORE.pending.filter(function (entry) {
      return entry.itemKey === itemKey;
    }).length;
  }

  function itemTitle(itemKey) {
    return STORE.items[itemKey] ? STORE.items[itemKey].title : "";
  }

  /* ---------------- 渲染：计数 ---------------- */

  function renderCounts() {
    var c = STORE.counts;
    var drift = driftGroups().length;
    $$("[data-count]").forEach(function (el) {
      var k = el.getAttribute("data-count");
      if (c[k] !== undefined) {
        el.textContent = c[k];
      }
    });
    $("#drift-count").textContent = drift;
    $("#footer-right").textContent =
      "证据 " + c.evidence + " 条 · 已确认 " + c.verified + " 条";
  }

  /* ---------------- 渲染：待确认 ---------------- */

  function flagsFor(entry) {
    var flags = [];
    if (!entry.en) flags.push("缺英文表述");
    if (entry.score < PROMOTE_SCORE) flags.push("低分候选");
    return flags;
  }

  function highlightQuote(entry) {
    var quote = esc(entry.quote);
    var zh = entry.zh;
    var at = quote.indexOf(zh);
    if (at < 0) return quote;
    return (
      quote.slice(0, at) +
      "<mark>" +
      esc(zh) +
      "</mark>" +
      quote.slice(at + zh.length)
    );
  }

  function cardHtml(entry, index, total) {
    var flags = flagsFor(entry)
      .map(function (f) {
        return '<span class="pill pill-flag">' + esc(f) + "</span>";
      })
      .join("");
    var origin = entry.itemTitle
      ? esc(entry.itemTitle) + (entry.page ? " p." + entry.page : "")
      : "来源未知";
    var meta = [
      '<span class="pill pill-neutral">' +
        esc(METHOD_LABELS[entry.method] || entry.method) +
        "</span>",
      '<span class="pill pill-neutral pill-monosm">score ' +
        entry.score.toFixed(2) +
        "</span>",
      '<span class="pill pill-neutral">' + origin + "</span>",
    ];
    if (entry.section) {
      meta.push(
        '<span class="pill pill-neutral">' + esc(entry.section) + "</span>",
      );
    }
    if (entry.seenCount > 1) {
      meta.push(
        '<span class="pill pill-neutral">出现 ' +
          entry.seenCount +
          " 次</span>",
      );
    }

    var known = "";
    var conflicts = knownConflict(entry);
    if (conflicts.length) {
      var names = conflicts
        .map(function (pair) {
          return (
            esc(pair.en) +
            "（" +
            esc(pair.role) +
            " · " +
            esc(pair.status) +
            "）"
          );
        })
        .join("、");
      known =
        '<div class="known">库中已有：<b>' +
        names +
        "</b>。两种写法将在术语库的漂移视图中并列。</div>";
    }

    var note = "";
    if (!entry.en) {
      note =
        '<div class="note t-cap">英文表述缺失，需补写后才能入库；中英任一为空时确认按钮禁用。</div>';
    } else if (entry.score < PROMOTE_SCORE) {
      note =
        '<div class="note t-cap">低分候选几乎都败在中文边界，中文框已默认聚焦全选，改一个词就能入库。</div>';
    }

    var disabled = entry.en ? "" : ' aria-disabled="true"';

    return (
      '<article class="card' +
      (index === STATE.current ? " is-current" : "") +
      '" data-id="' +
      esc(entry.id) +
      '">' +
      '<div class="card-head">' +
      '<span class="t-label idx">候选 ' +
      (index + 1) +
      " / " +
      total +
      "</span>" +
      '<span class="flags">' +
      flags +
      "</span>" +
      "</div>" +
      '<div class="card-row">' +
      '<input class="input input-zh" value="' +
      esc(entry.zh) +
      '" aria-label="中文表述" data-field="zh" />' +
      '<span class="arrow" aria-hidden="true">→</span>' +
      '<input class="input input-en" value="' +
      esc(entry.en || "") +
      '" placeholder="填写英文表述" aria-label="英文表述" data-field="en" />' +
      '<span class="actions">' +
      '<button class="btn btn-primary btn-compact" type="button" data-act="confirm"' +
      disabled +
      ">确认入库</button>" +
      '<button class="btn btn-quiet btn-compact" type="button" data-act="reject">驳回</button>' +
      "</span>" +
      "</div>" +
      '<div class="meta">' +
      meta.join("") +
      "</div>" +
      '<blockquote class="quote">' +
      highlightQuote(entry) +
      "</blockquote>" +
      note +
      known +
      "</article>"
    );
  }

  function renderPending() {
    var host = $("#pending-list");
    var bulk = $("#pending-bulk");
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
      bulk.textContent = "";
      host.innerHTML =
        '<div class="empty"><div class="t-title">没有待确认候选</div>' +
        "<p>术语库已收敛。右键一篇文献选择「提取术语」，引擎会重新跑一轮抽取。</p></div>";
      return;
    }
    if (!list.length) {
      bulk.textContent = "共 " + STORE.pending.length + " 条待确认";
      host.innerHTML =
        '<div class="empty"><div class="t-title">没有匹配的候选</div>' +
        "<p>共 " +
        STORE.pending.length +
        " 条待确认，当前搜索结果为 0 条。</p></div>";
      return;
    }

    bulk.textContent =
      "共 " + STORE.pending.length + " 条待确认 · 高分在前 · Enter 逐条过";
    host.innerHTML = list
      .map(function (entry) {
        return cardHtml(
          entry,
          STORE.pending.indexOf(entry),
          STORE.pending.length,
        );
      })
      .join("");
  }

  function setCurrent(index) {
    STATE.current = Math.max(0, Math.min(index, STORE.pending.length - 1));
    var cards = $$("#pending-list .card");
    cards.forEach(function (card) {
      card.classList.remove("is-current");
    });
    var target = cards[STATE.current];
    if (target) {
      target.classList.add("is-current");
      target.scrollIntoView({ block: "nearest" });
      var zh = $('[data-field="zh"]', target);
      if (zh) {
        zh.focus();
        zh.select();
      }
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
    if (status === "verified") {
      return '<span class="pill pill-info">verified</span>';
    }
    if (status === "suggested") {
      return '<span class="pill pill-flag">suggested</span>';
    }
    return '<span class="pill pill-neutral">attested</span>';
  }

  function evidenceHtml(pair) {
    var rows = evidenceForPair(pair)
      .map(function (ev) {
        var title = ev.itemKey ? itemTitle(ev.itemKey) : "";
        var loc = ev.page > 0 ? " p." + ev.page : "";
        var src =
          ' <span class="ev-src">— ' +
          esc(title || "来源未知") +
          loc +
          (ev.itemKey
            ? ' <button class="btn btn-quiet btn-compact" type="button" data-jump="' +
              esc(ev.itemKey) +
              '">定位条目</button>'
            : "") +
          "</span>";
        return (
          '<div class="ev-item">「' + esc(ev.quote) + "」" + src + "</div>"
        );
      })
      .join("");

    var drift = "";
    if (
      driftGroups().some(function (g) {
        return g.zh === pair.zh;
      })
    ) {
      drift =
        '<div class="known" style="margin-top:12px">⚠ 术语漂移：同一中文概念存在多种英文写法，导出前建议人工择一。</div>';
    }
    return (
      '<div class="ev-title t-label">证据 ' +
      evidenceForPair(pair).length +
      " 条</div>" +
      rows +
      drift
    );
  }

  function termRows(list) {
    var driftZh = driftGroups().map(function (g) {
      return g.zh;
    });
    return list
      .map(function (pair, i) {
        var key = pair.en + "|" + pair.zh;
        var open = !!STATE.expanded[key];
        var evCount = evidenceForPair(pair).length;
        var last = i === list.length - 1 && !open;
        var expandBtn = evCount
          ? '<button class="expand" type="button" data-ev="' +
            esc(key) +
            '" aria-expanded="' +
            open +
            '">' +
            evCount +
            "</button>"
          : '<span class="t-cap">—</span>';
        return (
          '<tr class="row' +
          (last ? " is-last" : "") +
          '">' +
          '<td class="cell-en">' +
          esc(pair.en) +
          "</td>" +
          '<td class="cell-zh">' +
          esc(pair.zh) +
          "</td>" +
          "<td>" +
          '<span class="t-cap" style="margin-right:6px">' +
          esc(pair.role) +
          "</span>" +
          statusBadge(pair.status) +
          "</td>" +
          '<td><span class="t-cap num">' +
          esc(pair.source) +
          "</span></td>" +
          "<td>" +
          expandBtn +
          "</td>" +
          "</tr>" +
          (open
            ? '<tr><td class="evidence" colspan="5">' +
              evidenceHtml(pair) +
              "</td></tr>"
            : "") +
          (driftZh.indexOf(pair.zh) >= 0 && !open ? "" : "")
        );
      })
      .join("");
  }

  function renderTerms() {
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

    var body = $("#terms-body");
    var empty = $("#terms-empty");

    if (!STORE.pairs.length) {
      body.innerHTML = "";
      $("#terms-count").textContent = "";
      empty.innerHTML =
        '<div class="empty"><div class="t-title">术语库是空的</div>' +
        "<p>右键一篇文献选择「提取术语」，或到「待确认」确认候选，术语对会出现在这里。</p></div>";
      return;
    }
    if (!list.length) {
      body.innerHTML = "";
      $("#terms-count").textContent = "共 " + STORE.pairs.length + " 条术语对";
      empty.innerHTML =
        '<div class="empty"><div class="t-title">没有匹配的术语</div>' +
        "<p>共 " +
        STORE.pairs.length +
        " 条术语对，当前筛选结果为 0 条" +
        (STATE.docFilter ? "（来自文献过滤）" : "") +
        "。</p></div>";
      return;
    }
    empty.innerHTML = "";

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
      body.innerHTML = order
        .map(function (zh) {
          var items = groups[zh];
          var warn =
            items.length > 1
              ? '<span class="pill pill-flag">' +
                items.length +
                " 种写法</span>"
              : '<span class="pill pill-neutral">单一写法</span>';
          var head =
            '<tr><td class="group-head" colspan="5">' +
            '<span class="zh">' +
            esc(zh) +
            "</span>" +
            '<span class="sub" style="margin-left:8px">' +
            items.length +
            " 个英文术语对</span>" +
            '<span style="float:right">' +
            warn +
            "</span>" +
            "</td></tr>";
          return head + termRows(items);
        })
        .join("");
      $("#terms-count").textContent =
        "共 " +
        STORE.pairs.length +
        " 条 · 归并为 " +
        order.length +
        " 个中文概念 · 当前显示 " +
        list.length +
        " 条";
    } else {
      body.innerHTML = termRows(list);
      $("#terms-count").textContent =
        "共 " + STORE.pairs.length + " 条 · 显示 " + list.length + " 条";
    }
  }

  /* ---------------- 渲染：文献 ---------------- */

  function renderDocs() {
    var host = $("#docs-list");
    var empty = $("#docs-empty");
    var q = STATE.q.trim().toLowerCase();
    var list = Object.keys(STORE.items)
      .map(function (key) {
        return STORE.items[key];
      })
      .filter(function (rec) {
        return !q || rec.title.toLowerCase().indexOf(q) >= 0;
      })
      .sort(function (a, b) {
        return b.extractedAt.localeCompare(a.extractedAt);
      });

    if (!Object.keys(STORE.items).length) {
      host.innerHTML = "";
      empty.innerHTML =
        '<div class="empty"><div class="t-title">还没有摄取过文献</div>' +
        "<p>右键一篇文献选择「提取术语」，摄取完成后文献会出现在这里。</p></div>";
      return;
    }
    if (!list.length) {
      host.innerHTML = "";
      empty.innerHTML =
        '<div class="empty"><div class="t-title">没有匹配的文献</div>' +
        "<p>共 " +
        Object.keys(STORE.items).length +
        " 篇已摄取文献，当前搜索结果为 0 篇。</p></div>";
      return;
    }
    empty.innerHTML = "";
    host.innerHTML = list
      .map(function (rec) {
        var pending = pendingCountForItem(rec.itemKey);
        return (
          '<button class="doc" type="button" data-doc="' +
          esc(rec.itemKey) +
          '">' +
          '<span class="doc-main">' +
          '<span class="doc-title">' +
          esc(rec.title) +
          "</span>" +
          '<span class="doc-meta">PDF · <span class="num">' +
          rec.pages +
          '</span> 页 · 摄取于 <span class="num">' +
          esc(rec.extractedAt.slice(0, 10)) +
          "</span></span>" +
          "</span>" +
          '<span class="doc-num">' +
          '<span class="metric"><span class="v">' +
          rec.pairs +
          '</span><br /><span class="k">术语对</span></span>' +
          '<span class="metric"><span class="v">' +
          pending +
          '</span><br /><span class="k">待确认</span></span>' +
          "</span>" +
          '<span class="chev" aria-hidden="true">→</span>' +
          "</button>"
        );
      })
      .join("");
  }

  function renderAll() {
    renderCounts();
    renderPending();
    renderTerms();
    renderDocs();
  }

  /* ---------------- 数据访问 ---------------- */

  function refresh() {
    return api
      .snapshot()
      .then(function (snapshot) {
        STORE = snapshot;
        renderAll();
        if (STATE.docFilter && !STORE.items[STATE.docFilter]) {
          STATE.docFilter = null;
        }
      })
      .catch(function (error) {
        toast("读取术语库失败：" + shortError(error));
      });
  }

  function shortError(error) {
    var message = error && error.message ? error.message : String(error);
    return message.length > 80 ? message.slice(0, 80) + "…" : message;
  }

  /* ---------------- 导出 ---------------- */

  function csvCell(value) {
    var text = String(value == null ? "" : value);
    if (/[",\n\r]/.test(text)) {
      return '"' + text.replace(/"/g, '""') + '"';
    }
    return text;
  }

  function exportPairs() {
    var rows = ["en,zh,role,status"];
    STORE.pairs.forEach(function (pair) {
      rows.push(
        [pair.en, pair.zh, pair.role, pair.status].map(csvCell).join(","),
      );
    });
    ZoteroRef.Utilities.Internal.copyTextToClipboard(rows.join("\n"));
    toast(
      "已复制 " +
        STORE.pairs.length +
        " 对术语（CSV 格式），可直接粘贴到翻译工作流",
    );
  }

  /* ---------------- toast ---------------- */

  var toastTimer = null;
  function toast(message, actionLabel, action) {
    var el = $("#toast");
    clearTimeout(toastTimer);
    el.innerHTML =
      "<span>" +
      esc(message) +
      "</span>" +
      (actionLabel
        ? '<button type="button" id="toast-act">' +
          esc(actionLabel) +
          "</button>"
        : "");
    el.classList.add("on");
    if (actionLabel && action) {
      $("#toast-act").addEventListener("click", function () {
        action();
        el.classList.remove("on");
      });
    }
    toastTimer = setTimeout(function () {
      el.classList.remove("on");
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
    $("#hints").style.display = view === "pending" ? "" : "none";
  }

  /* ---------------- 事件 ---------------- */

  function onConfirm(card) {
    var id = card.getAttribute("data-id");
    var entry = STORE.pending.find(function (item) {
      return item.id === id;
    });
    if (!entry) return;
    var zh = $('[data-field="zh"]', card).value.trim();
    var en = $('[data-field="en"]', card).value.trim();
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

  document.addEventListener("click", function (event) {
    var tab = event.target.closest("[data-view]");
    if (tab) {
      setView(tab.getAttribute("data-view"));
      return;
    }

    var act = event.target.closest("[data-act]");
    if (act) {
      var card = act.closest(".card");
      var id = card.getAttribute("data-id");
      var index = $$("#pending-list .card").indexOf(card);
      if (act.getAttribute("data-act") === "confirm") {
        onConfirm(card);
      } else {
        onReject(id, index);
      }
      return;
    }

    var ev = event.target.closest("[data-ev]");
    if (ev) {
      var key = ev.getAttribute("data-ev");
      STATE.expanded[key] = !STATE.expanded[key];
      renderTerms();
      return;
    }

    var jump = event.target.closest("[data-jump]");
    if (jump) {
      var itemKey = jump.getAttribute("data-jump");
      if (api.selectItem(itemKey)) {
        toast("已在文献面板定位该条目");
      } else {
        toast("无法定位条目：文献面板不可用");
      }
      return;
    }

    var doc = event.target.closest("[data-doc]");
    if (doc) {
      STATE.docFilter = doc.getAttribute("data-doc");
      setView("terms");
      renderTerms();
      toast("已按《" + itemTitle(STATE.docFilter) + "》过滤术语库");
      return;
    }

    if (event.target.closest("#export")) {
      exportPairs();
      return;
    }

    if (event.target.closest("#reject-low")) {
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
      return;
    }

    if (event.target.closest("#drift-toggle")) {
      STATE.drift = !STATE.drift;
      var btn = $("#drift-toggle");
      btn.setAttribute("aria-pressed", STATE.drift ? "true" : "false");
      btn.classList.toggle("btn-ghost", !STATE.drift);
      btn.classList.toggle("btn-primary", STATE.drift);
      renderTerms();
      return;
    }

    if (event.target.closest("#theme")) {
      var html = document.documentElement;
      html.setAttribute(
        "data-theme",
        html.getAttribute("data-theme") === "dark" ? "light" : "dark",
      );
      return;
    }
  });

  document.addEventListener("input", function (event) {
    if (event.target.id === "q") {
      STATE.q = event.target.value;
      renderPending();
      renderTerms();
      renderDocs();
      return;
    }
    /* 中英任一为空 → 确认按钮禁用 */
    var field = event.target.closest("[data-field]");
    if (field) {
      var card = field.closest(".card");
      var zh = $('[data-field="zh"]', card).value.trim();
      var en = $('[data-field="en"]', card).value.trim();
      var btn = $('[data-act="confirm"]', card);
      if (btn) {
        if (zh && en) {
          btn.removeAttribute("aria-disabled");
        } else {
          btn.setAttribute("aria-disabled", "true");
        }
      }
    }
  });

  document.addEventListener("keydown", function (event) {
    var meta = event.metaKey || event.ctrlKey;
    if (meta && event.key.toLowerCase() === "k") {
      event.preventDefault();
      $("#q").focus();
      $("#q").select();
      return;
    }
    if (event.key === "Escape" && document.activeElement === $("#q")) {
      STATE.q = "";
      $("#q").value = "";
      renderPending();
      renderTerms();
      renderDocs();
      $("#q").blur();
      return;
    }
    if (STATE.view !== "pending") return;
    var typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
    if (typing && event.key !== "Enter") return;

    var key = event.key.toLowerCase();
    if (key === "r") {
      event.preventDefault();
      var cardR = $$("#pending-list .card")[STATE.current];
      if (cardR) {
        onReject(cardR.getAttribute("data-id"), STATE.current);
      }
    } else if (key === "s") {
      event.preventDefault();
      setCurrent(STATE.current + 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      var cardE = $$("#pending-list .card")[STATE.current];
      if (!cardE) return;
      var btn = $('[data-act="confirm"]', cardE);
      if (btn && btn.getAttribute("aria-disabled") !== "true") {
        onConfirm(cardE);
      }
    }
  });

  /* ---------------- 启动 ---------------- */

  document.documentElement.setAttribute(
    "data-theme",
    window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light",
  );

  /* 主窗口在提取完成后调用此函数刷新本窗口 */
  window.TermGroundManagerRefresh = function () {
    if (api) {
      refresh();
    }
  };

  if (ensureApi()) {
    setView("pending");
    refresh().then(function () {
      setCurrent(0);
    });
  }
})();
