import type { DialogHelper } from "zotero-plugin-toolkit";
import {
  TermStore,
  type Evidence,
  type TermInput,
  type TermPair,
} from "./termStore.ts";

const PAGE_SIZE = 100;
let manager: DialogHelper | undefined;

type SortKey = "en" | "zh" | "status" | "source" | "confidence" | "updatedAt";

function h<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const element = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    tag,
  ) as HTMLElementTagNameMap[K];
  if (className) element.className = className;
  return element;
}

function option(
  doc: Document,
  value: string,
  label: string,
): HTMLOptionElement {
  const item = h(doc, "option");
  item.value = value;
  item.textContent = label;
  return item;
}

function statusLabel(status: TermPair["status"]): string {
  return { verified: "已验证", attested: "已收录", suggested: "建议/人工" }[
    status
  ];
}

function sourceLabel(source: string): string {
  const labels: Record<string, string> = {
    human_review: "人工录入",
    author_note: "作者注释",
    bilingual_keyword: "双语关键词",
  };
  return labels[source] ?? source;
}

function addStyles(doc: Document): void {
  const style = h(doc, "style");
  style.textContent = `
    :root { color-scheme: light dark; }
    body { margin: 0; font: menu; }
    #termground-manager-root { height: 100%; min-height: 560px; }
    .tg-shell { box-sizing: border-box; display: grid; grid-template-rows: auto 1fr auto;
      gap: 10px; height: 100%; padding: 12px; background: Canvas; color: CanvasText; }
    .tg-toolbar, .tg-footer, .tg-actions { display: flex; align-items: center; gap: 8px; }
    .tg-toolbar input[type=search] { min-width: 260px; flex: 1; }
    .tg-toolbar input, .tg-toolbar select, .tg-button, .tg-editor input, .tg-editor select {
      box-sizing: border-box; min-height: 30px; padding: 4px 8px; font: inherit; }
    .tg-button { cursor: pointer; }
    .tg-button.danger { color: #b42318; }
    .tg-main { min-height: 0; display: grid; grid-template-columns: minmax(520px, 2fr) minmax(300px, 1fr); gap: 12px; }
    .tg-list, .tg-detail { min-height: 0; border: 1px solid color-mix(in srgb, CanvasText 22%, transparent);
      border-radius: 6px; overflow: hidden; }
    .tg-list { display: flex; flex-direction: column; }
    .tg-table-wrap { min-height: 0; flex: 1; overflow: auto; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { padding: 7px 8px; border-bottom: 1px solid color-mix(in srgb, CanvasText 14%, transparent);
      text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    th { position: sticky; top: 0; z-index: 1; background: Canvas; }
    th button { border: 0; padding: 0; background: transparent; color: inherit; font: inherit; font-weight: 600; cursor: pointer; }
    tr[data-id] { cursor: pointer; }
    tr[data-id]:hover, tr.active { background: color-mix(in srgb, AccentColor 14%, Canvas); }
    .tg-detail { overflow: auto; padding: 12px; }
    .tg-detail h2 { margin: 0 0 12px; font-size: 1.15rem; }
    .tg-editor { display: grid; grid-template-columns: 90px 1fr; align-items: center; gap: 8px; }
    .tg-editor input, .tg-editor select { width: 100%; }
    .tg-editor .tg-wide { grid-column: 1 / -1; }
    .tg-evidence { margin-top: 16px; }
    .tg-evidence article { margin: 8px 0; padding: 8px; border-radius: 5px;
      background: color-mix(in srgb, CanvasText 6%, Canvas); white-space: normal; }
    .tg-muted { opacity: .7; }
    .tg-message { min-height: 1.2em; color: #b42318; }
    .tg-footer { justify-content: space-between; }
    @media (max-width: 880px) { .tg-main { grid-template-columns: 1fr; } .tg-detail { max-height: 45%; } }
  `;
  doc.head?.appendChild(style);
}

