import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { TermStore } from "./termStore.ts";

/**
 * Preference pane bootstrap.
 *
 * Deliberately thin: the pane only needs to tell the user where the term base
 * lives so it can be backed up or inspected. Everything else is driven from the
 * item menu.
 */
export async function registerPrefsScripts(window: Window): Promise<void> {
  const target = window.document?.querySelector(
    `#${config.addonRef}-base-path`,
  );
  if (!target) return;
  try {
    const store = await TermStore.load();
    target.textContent = `${getString("pref-base-path")} ${store.path()}`;
  } catch (error) {
    target.textContent = String(error);
    ztoolkit.log("termground: failed to load term base path", error);
  }
}

