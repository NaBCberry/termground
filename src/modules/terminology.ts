/**
 * The plugin's user-facing surface: two item-menu commands.
 *
 * Kept deliberately small for now — extraction is the feature under test, so
 * the UI only needs to trigger it and report what happened.
 */

import { getString } from "../utils/locale";
import { growFromItems } from "./termPipeline.ts";
import { TermStore } from "./termStore.ts";

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
    `术语对 ${counts.pairs} · 证据 ${counts.evidence} · 已处理文献 ${counts.items} · verified ${counts.verified}`,
    "success",
  );
  ztoolkit.log("termground store", store.path(), counts);
}