async function initialize(win: Window): Promise<void> {
  const doc = win.document;
  addStyles(doc);
  const root = doc.querySelector<HTMLElement>("#termground-manager-root");
  if (!root) return;

  let store = await TermStore.load();
  let filtered: TermPair[] = [];
  const selected = new Set<string>();
  let currentId = "";
  let editingNew = false;
  let page = 1;
  let sortKey: SortKey = "updatedAt";
  let sortDirection: 1 | -1 = -1;
  let lastDeleted: { pairs: TermPair[]; evidence: Evidence[] } | undefined;

  const shell = h(doc, "div", "tg-shell");
  const toolbar = h(doc, "div", "tg-toolbar");
  const search = h(doc, "input");
  search.type = "search";
  search.placeholder = "搜索英文、中文或缩写";
  const statusFilter = h(doc, "select");
  statusFilter.append(
    option(doc, "", "全部状态"),
    option(doc, "verified", "已验证"),
    option(doc, "attested", "已收录"),
    option(doc, "suggested", "建议/人工"),
  );
  const sourceFilter = h(doc, "select");
  const newButton = h(doc, "button", "tg-button");
  newButton.textContent = "＋ 新建术语";
  toolbar.append(search, statusFilter, sourceFilter, newButton);

  const main = h(doc, "div", "tg-main");
  const list = h(doc, "section", "tg-list");
  const tableWrap = h(doc, "div", "tg-table-wrap");
  const table = h(doc, "table");
  const thead = h(doc, "thead");
  const headRow = h(doc, "tr");
  const selectHead = h(doc, "th");
  selectHead.style.width = "34px";
  const selectPage = h(doc, "input");
  selectPage.type = "checkbox";
  selectPage.title = "选择当前页";
  selectHead.append(selectPage);
  headRow.append(selectHead);
  const columns: Array<[SortKey, string, string]> = [
    ["en", "英文术语", "28%"],
    ["zh", "中文译名", "23%"],
    ["status", "状态", "11%"],
    ["source", "来源", "14%"],
    ["confidence", "可信度", "10%"],
    ["updatedAt", "修改时间", "14%"],
  ];
  for (const [key, label, width] of columns) {
    const th = h(doc, "th");
    th.style.width = width;
    const button = h(doc, "button");
    button.textContent = label;
    button.dataset.sort = key;
    th.append(button);
    headRow.append(th);
  }
  thead.append(headRow);
  const tbody = h(doc, "tbody");
  table.append(thead, tbody);
  tableWrap.append(table);
  list.append(tableWrap);

  const detail = h(doc, "aside", "tg-detail");
  const detailTitle = h(doc, "h2");
  const editor = h(doc, "div", "tg-editor");
  const fields: Record<string, HTMLInputElement | HTMLSelectElement> = {};
  const addInput = (name: string, label: string, type = "text") => {
    const caption = h(doc, "label");
    caption.textContent = label;
    const input = h(doc, "input");
    input.type = type;
    input.id = `tg-${name}`;
    fields[name] = input;
    editor.append(caption, input);
  };
  addInput("en", "英文术语");
  addInput("zh", "中文译名");
  addInput("abbr", "缩写");
  const statusLabelElement = h(doc, "label");
  statusLabelElement.textContent = "状态";
  const status = h(doc, "select");
  status.append(
    option(doc, "verified", "已验证"),
    option(doc, "attested", "已收录"),
    option(doc, "suggested", "建议/人工"),
  );
  fields.status = status;
  editor.append(statusLabelElement, status);
  addInput("confidence", "可信度", "number");
  (fields.confidence as HTMLInputElement).min = "0";
  (fields.confidence as HTMLInputElement).max = "1";
  (fields.confidence as HTMLInputElement).step = "0.01";
  const sourceText = h(doc, "p", "tg-muted tg-wide");
  const message = h(doc, "p", "tg-message tg-wide");
  const actions = h(doc, "div", "tg-actions tg-wide");
  const saveButton = h(doc, "button", "tg-button");
  saveButton.textContent = "保存";
  const deleteButton = h(doc, "button", "tg-button danger");
  deleteButton.textContent = "删除选中术语";
  actions.append(saveButton, deleteButton);
  editor.append(sourceText, message, actions);
  const evidenceBox = h(doc, "section", "tg-evidence");
  detail.append(detailTitle, editor, evidenceBox);
  main.append(list, detail);

  const footer = h(doc, "footer", "tg-footer");
  const summary = h(doc, "span");
  const pager = h(doc, "div", "tg-actions");
  const prev = h(doc, "button", "tg-button");
  const pageLabel = h(doc, "span");
  const next = h(doc, "button", "tg-button");
  const undo = h(doc, "button", "tg-button");
  prev.textContent = "上一页";
  next.textContent = "下一页";
  undo.textContent = "撤销删除";
  undo.hidden = true;
  pager.append(undo, prev, pageLabel, next);
  footer.append(summary, pager);
  shell.append(toolbar, main, footer);
  root.replaceChildren(shell);

  const getCurrent = () =>
    store.data.pairs.find((item) => item.id === currentId);
  const inputData = (): TermInput => ({
    en: (fields.en as HTMLInputElement).value,
    zh: (fields.zh as HTMLInputElement).value,
    abbr: (fields.abbr as HTMLInputElement).value,
    status: fields.status.value as TermPair["status"],
    confidence: Number((fields.confidence as HTMLInputElement).value),
    source: editingNew ? "human_review" : getCurrent()?.source,
  });

  const renderDetail = () => {
    const pair = getCurrent();
    const disabled = !pair && !editingNew;
    detailTitle.textContent = editingNew
      ? "新建术语"
      : pair
        ? "术语详情"
        : "请选择一条术语";
    for (const field of Object.values(fields)) field.disabled = disabled;
    saveButton.disabled = disabled;
    deleteButton.disabled = !selected.size && !pair;
    if (!pair && !editingNew) {
      for (const field of Object.values(fields)) field.value = "";
      sourceText.textContent = "";
      evidenceBox.replaceChildren();
      return;
    }
    const value = pair;
    fields.en.value = value?.en ?? "";
    fields.zh.value = value?.zh ?? "";
    fields.abbr.value = value?.abbr ?? "";
    fields.status.value = value?.status ?? "suggested";
    fields.confidence.value = String(value?.confidence ?? 1);
    sourceText.textContent = value
      ? `来源：${sourceLabel(value.source)} · 创建：${new Date(value.at).toLocaleString()}`
      : "人工新建术语将优先用于翻译。";
    evidenceBox.replaceChildren();
    if (!value) return;
    const title = h(doc, "h3");
    const evidence = store.evidenceForTerm(value.id);
    title.textContent = `使用证据（${evidence.length}）`;
    evidenceBox.append(title);
    if (!evidence.length) {
      const empty = h(doc, "p", "tg-muted");
      empty.textContent = "这条术语没有文献证据。";
      evidenceBox.append(empty);
    }
    for (const item of evidence) {
      const article = h(doc, "article");
      const itemTitle = item.itemKey
        ? store.data.items[item.itemKey]?.title || item.itemKey
        : "来源未知";
      const meta = h(doc, "div", "tg-muted");
      meta.textContent = `${itemTitle}${item.page ? ` · p.${item.page}` : ""}${item.section ? ` · ${item.section}` : ""}`;
      const quote = h(doc, "div");
      quote.textContent = item.quote || "（没有保存原句）";
      article.append(meta, quote);
      evidenceBox.append(article);
    }
  };

  const refreshSources = () => {
    const old = sourceFilter.value;
    sourceFilter.replaceChildren(option(doc, "", "全部来源"));
    for (const source of [
      ...new Set(store.data.pairs.map((item) => item.source)),
    ].sort()) {
      sourceFilter.append(option(doc, source, sourceLabel(source)));
    }
    sourceFilter.value = old;
  };

  const renderTable = () => {
    const query = search.value.trim().toLocaleLowerCase();
    filtered = store.data.pairs.filter((pair) => {
      const matchesText =
        !query ||
        [pair.en, pair.zh, pair.abbr ?? ""].some((value) =>
          value.toLocaleLowerCase().includes(query),
        );
      return (
        matchesText &&
        (!statusFilter.value || pair.status === statusFilter.value) &&
        (!sourceFilter.value || pair.source === sourceFilter.value)
      );
    });
    filtered.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === "number" && typeof bv === "number")
        return (av - bv) * sortDirection;
      return (
        String(av ?? "").localeCompare(String(bv ?? ""), "zh-CN") *
        sortDirection
      );
    });
    const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    page = Math.min(page, pages);
    const rows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    tbody.replaceChildren();
    for (const pair of rows) {
      const row = h(doc, "tr");
      row.dataset.id = pair.id;
      if (pair.id === currentId) row.classList.add("active");
      const checkCell = h(doc, "td");
      const check = h(doc, "input");
      check.type = "checkbox";
      check.checked = selected.has(pair.id);
      check.addEventListener("click", (event) => event.stopPropagation());
      check.addEventListener("change", () => {
        if (check.checked) selected.add(pair.id);
        else selected.delete(pair.id);
        renderDetail();
        summary.textContent = `共 ${filtered.length} 条术语 · 已选择 ${selected.size} 条`;
      });
      checkCell.append(check);
      row.append(checkCell);
      for (const value of [
        pair.en,
        pair.zh,
        statusLabel(pair.status),
        sourceLabel(pair.source),
        pair.confidence.toFixed(2),
        new Date(pair.updatedAt).toLocaleDateString(),
      ]) {
        const cell = h(doc, "td");
        cell.textContent = value;
        cell.title = value;
        row.append(cell);
      }
      row.addEventListener("click", () => {
        editingNew = false;
        currentId = pair.id;
        message.textContent = "";
        renderTable();
        renderDetail();
      });
      tbody.append(row);
    }
    const pageIds = rows.map((item) => item.id);
    selectPage.checked =
      pageIds.length > 0 && pageIds.every((id) => selected.has(id));
    summary.textContent = `共 ${filtered.length} 条术语 · 已选择 ${selected.size} 条`;
    pageLabel.textContent = `${page} / ${pages}`;
    prev.disabled = page <= 1;
    next.disabled = page >= pages;
  };

  const mutate = async <T>(
    action: (fresh: TermStore) => T,
    afterSave?: (result: T) => void,
  ) => {
    message.textContent = "";
    try {
      const fresh = await TermStore.load();
      const result = action(fresh);
      await fresh.save({ backup: true });
      store = fresh;
      afterSave?.(result);
      refreshSources();
      renderTable();
      renderDetail();
    } catch (error) {
      message.textContent =
        error instanceof Error ? error.message : String(error);
    }
  };

  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  search.addEventListener("input", () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      page = 1;
      renderTable();
    }, 200);
  });
  statusFilter.addEventListener("change", () => {
    page = 1;
    renderTable();
  });
  sourceFilter.addEventListener("change", () => {
    page = 1;
    renderTable();
  });
  thead.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest(
      "button[data-sort]",
    ) as HTMLButtonElement | null;
    if (!target) return;
    const key = target.dataset.sort as SortKey;
    sortDirection = sortKey === key ? (sortDirection === 1 ? -1 : 1) : 1;
    sortKey = key;
    renderTable();
  });
  selectPage.addEventListener("change", () => {
    for (const pair of filtered.slice(
      (page - 1) * PAGE_SIZE,
      page * PAGE_SIZE,
    )) {
      if (selectPage.checked) selected.add(pair.id);
      else selected.delete(pair.id);
    }
    renderTable();
    renderDetail();
  });
  newButton.addEventListener("click", () => {
    editingNew = true;
    currentId = "";
    selected.clear();
    message.textContent = "";
    renderTable();
    renderDetail();
    fields.en.focus();
  });
  saveButton.addEventListener("click", () => {
    const wasNew = editingNew;
    const id = currentId;
    const values = inputData();
    void mutate(
      (fresh) =>
        wasNew ? fresh.createTerm(values) : fresh.updateTerm(id, values),
      (saved) => {
        currentId = saved.id;
        editingNew = false;
      },
    );
  });
  deleteButton.addEventListener("click", () => {
    const ids = selected.size ? [...selected] : currentId ? [currentId] : [];
    if (
      !ids.length ||
      !win.confirm(`确定删除 ${ids.length} 条术语及其关联证据吗？`)
    )
      return;
    void mutate(
      (fresh) => {
        const targetIds = new Set(ids);
        const pairs = fresh.data.pairs.filter((pair) => targetIds.has(pair.id));
        const evidence = fresh.data.evidence.filter((item) =>
          targetIds.has(item.termId),
        );
        fresh.deleteTerms(ids);
        return { pairs, evidence };
      },
      (deleted) => {
        lastDeleted = deleted;
        undo.hidden = false;
        selected.clear();
        currentId = "";
        editingNew = false;
      },
    );
  });
  undo.addEventListener("click", () => {
    if (!lastDeleted) return;
    const snapshot = lastDeleted;
    void mutate(
      (fresh) => fresh.restoreDeleted(snapshot.pairs, snapshot.evidence),
      () => {
        lastDeleted = undefined;
        undo.hidden = true;
      },
    );
  });
  prev.addEventListener("click", () => {
    if (page > 1) {
      page--;
      renderTable();
    }
  });
  next.addEventListener("click", () => {
    if (page * PAGE_SIZE < filtered.length) {
      page++;
      renderTable();
    }
  });

  refreshSources();
  renderTable();
  renderDetail();
}

export function openTermManager(): void {
  if (manager?.window && !manager.window.closed) {
    manager.window.focus();
    return;
  }
  manager = new ztoolkit.Dialog(1, 1)
    .addCell(0, 0, {
      tag: "div",
      namespace: "html",
      id: "termground-manager-root",
      styles: { width: "100%", height: "100%" },
    })
    .setDialogData({
      loadCallback: () => void initialize(manager!.window),
      unloadCallback: () => {
        manager = undefined;
        addon.data.dialog = undefined;
      },
    })
    .open("TermGround 术语库", {
      width: 1120,
      height: 720,
      centerscreen: true,
      resizable: true,
      fitContent: false,
      noDialogMode: true,
    });
  addon.data.dialog = manager;
}
