/**
 * The term-base manager window: the visual prototype turned into a real
 * chrome window (addon/content/manager.xhtml).
 *
 * This module owns the plugin side only — opening the window (single
 * instance), exposing a small data API on `addon.api.manager`, and the
 * global Tools-menu entry. The window's own script (manager.js) is a plain
 * asset loaded into the window scope and talks back through that API, so no
 * storage-layer code leaks into the window.
 */

import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { isWindowAlive } from "../utils/window";
import {
  TermStore,
  type Evidence,
  type ItemRecord,
  type PendingCandidate,
  type TermPair,
} from "./termStore.ts";

export interface ManagerSnapshot {
  pairs: TermPair[];
  evidence: Evidence[];
  items: Record<string, ItemRecord>;
  pending: PendingCandidate[];
  counts: ReturnType<TermStore["counts"]>;
}

/**
 * Fresh-load before every call and save immediately after every mutation:
 * the extraction flow in the main window loads and saves the same file, so
 * holding a long-lived store instance here would risk one side overwriting
 * the other. The term base is small, so the disk round-trip is cheap.
 */
async function withStore<T>(
  run: (store: TermStore) => T | Promise<T>,
): Promise<T> {
  const store = await TermStore.load();
  const result = await run(store);
  await store.save();
  return result;
}

function createManagerApi() {
  return {
    snapshot: async (): Promise<ManagerSnapshot> => {
      const store = await TermStore.load();
      return {
        pairs: store.data.pairs,
        evidence: store.data.evidence,
        items: store.data.items,
        pending: store.openPending(),
        counts: store.counts(),
      };
    },

    accept: async (
      id: string,
      edited: { zh: string; en: string },
    ): Promise<boolean> =>
      withStore((store) => {
        const entry = store
          .openPending()
          .find((candidate) => candidate.id === id);
        return entry ? store.acceptPending(entry, edited) : false;
      }),

    reject: async (id: string): Promise<void> =>
      withStore((store) => {
        const entry = store.data.pending.find(
          (candidate) => candidate.id === id,
        );
        if (entry) store.rejectPending(entry);
      }),

    rejectMany: async (ids: string[]): Promise<number> =>
      withStore((store) => {
        const idSet = new Set(ids);
        let rejected = 0;
        for (const entry of store.data.pending) {
          if (idSet.has(entry.id) && entry.status === "open") {
            store.rejectPending(entry);
            rejected++;
          }
        }
        return rejected;
      }),

    /** Undo a rejection — a deliberate human action, not auto-resurrection. */
    reopen: async (id: string): Promise<boolean> =>
      withStore((store) => store.reopenPending(id)),

    selectItem: (itemKey: string): boolean => {
      const pane = Zotero.getActiveZoteroPane();
      if (!pane) return false;
      void (
        pane as unknown as { selectItem: (key: string) => Promise<unknown> }
      ).selectItem(itemKey);
      return true;
    },
  };
}

/** The surface the manager window script (manager.js) calls into. */
export type ManagerApi = ReturnType<typeof createManagerApi>;

let managerWindow: Window | undefined;

/**
 * Where the window's 「诊断」 button writes its report.
 *
 * Deliberately on disk: the Zotero debug log only lives in the error console
 * in memory, and the clipboard can be unavailable, so both are useless when
 * the interface itself is the thing under investigation.
 */
function diagnosticsPath(): string | undefined {
  try {
    const PathUtils = ztoolkit.getGlobal("PathUtils");
    const dir = Zotero.DataDirectory.dir;
    return PathUtils.join(dir, "termground-manager-diagnostics.txt");
  } catch (error) {
    Zotero.debug(
      "TermGround: diagnostics path unavailable: " +
        ((error as Error).message ?? String(error)),
    );
    return undefined;
  }
}

function openManagerWindow(): void {
  if (isWindowAlive(managerWindow)) {
    managerWindow!.focus();
    return;
  }
  const Services = ztoolkit.getGlobal("Services");
  /*
   * Pass the plugin API and the two host objects through window.arguments
   * instead of reaching in afterwards. loadSubScript resolves the window
   * script's free variables against the target window, and what that scope
   * happens to expose is not something this side can verify — a reference
   * passed in as an argument is the window's own, so the window script never
   * has to guess how the host injected it.
   */
  const win = Services.ww.openWindow(
    null,
    `chrome://${config.addonRef}/content/manager.xhtml`,
    `${config.addonRef}-manager`,
    "chrome,dialog=no,resizable=yes,centerscreen,width=1120,height=760",
    {
      api: addon.api.manager,
      zotero: Zotero,
      services: Services,
      diagnosticsPath: diagnosticsPath(),
    },
  ) as Window;
  managerWindow = win;
  win.addEventListener(
    "load",
    () => {
      Services.scriptloader.loadSubScript(
        `chrome://${config.addonRef}/content/manager.js`,
        win,
      );
    },
    { once: true },
  );
}

/** Ping the open manager window so it reloads after the store changed. */
function refreshManagerWindows(): void {
  if (!isWindowAlive(managerWindow)) return;
  (
    managerWindow as { TermGroundManagerRefresh?: () => void }
  )?.TermGroundManagerRefresh?.();
}

function closeManagerWindow(): void {
  if (isWindowAlive(managerWindow)) {
    managerWindow!.close();
  }
  managerWindow = undefined;
}

/** Global entry: the term base is library-wide, not tied to a selection. */
function registerManagerMenus(): void {
  const icon = `chrome://${config.addonRef}/content/icons/favicon@0.5x.png`;
  ztoolkit.Menu.register("menuTools", {
    tag: "menuitem",
    id: `${config.addonRef}-menutools-manager`,
    label: getString("menutools-manager"),
    icon,
    commandListener: () => {
      openManagerWindow();
    },
  });
}

function setupManagerWindow(): void {
  addon.api.manager = createManagerApi();
}

export {
  closeManagerWindow,
  openManagerWindow,
  refreshManagerWindows,
  registerManagerMenus,
  setupManagerWindow,
};
