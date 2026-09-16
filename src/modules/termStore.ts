/**
 * The term base: a JSON file under Zotero's data directory.
 *
 * A plugin-owned file is deliberately chosen over extra Zotero database tables:
 * no schema coupling, it survives Zotero upgrades untouched, and the whole base
 * is small enough (thousands of pairs) to keep in memory.
 */

import { cleanSurface, lemmaEn, lemmaZh } from "./textUtils.ts";
import { PROMOTABLE, type Candidate } from "./termExtract.ts";

export interface TermPair {
  en: string;
  zh: string;
  abbr?: string;
  role: "preferred" | "admitted";
  status: "verified" | "attested" | "suggested";
  source: string;
  confidence: number;
  at: string;
}

export interface Evidence {
  en: string;
  zh: string;
  quote: string;
  page: number;
  section: string;
  source: string;
  itemKey?: string;
  at: string;
}

export interface ItemRecord {
  itemKey: string;
  libraryID: number;
  title: string;
  pages: number;
  candidates: number;
  pairs: number;
  extractedAt: string;
}

export interface TermBaseData {
  version: number;
  pairs: TermPair[];
  evidence: Evidence[];
  items: Record<string, ItemRecord>;
}

const SCHEMA_VERSION = 1;
const STORE_DIR = "termground";
const STORE_FILE = "terms.json";

function emptyData(): TermBaseData {
  return { version: SCHEMA_VERSION, pairs: [], evidence: [], items: {} };
}

function storeDir(): string {
  return `${Zotero.DataDirectory.dir}/${STORE_DIR}`;
}

function storePath(): string {
  return `${storeDir()}/${STORE_FILE}`;
}

export class TermStore {
  data: TermBaseData;
  private byZh = new Map<string, TermPair[]>();
  private byEn = new Map<string, TermPair[]>();

  private constructor(data: TermBaseData) {
    this.data = data;
    this.reindex();
  }

  static async load(): Promise<TermStore> {
    let data = emptyData();
    try {
      const raw = await Zotero.File.getContentsAsync(storePath());
      if (raw) {
        // getContentsAsync may hand back bytes rather than a string.
        const text =
          typeof raw === "string" ? raw : new TextDecoder().decode(raw);
        const parsed = JSON.parse(text) as Partial<TermBaseData>;
        data = {
          ...emptyData(),
          ...parsed,
          items: parsed.items ?? {},
        };
      }
    } catch {
      // First run: the file does not exist yet.
    }
    return new TermStore(data);
  }

  async save(): Promise<void> {
    await Zotero.File.createDirectoryIfMissingAsync(storeDir());
    await Zotero.File.putContentsAsync(
      storePath(),
      JSON.stringify(this.data, null, 2),
    );
  }

  private reindex(): void {
    this.byZh = new Map();
    this.byEn = new Map();
    for (const pair of this.data.pairs) {
      const zh = lemmaZh(pair.zh);
      const en = lemmaEn(pair.en);
      if (!this.byZh.has(zh)) this.byZh.set(zh, []);
      this.byZh.get(zh)!.push(pair);
      if (!this.byEn.has(en)) this.byEn.set(en, []);
      this.byEn.get(en)!.push(pair);
    }
  }

  /** Chinese lemmas already in the base, used to cut term boundaries. */
  knownZhLemmas(): Set<string> {
    return new Set(this.byZh.keys());
  }

  lookupZh(term: string): TermPair[] {
    return this.byZh.get(lemmaZh(term)) ?? [];
  }

  lookupEn(term: string): TermPair[] {
    return this.byEn.get(lemmaEn(term)) ?? [];
  }

  /**
   * Write one promoted candidate into the base.
   *
   * Returns true when it produced a new pair. A pair we already know still gets
   * its evidence appended: evidence count feeds the confidence of later lookups.
   */
  addCandidate(
    candidate: Candidate,
    meta: { itemKey?: string; libraryID?: number } = {},
  ): boolean {
    const rule = PROMOTABLE[candidate.method];
    if (!rule) return false;

    const zh = cleanSurface(candidate.zh);
    const en = cleanSurface(candidate.en ?? "");
    if (!zh || !en) return false;

    const at = new Date().toISOString();
    const existing = (this.byZh.get(lemmaZh(zh)) ?? []).find(
      (pair) => lemmaEn(pair.en) === lemmaEn(en),
    );

    this.data.evidence.push({
      en,
      zh,
      quote: candidate.quote,
      page: candidate.page,
      section: candidate.section,
      source: rule.source,
      itemKey: meta.itemKey,
      at,
    });

    if (existing) {
      return false;
    }

    this.data.pairs.push({
      en,
      zh,
      abbr: candidate.abbr,
      role: "preferred",
      status: rule.status,
      source: rule.source,
      confidence: candidate.score,
      at,
    });
    this.reindex();
    return true;
  }

  recordItem(record: ItemRecord): void {
    this.data.items[record.itemKey] = record;
  }

  counts(): {
    pairs: number;
    evidence: number;
    items: number;
    verified: number;
  } {
    return {
      pairs: this.data.pairs.length,
      evidence: this.data.evidence.length,
      items: Object.keys(this.data.items).length,
      verified: this.data.pairs.filter((p) => p.status === "verified").length,
    };
  }

  path(): string {
    return storePath();
  }
}
