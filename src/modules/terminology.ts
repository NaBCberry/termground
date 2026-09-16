/**
 * The plugin's user-facing surface: two item-menu commands.
 *
 * Kept deliberately small for now — extraction is the feature under test, so
 * the UI only needs to trigger it and report what happened.
 */

import { getString } from "../utils/locale";
import { PROMOTE_SCORE } from "./termExtract.ts";
import { growFromItems } from "./termPipeline.ts";
import { TermStore, type PendingCandidate } from "./termStore.ts";

/** Only one extraction at a time; repeated clicks would otherwise pile up. */
let running = false;

function popup(closeTime: number) {
  return new ztoolkit.ProgressWindow(addon.data.config.addonName, {
    closeOnClick: true,
    closeTime,
    // Without this, repeated clicks stack popups on top of each other and the
    // user cannot tell which one is current.
    closeOtherProgressWindows: true,
  });
}

function notify(text: string, type: "default" | "success" | "fail" = "default") {
  popup(6000).createLine({ text, type, progress: 100 }).show();
}

/** Keep popup text on one screen line; the full error goes to the debug log. */
function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 90 ? `${message.slice(0, 90)}…` : message;
}

interface PromptService {
  BUTTON_POS_0: number;
  BUTTON_POS_1: number;
  BUTTON_POS_2: number;
  BUTTON_TITLE_IS_STRING: number;
  confirmEx(
    parent: Window | null,
    title: string,
    text: string,
    flags: number,
    button0: string,
    button1: string,
    button2: string,
    checkLabel: string | null,
    checkValue: { value: boolean },
  ): number;
}

function promptService(): PromptService {
  return ztoolkit.getGlobal("Services").prompt as PromptService;
}

/** How many candidates one review session will walk through. */
const MAX_REVIEW_PER_RUN = 40;

function reviewText(entry: PendingCandidate, index: number, total: number): string {
  const origin = entry.itemTitle
    ? `${entry.itemTitle}${entry.page ? ` p.${entry.page}` : ""}`
    : "来源未知";
  const quote = entry.quote
    ? entry.quote.length > 110
      ? `${entry.quote.slice(0, 110)}…`
      : entry.quote
    : "";
  return [
    `候选 ${index} / ${total}`,
    "",
    `中文：${entry.zh}`,
    `英文：${entry.en || "（缺失，入库时会询问）"}`,
    `出处：${origin}${entry.section ? ` · ${entry.section}` : ""}`,
    quote ? `原文：${quote}` : "",
    "",
    `抽取方式 ${entry.method} · 置信度 ${entry.score.toFixed(2)}`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function selectedItems(): Zotero.Item[] {
  const pane = Zotero.getActiveZoteroPane();
  return (pane?.getSelectedItems() ?? []) as Zotero.Item[];
}

export function registerMenus(): void {
  const icon = `chrome://${addon.data.config.addonRef}/content/icons/favicon@0.5x.png`;
  ztoolkit.Menu.register("item", {
    tag: "menuitem",
    id: "termground-itemmenu-extract",
    label: getString("menuitem-extract"),
    icon,
    commandListener: () => {
      void extractSelectedItems();
    },
  });
  ztoolkit.Menu.register("item", {
    tag: "menuitem",
    id: "termground-itemmenu-stats",
    label: getString("menuitem-stats"),
    icon,
    commandListener: () => {
      void showStats();
    },
  });
  ztoolkit.Menu.register("item", {
    tag: "menuitem",
    id: "termground-itemmenu-review",
    label: getString("menuitem-review"),
    icon,
    commandListener: () => {
      void reviewPending();
    },
  });
}

export async function extractSelectedItems(): Promise<void> {
  if (running) {
    notify(getString("progress-already-running"));
    return;
  }

  const items = selectedItems();
  if (!items.length) {
    notify(getString("progress-no-selection"));
    return;
  }

  const progress = popup(-1)
    .createLine({ text: getString("progress-extract-begin"), progress: 0 })
    .show();

  running = true;
  try {
    const store = await TermStore.load();
    const report = await growFromItems(items, store, (title) => {
      progress.changeLine({ text: `${getString("progress-reading")} ${title}` });
    });

    progress.changeLine({
      text: `${getString("progress-extract-done")} 新增 ${report.pairsAdded} 对，证据 ${report.evidenceAdded} 条`,
      progress: 100,
      type: "success",
    });
    progress.startCloseTimer(8000);
    ztoolkit.log("termground extract report", report);
  } catch (error) {
    progress.changeLine({
      text: `提取失败：${shortError(error)}`,
      progress: 100,
      type: "fail",
    });
    progress.startCloseTimer(10000);
    ztoolkit.log("termground extract failed", error);
  } finally {
    running = false;
  }
}

export async function showStats(): Promise<void> {
  const store = await TermStore.load();
  const counts = store.counts();
  notify(
    `术语对 ${counts.pairs} · 证据 ${counts.evidence} · 文献 ${counts.items} · 待确认 ${counts.pending} · verified ${counts.verified}`,
    "success",
  );
  ztoolkit.log("termground store", store.path(), counts);
}

/**
 * Walk the pending list one candidate at a time.
 *
 * A modal loop rather than a table window: the decisions are one-per-item and
 * the reviewer needs the full quote in front of them, which a narrow table cell
 * cannot show.
 */
export async function reviewPending(): Promise<void> {
  const store = await TermStore.load();
  const open = store.openPending();
  if (!open.length) {
    notify(getString("review-none"));
    return;
  }

  const win = Zotero.getMainWindow();
  const prompt = promptService();
  const flags =
    prompt.BUTTON_POS_0 * prompt.BUTTON_TITLE_IS_STRING +
    prompt.BUTTON_POS_1 * prompt.BUTTON_TITLE_IS_STRING +
    prompt.BUTTON_POS_2 * prompt.BUTTON_TITLE_IS_STRING;

  const total = Math.min(open.length, MAX_REVIEW_PER_RUN);
  let accepted = 0;
  let rejected = 0;

  for (let index = 0; index < total; index++) {
    const entry = open[index];
    const stopAfter = { value: false };
    const choice = prompt.confirmEx(
      win,
      addon.data.config.addonName,
      reviewText(entry, index + 1, total),
      flags,
      getString("review-accept"),
      getString("review-reject"),
      getString("review-skip"),
      getString("review-stop-after"),
      stopAfter,
    );

    if (choice === 0) {
      const edited: { zh?: string; en?: string } = {};
      // A candidate that was not auto-promoted usually failed on its Chinese
      // boundary, so that is the field worth correcting first.
      if (entry.score < PROMOTE_SCORE) {
        const zh = win.prompt(getString("review-fix-chinese"), entry.zh);
        if (zh === null) {
          if (stopAfter.value) break;
          continue;
        }
        if (zh.trim()) edited.zh = zh.trim();
      }
      if (!entry.en) {
        const en = win.prompt(getString("review-enter-english"), "");
        if (en === null) {
          if (stopAfter.value) break;
          continue;
        }
        if (!en.trim()) {
          if (stopAfter.value) break;
          continue;
        }
        edited.en = en.trim();
      }
      if (store.acceptPending(entry, edited)) accepted++;
    } else if (choice === 1) {
      store.rejectPending(entry);
      rejected++;
    }

    if (stopAfter.value) break;
  }

  await store.save();
  notify(
    `本次确认 ${accepted} 条，拒绝 ${rejected} 条，剩余待确认 ${store.pendingCounts().open} 条`,
    "success",
  );
}
