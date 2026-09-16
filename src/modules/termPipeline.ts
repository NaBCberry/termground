/**
 * Turns selected Zotero items into term-base growth.
 *
 * The text comes from Zotero's own PDF extraction, which inserts a form feed
 * between pages, so page numbers are available without any PDF parsing of our
 * own.
 */

import {
  detectSection,
  splitBlocks,
  splitPages,
  splitSentences,
} from "./textUtils.ts";
import {
  extractFromSegments,
  splitCandidates,
  type Segment,
} from "./termExtract.ts";
import { TermStore } from "./termStore.ts";

export interface ExtractReport {
  items: number;
  attachments: number;
  pages: number;
  segments: number;
  candidates: number;
  pairsAdded: number;
  evidenceAdded: number;
  pendingAdded: number;
  /** Candidates thrown away as unusable; reported so the loss is visible. */
  rejected: number;
  skipped: string[];
}

interface FullTextResult {
  text: string;
  extractedPages: number;
  totalPages: number;
}

/**
 * Zotero exposes the PDF text layer as an untyped global; wrap it so the rest of
 * the code is typed and the call site is easy to find if the API moves.
 */
async function getAttachmentText(attachmentID: number): Promise<FullTextResult> {
  const worker = Zotero.PDFWorker as {
    getFullText(
      itemID: number,
      maxPages?: number | null,
      isPriority?: boolean,
      password?: string,
    ): Promise<FullTextResult>;
  };
  return worker.getFullText(attachmentID, null);
}

export function segmentsFromText(text: string): Segment[] {
  const segments: Segment[] = [];
  splitPages(text).forEach((pageText, index) => {
    const page = index + 1;
    let section = "body";
    for (const block of splitBlocks(pageText)) {
      const heading = detectSection(block);
      if (heading) section = heading;
      for (const sentence of splitSentences(block)) {
        if (!sentence.trim()) continue;
        segments.push({ page, section, text: sentence });
      }
    }
  });
  return segments;
}

/** Expand any selection into the PDF attachments we can actually read. */
export function pdfAttachmentsOf(items: Zotero.Item[]): Zotero.Item[] {
  const out: Zotero.Item[] = [];
  const seen = new Set<number>();
  const push = (item: Zotero.Item | false) => {
    if (!item || !item.isPDFAttachment()) return;
    if (seen.has(item.id)) return;
    seen.add(item.id);
    out.push(item);
  };
  for (const item of items) {
    if (item.isPDFAttachment()) {
      push(item);
      continue;
    }
    for (const attachmentID of item.getAttachments()) {
      push(Zotero.Items.get(attachmentID));
    }
  }
  return out;
}

export async function growFromItems(
  items: Zotero.Item[],
  store: TermStore,
  onStep?: (message: string) => void,
): Promise<ExtractReport> {
  const report: ExtractReport = {
    items: items.length,
    attachments: 0,
    pages: 0,
    segments: 0,
    candidates: 0,
    pairsAdded: 0,
    evidenceAdded: 0,
    pendingAdded: 0,
    rejected: 0,
    skipped: [],
  };

  const attachments = pdfAttachmentsOf(items);
  const known = store.knownZhLemmas();

  for (const attachment of attachments) {
    const parent = attachment.parentItem;
    const label = parent?.getField("title") || attachment.getField("title");
    onStep?.(String(label || "未命名文献"));

    let fullText: FullTextResult;
    try {
      fullText = await getAttachmentText(attachment.id);
    } catch (error) {
      report.skipped.push(`${label}: 取全文失败`);
      ztoolkit.log("getFullText failed", error);
      continue;
    }
    if (!fullText?.text) {
      report.skipped.push(`${label}: 没有可提取的文本`);
      continue;
    }

    const segments = segmentsFromText(fullText.text);
    const { candidates, stats } = extractFromSegments(segments, known);
    const { promotable, pending } = splitCandidates(candidates);

    const itemKey = String(parent?.key ?? attachment.key);
    const itemTitle = String(label || "");
    let added = 0;
    const evidenceBefore = store.data.evidence.length;
    for (const candidate of promotable) {
      if (store.addCandidate(candidate, { itemKey })) added++;
    }
    report.evidenceAdded += store.data.evidence.length - evidenceBefore;
    for (const candidate of pending) {
      if (
        store.addPending(candidate, { itemKey, itemTitle }) === "new"
      ) {
        report.pendingAdded++;
      }
    }

    report.attachments++;
    report.pages += fullText.extractedPages || 0;
    report.segments += stats.segments;
    report.candidates += candidates.length;
    report.pairsAdded += added;
    report.rejected += stats.rejected;

    // Terms learned from this paper should inform the next one's boundaries.
    for (const pair of store.data.pairs) known.add(pair.zh);

    store.recordItem({
      itemKey,
      libraryID: attachment.libraryID,
      title: itemTitle,
      pages: fullText.extractedPages || 0,
      candidates: candidates.length,
      pairs: added,
      extractedAt: new Date().toISOString(),
    });
  }

  await store.save();
  return report;
}
