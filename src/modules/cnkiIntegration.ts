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

/** 一次会话只提醒一次：翻译调用很频繁，每次都弹只会变成噪音。 */
let restoreNoticeShown = false;

/** 结果里一个汉字都没有，就不可能是英文原文的译文。 */
function looksUntranslated(text: string): boolean {
  return !/[\u4e00-\u9fff]/.test(text);
}

/**
 * Report what the post-translation restore actually enforced.
 *
 * Silent success is deliberate — translation runs constantly, and a popup on
 * every call would be noise. Silent *failure* is the thing this exists to stop:
 * a term whose marker did not survive translation keeps whatever wording the
 * engine chose, and until now nothing anywhere said so.
 *
 * Never throws: this runs in the translate patch's finally block, and a failing
 * report must not turn a working translation into a failed one.
 */
function reportRestore(
  matched: number,
  report: RestoreReport | undefined,
  retried: boolean,
): void {
  try {
    if (!report) {
      ztoolkit.log(
        `termground: CNKI protected ${matched} terms but got no translated result to verify`,
      );
      return;
    }

    ztoolkit.log(
      `termground: CNKI terms protected=${matched} restored=${report.restored} lost=${report.lost}${
        retried ? " retried=unprotected" : ""
      }`,
    );
    if (!report.lost) return;
    if (restoreNoticeShown) return;
    restoreNoticeShown = true;

    const listed = report.lostTerms.slice(0, 5).join("、");
    const more = report.lost > 5 ? ` 等 ${report.lost} 条` : "";
    new ztoolkit.ProgressWindow(addon.data.config.addonName, {
      closeOnClick: true,
      closeTime: 12000,
      closeOtherProgressWindows: true,
    })
      .createLine({
        text: retried
          ? `TermGround：${report.lost} 条术语未被翻译服务保留（${listed}${more}），已按原文重新翻译，这几条译名未统一`
          : `TermGround：${report.lost} 条术语未被翻译服务保留（${listed}${more}），这几条译文可能没有统一`,
        type: "fail",
        progress: 100,
      })
      .show();
  } catch (error) {
    ztoolkit.log("termground: failed to report CNKI restore", error);
  }
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
    let retried = false;
    try {
      const store = await TermStore.load();
      const protectedText = protectCnkiTerms(originalRaw, store.data.pairs);
      matched = protectedText.terms.length;
      if (!matched) return await originalTranslate!(task);

      task.raw = protectedText.text;
      await originalTranslate!(task);

      let restored =
        typeof task.result === "string"
          ? restoreCnkiTerms(task.result, protectedText.terms)
          : undefined;
      report = restored?.report;

      /*
       * 实测 CNKI 处理不了带标记的文本：返回里从来没有完整的标记对
       * （restored=0），而且是原文回显，Zotero 因此判定「没翻译」、把英文原文
       * 顶给用户。术语保护是尽力而为——宁可这一次不强制统一译名，也不能让人
       * 拿不到译文，所以拿原始文本再翻一次。
       *
       * 只在结果里一个汉字都没有时才重试：真的翻出来了（哪怕没守住标记）就
       * 没必要多打一次请求，CNKI 本来就有限流。
       */
      if (
        restored &&
        restored.report.restored === 0 &&
        looksUntranslated(task.result)
      ) {
        retried = true;
        task.raw = originalRaw;
        await originalTranslate!(task);
        restored =
          typeof task.result === "string"
            ? restoreCnkiTerms(task.result, protectedText.terms)
            : undefined;
      }

      if (restored) task.result = restored.text;
    } finally {
      task.raw = originalRaw;
      if (matched) reportRestore(matched, report, retried);
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
