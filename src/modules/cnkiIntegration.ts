import { getPref } from "../utils/prefs";
import { protectCnkiTerms, restoreCnkiTerms } from "./cnkiTerms.ts";
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
    try {
      const store = await TermStore.load();
      const protectedText = protectCnkiTerms(originalRaw, store.data.pairs);
      matched = protectedText.terms.length;
      if (!matched) return await originalTranslate!(task);

      task.raw = protectedText.text;
      await originalTranslate!(task);
      if (typeof task.result === "string") {
        task.result = restoreCnkiTerms(task.result, protectedText.terms);
      }
    } finally {
      task.raw = originalRaw;
      if (matched) {
        ztoolkit.log(`termground: applied ${matched} CNKI glossary matches`);
      }
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
