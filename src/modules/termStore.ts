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
  /** Stable identity; text can be edited without losing its evidence. */
  id: string;
  en: string;
  zh: string;
  abbr?: string;
  role: "preferred" | "admitted";
  status: "verified" | "attested" | "suggested";
  source: string;
  confidence: number;
  at: string;
  updatedAt: string;
}

export interface Evidence {
  id: string;
  termId: string;
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

const SCHEMA_VERSION = 2;
const STORE_DIR = "termground";
const STORE_FILE = "terms.json";
const PDF2ZH_GLOSSARY_FILE = "pdf2zh-glossary.csv";
const BACKUP_DIR = "backups";
const MAX_BACKUPS = 10;

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

function glossaryPath(): string {
  return joinPath(storeDir(), PDF2ZH_GLOSSARY_FILE);
}

function backupDir(): string {
  return joinPath(storeDir(), BACKUP_DIR);
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""').replace(/[\r\n]+/g, " ")}"`;
}

function pairPriority(pair: TermPair): number {
  // A human correction is authoritative for translation even though its
  // evidence status remains "suggested" (the source sentence no longer proves
  // the edited pair verbatim).
  if (pair.source === "human_review") return 3;
  if (pair.status === "verified") return 2;
  if (pair.status === "attested") return 1;
  return 0;
}

function makeId(prefix: string, seed: string): string {
  return `${prefix}-${shortHash(seed)}-${Date.now().toString(36)}`;
}

/** Upgrade old stores in memory. The original file is left untouched until save. */
function normalizeData(input: Partial<TermBaseData>): TermBaseData {
  const data: TermBaseData = {
    ...emptyData(),
    ...input,
    pairs: [...(input.pairs ?? [])],
    evidence: [...(input.evidence ?? [])],
    items: input.items ?? {},
    pending: input.pending ?? [],
    version: SCHEMA_VERSION,
  };
  const used = new Set<string>();
  data.pairs = data.pairs.map((raw, index) => {
    const pair = raw as TermPair;
    let id =
      pair.id ||
      `term-${shortHash(`${pair.en}|${pair.zh}|${pair.at}|${index}`)}`;
    while (used.has(id)) id = `${id}-${index}`;
    used.add(id);
    return { ...pair, id, updatedAt: pair.updatedAt || pair.at };
  });
  data.evidence = data.evidence.map((raw, index) => {
    const evidence = raw as Evidence;
    const owner = data.pairs.find(
      (pair) =>
        lemmaEn(pair.en) === lemmaEn(evidence.en) &&
        lemmaZh(pair.zh) === lemmaZh(evidence.zh),
    );
    return {
      ...evidence,
      id:
        evidence.id ||
        `evidence-${shortHash(`${evidence.en}|${evidence.zh}|${evidence.at}|${index}`)}`,
      termId: evidence.termId || owner?.id || "",
    };
  });
  return data;
}

export interface TermInput {
  en: string;
  zh: string;
  abbr?: string;
  role?: TermPair["role"];
  status?: TermPair["status"];
  source?: string;
  confidence?: number;
}

/** Build the three-column glossary format consumed by PDFMathTranslate Next. */
export function buildPdf2zhGlossary(
  pairs: TermPair[],
  targetLanguage = "zh-CN",
): string {
  const preferred = new Map<string, TermPair>();
  for (const pair of pairs) {
    const en = cleanSurface(pair.en);
    const zh = cleanSurface(pair.zh);
    if (!en || !zh) continue;
    const key = lemmaEn(en);
    const current = preferred.get(key);
    if (
      !current ||
      pairPriority(pair) > pairPriority(current) ||
      (pairPriority(pair) === pairPriority(current) &&
        pair.confidence > current.confidence)
    ) {
      preferred.set(key, { ...pair, en, zh });
    }
  }

  const rows = [...preferred.values()].sort(
    (a, b) => b.en.length - a.en.length || a.en.localeCompare(b.en),
  );
  return [
    "source,target,tgt_lng",
    ...rows.map((pair) =>
      [csvCell(pair.en), csvCell(pair.zh), csvCell(targetLanguage)].join(","),
    ),
  ].join("\n");
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
        data = normalizeData(parsed);
      }
    } catch {
      // First run: the file does not exist yet.
    }
    return new TermStore(normalizeData(data));
  }

  /** Build a store from plain data; used by tests and by future import paths. */
  static fromData(data: Partial<TermBaseData> = {}): TermStore {
    return new TermStore(normalizeData(data));
  }

  async save(options: { backup?: boolean } = {}): Promise<void> {
    await Zotero.File.createDirectoryIfMissingAsync(storeDir());
    if (options.backup) await this.createBackup();
    await Zotero.File.putContentsAsync(
      storePath(),
      JSON.stringify(this.data, null, 2),
    );
    await Zotero.File.putContentsAsync(
      glossaryPath(),
      buildPdf2zhGlossary(this.data.pairs),
    );
  }

  private async createBackup(): Promise<void> {
    try {
      if (!Zotero.File.pathToFile(storePath()).exists()) return;
      const raw = await Zotero.File.getContentsAsync(storePath());
      if (!raw) return;
      await Zotero.File.createDirectoryIfMissingAsync(backupDir());
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const path = joinPath(backupDir(), `terms-${stamp}.json`);
      await Zotero.File.putContentsAsync(
        path,
        typeof raw === "string" ? raw : new TextDecoder().decode(raw),
      );
      const files: Array<{ name: string; path: string }> = [];
      await Zotero.File.iterateDirectory(backupDir(), (entry) => {
        if (entry.name.startsWith("terms-") && entry.name.endsWith(".json")) {
          files.push({ name: entry.name, path: entry.path });
        }
      });
      files.sort((a, b) => b.name.localeCompare(a.name));
      await Promise.all(
        files
          .slice(MAX_BACKUPS)
          .map((entry) => Zotero.File.removeIfExists(entry.path)),
      );
    } catch (error) {
      // A backup failure must cancel a destructive edit, not silently proceed.
      throw new Error(`无法创建术语库备份：${String(error)}`, {
        cause: error,
      });
    }
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
      id: makeId("evidence", `${en}|${zh}|${at}|${candidate.quote}`),
      termId: existing?.id ?? "",
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

    const pair: TermPair = {
      id: makeId("term", `${en}|${zh}|${at}`),
      en,
      zh,
      abbr: candidate.abbr,
      role: "preferred",
      status: rule.status,
      source: rule.source,
      confidence: candidate.score,
      at,
      updatedAt: at,
    };
    this.data.pairs.push(pair);
    this.data.evidence[this.data.evidence.length - 1].termId = pair.id;
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

    const pair: TermPair = {
      id: makeId("term", `${en}|${zh}|${at}`),
      en,
      zh,
      abbr: entry.abbr,
      role: "preferred",
      status: rule ? rule.status : "suggested",
      source: rule ? rule.source : "human_review",
      confidence: rule ? entry.score : 0.5,
      at,
      updatedAt: at,
    };
    this.data.pairs.push(pair);
    this.data.evidence.push({
      id: makeId("evidence", `${en}|${zh}|${at}|${entry.quote}`),
      termId: pair.id,
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

  evidenceForTerm(termId: string): Evidence[] {
    const pair = this.data.pairs.find((item) => item.id === termId);
    if (!pair) return [];
    return this.data.evidence.filter(
      (item) =>
        item.termId === termId ||
        (!item.termId &&
          lemmaEn(item.en) === lemmaEn(pair.en) &&
          lemmaZh(item.zh) === lemmaZh(pair.zh)),
    );
  }

  createTerm(input: TermInput): TermPair {
    const en = cleanSurface(input.en);
    const zh = cleanSurface(input.zh);
    if (!en || !zh) throw new Error("英文术语和中文译名不能为空");
    if (this.hasExactPair(en, zh)) throw new Error("相同的中英文术语已经存在");
    const now = new Date().toISOString();
    const pair: TermPair = {
      id: makeId("term", `${en}|${zh}|${now}`),
      en,
      zh,
      abbr: cleanSurface(input.abbr ?? "") || undefined,
      role: input.role ?? "preferred",
      status: input.status ?? "suggested",
      source: input.source ?? "human_review",
      confidence: Math.max(0, Math.min(1, input.confidence ?? 1)),
      at: now,
      updatedAt: now,
    };
    this.data.pairs.push(pair);
    this.reindex();
    return pair;
  }

  updateTerm(id: string, input: TermInput): TermPair {
    const pair = this.data.pairs.find((item) => item.id === id);
    if (!pair) throw new Error("找不到要编辑的术语");
    const en = cleanSurface(input.en);
    const zh = cleanSurface(input.zh);
    if (!en || !zh) throw new Error("英文术语和中文译名不能为空");
    if (this.hasExactPair(en, zh, id))
      throw new Error("相同的中英文术语已经存在");
    Object.assign(pair, {
      en,
      zh,
      abbr: cleanSurface(input.abbr ?? "") || undefined,
      role: input.role ?? pair.role,
      status: input.status ?? pair.status,
      source: input.source ?? pair.source,
      confidence: Math.max(0, Math.min(1, input.confidence ?? pair.confidence)),
      updatedAt: new Date().toISOString(),
    });
    this.reindex();
    return pair;
  }

  deleteTerms(ids: Iterable<string>): { pairs: number; evidence: number } {
    const targets = new Set(ids);
    const beforePairs = this.data.pairs.length;
    const beforeEvidence = this.data.evidence.length;
    const removed = this.data.pairs.filter((pair) => targets.has(pair.id));
    this.data.pairs = this.data.pairs.filter((pair) => !targets.has(pair.id));
    this.data.evidence = this.data.evidence.filter((evidence) => {
      if (targets.has(evidence.termId)) return false;
      return !removed.some(
        (pair) =>
          !evidence.termId &&
          lemmaEn(evidence.en) === lemmaEn(pair.en) &&
          lemmaZh(evidence.zh) === lemmaZh(pair.zh),
      );
    });
    this.reindex();
    return {
      pairs: beforePairs - this.data.pairs.length,
      evidence: beforeEvidence - this.data.evidence.length,
    };
  }

  restoreDeleted(pairs: TermPair[], evidence: Evidence[]): void {
    const knownPairs = new Set(this.data.pairs.map((pair) => pair.id));
    const knownEvidence = new Set(this.data.evidence.map((item) => item.id));
    this.data.pairs.push(...pairs.filter((pair) => !knownPairs.has(pair.id)));
    this.data.evidence.push(
      ...evidence.filter((item) => !knownEvidence.has(item.id)),
    );
    this.reindex();
  }

  private hasExactPair(en: string, zh: string, exceptId?: string): boolean {
    return this.data.pairs.some(
      (pair) =>
        pair.id !== exceptId &&
        lemmaEn(pair.en) === lemmaEn(en) &&
        lemmaZh(pair.zh) === lemmaZh(zh),
    );
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

  glossaryPath(): string {
    return glossaryPath();
  }
}
