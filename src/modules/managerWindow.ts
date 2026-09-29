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
  /*
   * Every mutation goes through here, so this is also where the automatic
   * backup lives: createBackup copies the store as it was before the write
   * and keeps the newest MAX_BACKUPS copies next to it.
   */
  await store.save({ backup: true });
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

    /*
     * Manual term editing. Unlike a candidate these have no extracted quote
     * behind them, so the data layer marks them human_review and each write
     * goes through withStore — which is also what leaves the backup.
     */
    create: async (input: { en: string; zh: string }): Promise<TermPair> =>
      withStore((store) => store.createTerm(input)),

    update: async (
      id: string,
      input: { en: string; zh: string },
    ): Promise<TermPair> => withStore((store) => store.updateTerm(id, input)),

    /**
     * Delete terms and hand back everything needed to undo it.
     *
     * The undo payload is captured on this side rather than reconstructed by
     * the window: once a term is edited its evidence rows still carry the old
     * text, so only the store can say which evidence belonged to which term.
     */
    remove: async (
      ids: string[],
    ): Promise<{
      pairs: number;
      evidence: number;
      undo: { pairs: TermPair[]; evidence: Evidence[] };
    }> =>
      withStore((store) => {
        const wanted = new Set(ids);
        const undo = {
          pairs: store.data.pairs.filter((pair) => wanted.has(pair.id)),
          evidence: ids.flatMap((id) => store.evidenceForTerm(id)),
        };
        return { ...store.deleteTerms(ids), undo };
      }),

    /** Undo the last delete — same deliberate-action rule as reopen. */
    restore: async (undo: {
      pairs: TermPair[];
      evidence: Evidence[];
    }): Promise<number> =>
      withStore((store) => {
        store.restoreDeleted(undo.pairs, undo.evidence);
        return undo.pairs.length;
      }),

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
 * Candidate paths for the window's diagnostics report.
 *
 * Deliberately files: the Zotero debug log only lives in the error console's
 * memory and never reaches `.scaffold/logs/zotero-*.log`, and the clipboard
 * can be unavailable — both are useless when the interface itself is the
 * thing under investigation.
 *
 * The window also receives the plugin root so its save dialog opens there and
 * its automatic writes land next to the running code.
 *
 * Separators are taken from each directory itself, the same way termStore
 * builds its paths: Mozilla's file APIs reject a mixed "C:\...\Zotero" +
 * "/name.txt" pair with NS_ERROR_FILE_UNRECOGNIZED_PATH.
 */
function joinDir(dir: unknown, name: string): string | null {
  if (typeof dir !== "string" || !dir) return null;
  const separator = dir.includes("\\") ? "\\" : "/";
  return dir.replace(/[\\/]+$/, "") + separator + name;
}

function diagnosticsFileCandidates(): string[] {
  const name = "termground-manager-diagnostics.txt";
  const out: string[] = [];
  const push = (path: string | null) => {
    if (path && !out.includes(path)) out.push(path);
  };

  try {
    push(joinDir(Zotero.DataDirectory?.dir, name));
  } catch (error) {
    Zotero.debug(
      "TermGround: DataDirectory lookup failed: " +
        ((error as Error).message ?? String(error)),
    );
  }
  try {
    push(joinDir(Zotero.getMainWindow()?.Zotero?.DataDirectory?.dir, name));
  } catch (error) {
    Zotero.debug(
      "TermGround: main-window DataDirectory lookup failed: " +
        ((error as Error).message ?? String(error)),
    );
  }

  Zotero.debug("TermGround: manager diagnostics files -> " + out.join(" , "));
  return out;
}

/** The plugin's running root, so diagnostics can be saved next to the code. */
function pluginRoot(): string | null {
  try {
    const root = ztoolkit.getGlobal("rootURI") as string | undefined;
    if (!root) return null;
    const PathUtils = ztoolkit.getGlobal("PathUtils") as
      | { fromFileURI?: (uri: string) => string }
      | undefined;
    if (PathUtils && PathUtils.fromFileURI) {
      return PathUtils.fromFileURI(root);
    }
    /* Fallback: file:///D:/x/y/ -> D:/x/y */
    const decoded = decodeURIComponent(root.replace(/^file:\/\//, ""));
    return decoded.replace(/^\/([a-zA-Z]:)/, "$1");
  } catch (error) {
    Zotero.debug(
      "TermGround: cannot resolve plugin root: " +
        ((error as Error).message ?? String(error)),
    );
    return null;
  }
}

function openManagerWindow(): void {
  if (isWindowAlive(managerWindow)) {
    managerWindow!.focus();
    return;
  }
  const Services = ztoolkit.getGlobal("Services");
  /*
   * The window gets the plugin API handed to it directly. Both channels used
   * before proved unreliable in the real window: `window.arguments` arrives
   * empty (measured: one argument, no keys) and the window scope has neither
   * `Zotero` nor `window.Zotero`, so the script could not reach the plugin at
   * all and the pending view only ever showed "插件接口不可用".
   *
   * The injection happens in the load handler, immediately before the window
   * script runs, so nothing else can overwrite it in between.
   */
  const host = {
    api: addon.api.manager,
    zotero: Zotero,
    services: Services,
    diagnosticsPath: diagnosticsFileCandidates(),
    basePath: pluginRoot(),
  };
  const win = Services.ww.openWindow(
    null,
    `chrome://${config.addonRef}/content/manager.xhtml`,
    `${config.addonRef}-manager`,
    "chrome,centerscreen,resizable=yes,dialog=no,width=1120,height=760",
    host,
  ) as Window;
  managerWindow = win;
  win.addEventListener(
    "load",
    () => {
      injectHost(win, host);
      Services.scriptloader.loadSubScript(
        `chrome://${config.addonRef}/content/manager.js`,
        win,
      );
    },
    { once: true },
  );
}

/**
 * Hand the host object to the window before its script runs.
 *
 * `window.arguments` is populated from the openWindow argument, but in practice
 * the window script saw an empty object, so the same references are also set as
 * window properties — on the Xray wrapper and, when available, on the raw
 * window object, because the two sides are separate compartments.
 */
function injectHost(win: Window, host: Record<string, unknown>): void {
  const w = win as unknown as Record<string, unknown> & {
    wrappedJSObject?: Record<string, unknown>;
  };
  const targets: Record<string, unknown>[] = [];
  try {
    if (w.wrappedJSObject) targets.push(w.wrappedJSObject);
  } catch (error) {
    Zotero.debug(
      "TermGround: wrappedJSObject unavailable: " +
        ((error as Error).message ?? String(error)),
    );
  }
  targets.push(w);
  for (const target of targets) {
    target.__TermGroundHost = host;
    /* keep the flattened keys too: older window scripts read them directly */
    target.termgroundApi = host.api;
    target.termgroundZotero = host.zotero;
    target.termgroundServices = host.services;
    target.termgroundDiagnosticsPath = host.diagnosticsPath;
    target.termgroundBasePath = host.basePath;
  }
  /* window.arguments is unreliable, but keep it correct when it does work */
  try {
    (w as { arguments?: unknown }).arguments = [host];
  } catch (error) {
    Zotero.debug(
      "TermGround: cannot set window.arguments: " +
        ((error as Error).message ?? String(error)),
    );
  }
  Zotero.debug("TermGround: manager host injected into window scope");
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
