import { getPref } from "../utils/prefs";
import {
  protectCnkiTerms,
  restoreCnkiTerms,
  type RestoreReport,
} from "./cnkiTerms.ts";
import { TermStore } from "./termStore.ts";

interface TranslateTask {
  raw: string;
  result: string;
  service?: string;
  [key: string]: unknown;
}

interface TranslateService {
  id: string;
  translate: (task: TranslateTask) => Promise<void>;
}

interface TranslateForZotero {
  data?: {
    translate?: {
      services?: {
        getServiceById?: (id: string) => TranslateService | undefined;
      };
    };
  };
}

let patchedService: TranslateService | undefined;
let originalTranslate: ((task: TranslateTask) => Promise<void>) | undefined;

/**
 * Report what the post-translation restore actually enforced.
 *
 * Silent success is deliberate — translation runs constantly, and a popup on
 * every call would be noise. Silent *failure* is the thing this exists to stop:
 * a term whose marker did not survive translation keeps whatever wording the
 * engine chose, and until now nothing anywhere said so.
 */
function reportRestore(matched: number, report?: RestoreReport): void {
  if (!report) {
    ztoolkit.log(
      `termground: CNKI protected ${matched} terms but got no translated result to verify`,
    );
    return;
  }

  ztoolkit.log(
    `termground: CNKI terms protected=${matched} restored=${report.restored} lost=${report.lost}`,
  );
  if (!report.lost) return;

  const listed = report.lostTerms.slice(0, 5).join("、");
  const more = report.lost > 5 ? ` 等 ${report.lost} 条` : "";
  new ztoolkit.ProgressWindow(addon.data.config.addonName, {
    closeOnClick: true,
    closeTime: 12000,
    closeOtherProgressWindows: true,
  })
    .createLine({
      text: `TermGround：${report.lost} 条术语未被翻译服务保留（${listed}${more}），这几条译文可能没有统一`,
      type: "fail",
      progress: 100,
    })
    .show();
}

/** Add terminology protection without modifying Translate for Zotero itself. */
export async function installCnkiIntegration(): Promise<boolean> {
  const translateAddon = (Zotero as unknown as Record<string, unknown>)[
    "PDFTranslate"
  ] as TranslateForZotero | undefined;
  const cnki =
    translateAddon?.data?.translate?.services?.getServiceById?.("cnki");
  if (!cnki || typeof cnki.translate !== "function") {
    ztoolkit.log(
      "termground: Translate for Zotero CNKI service is not available",
    );
    return false;
  }
  if (patchedService === cnki) return true;

  patchedService = cnki;
  originalTranslate = cnki.translate;
  cnki.translate = async (task: TranslateTask): Promise<void> => {
    if (!getPref("enable") || !getPref("cnkiIntegration") || !task.raw) {
      return originalTranslate!(task);
    }

    const originalRaw = task.raw;
    let matched = 0;
    let report: RestoreReport | undefined;
    try {
      const store = await TermStore.load();
      const protectedText = protectCnkiTerms(originalRaw, store.data.pairs);
      matched = protectedText.terms.length;
      if (!matched) return await originalTranslate!(task);

      task.raw = protectedText.text;
      await originalTranslate!(task);
      if (typeof task.result === "string") {
        const restored = restoreCnkiTerms(task.result, protectedText.terms);
        task.result = restored.text;
        report = restored.report;
      }
    } finally {
      task.raw = originalRaw;
      if (matched) reportRestore(matched, report);
    }
  };

  ztoolkit.log("termground: CNKI terminology integration enabled");
  return true;
}

export function uninstallCnkiIntegration(): void {
  if (patchedService && originalTranslate) {
    patchedService.translate = originalTranslate;
  }
  patchedService = undefined;
  originalTranslate = undefined;
}
