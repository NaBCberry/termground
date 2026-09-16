/**
 * The term base: a JSON file under Zotero's data directory.
 *
 * A plugin-owned file is deliberately chosen over extra Zotero database tables:
 * no schema coupling, it survives Zotero upgrades untouched, and the whole base
 * is small enough (thousands of pairs) to keep in memory.
 */

import { cleanSurface, lemmaEn, lemmaZh } from "./textUtils.ts";
import {
  PROMOTABLE,
  type Candidate,
  type ExtractionMethod,
} from "./termExtract.ts";

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

/**
 * A candidate the rules were not confident enough to store.
 *
 * Keeping these is the whole point of the review step: dropping them would buy
 * precision at an invisible cost, and the user would never learn that a term
 * they care about was one edit away from being usable.
 */
export interface PendingCandidate {
  id: string;
  zh: string;
  en?: string;
  abbr?: string;
  method: ExtractionMethod;
  score: number;
  quote: string;
  page: number;
  section: string;
  itemKey?: string;
  itemTitle?: string;
  firstSeen: string;
  lastSeen: string;
  seenCount: number;
  status: "open" | "rejected";
}

export interface TermBaseData {
  version: number;
  pairs: TermPair[];
  evidence: Evidence[];
  items: Record<string, ItemRecord>;
  pending: PendingCandidate[];
}

const SCHEMA_VERSION = 1;
const STORE_DIR = "termground";
const STORE_FILE = "terms.json";

function emptyData(): TermBaseData {
  return {
    version: SCHEMA_VERSION,
    pairs: [],
    evidence: [],
    items: {},
    pending: [],
  };
}

/** FNV-1a, stable across runs so a candidate keeps its identity. */
function shortHash(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Join with the separator the data directory already uses.
 *
 * Mozilla's file APIs are strict about this: mixing "C:\...\Zotero" with
 * "/termground/terms.json" fails with NS_ERROR_FILE_UNRECOGNIZED_PATH.
 */
function joinPath(...parts: string[]): string {
  const sep = Zotero.DataDirectory.dir.includes("\\") ? "\\" : "/";
  return parts
    .filter(Boolean)
    .map((part, index) =>
      index === 0
        ? part.replace(/[\\/]+$/, "")
        : part.replace(/^[\\/]+/, "").replace(/[\\/]+$/, ""),
    )
    .join(sep);
}

function storeDir(): string {
  return joinPath(Zotero.DataDirectory.dir, STORE_DIR);
}

function storePath(): string {
  return joinPath(storeDir(), STORE_FILE);
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
          pending: parsed.pending ?? [],
        };
      }
    } catch {
      // First run: the file does not exist yet.
    }
    return new TermStore(data);
  }

  /** Build a store from plain data; used by tests and by future import paths. */
  static fromData(data: Partial<TermBaseData> = {}): TermStore {
    return new TermStore({ ...emptyData(), ...data });
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

  /** Remember a candidate for review. Rejected ones are never resurrected. */
  addPending(
    candidate: Candidate,
    meta: { itemKey?: string; itemTitle?: string } = {},
  ): "new" | "seen" | "rejected" {
    const zh = cleanSurface(candidate.zh);
    const en = candidate.en ? cleanSurface(candidate.en) : undefined;
    const id = shortHash([candidate.method, zh, en ?? ""].join("|"));
    const now = new Date().toISOString();
    const existing = this.data.pending.find((entry) => entry.id === id);
    if (existing) {
      existing.seenCount += 1;
      existing.lastSeen = now;
      return existing.status === "rejected" ? "rejected" : "seen";
    }
    this.data.pending.push({
      id,
      zh,
      en,
      abbr: candidate.abbr,
      method: candidate.method,
      score: candidate.score,
      quote: candidate.quote,
      page: candidate.page,
      section: candidate.section,
      itemKey: meta.itemKey,
      itemTitle: meta.itemTitle,
      firstSeen: now,
      lastSeen: now,
      seenCount: 1,
      status: "open",
    });
    return "new";
  }

  openPending(): PendingCandidate[] {
    return this.data.pending
      .filter((entry) => entry.status === "open")
      .sort((a, b) => b.score - a.score || b.seenCount - a.seenCount);
  }

  pendingCounts(): { open: number; rejected: number } {
    let open = 0;
    let rejected = 0;
    for (const entry of this.data.pending) {
      if (entry.status === "open") open++;
      else rejected++;
    }
    return { open, rejected };
  }

  /**
   * Promote a reviewed candidate.
   *
   * A pair the reviewer rewrote or completed is no longer demonstrated by the
   * sentence it was extracted from, so it cannot claim "verified" any more.
   */
  acceptPending(
    entry: PendingCandidate,
    edited: { zh?: string; en?: string } = {},
  ): boolean {
    const zh = cleanSurface(edited.zh ?? entry.zh);
    const en = cleanSurface(edited.en ?? entry.en ?? "");
    if (!zh || !en) return false;

    const changed = zh !== entry.zh || en !== entry.en;
    const rule = changed ? undefined : PROMOTABLE[entry.method];
    const at = new Date().toISOString();

    this.data.pairs.push({
      en,
      zh,
      abbr: entry.abbr,
      role: "preferred",
      status: rule ? rule.status : "suggested",
      source: rule ? rule.source : "human_review",
      confidence: rule ? entry.score : 0.5,
      at,
    });
    this.data.evidence.push({
      en,
      zh,
      quote: entry.quote,
      page: entry.page,
      section: entry.section,
      source: rule ? rule.source : "human_review",
      itemKey: entry.itemKey,
      at,
    });
    this.data.pending = this.data.pending.filter(
      (item) => item.id !== entry.id,
    );
    this.reindex();
    return true;
  }

  rejectPending(entry: PendingCandidate): void {
    const target = this.data.pending.find((item) => item.id === entry.id);
    if (target) {
      target.status = "rejected";
      target.lastSeen = new Date().toISOString();
    }
  }

  counts(): {
    pairs: number;
    evidence: number;
    items: number;
    verified: number;
    pending: number;
  } {
    return {
      pairs: this.data.pairs.length,
      evidence: this.data.evidence.length,
      items: Object.keys(this.data.items).length,
      verified: this.data.pairs.filter((p) => p.status === "verified").length,
      pending: this.pendingCounts().open,
    };
  }

  path(): string {
    return storePath();
  }
}
