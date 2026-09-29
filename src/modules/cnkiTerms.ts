import type { TermPair } from "./termStore.ts";

export interface ProtectedTerm {
  source: string;
  target: string;
  tag: string;
}

export interface ProtectedText {
  text: string;
  terms: ProtectedTerm[];
}

/**
 * What the post-translation restore actually managed to enforce.
 *
 * Protection can only wrap a term; whether the translation service keeps the
 * marker pair intact is out of our hands. `lost` is the part that used to be
 * invisible — those terms fall back to whatever wording the engine chose.
 */
export interface RestoreReport {
  /** 标记成对、已被替换成术语库指定译名的条数 */
  restored: number;
  /** 标记被拆散或吞掉、只能清理残标记的条数 */
  lost: number;
  /** lost 对应的英文术语，供提示里直接列出 */
  lostTerms: string[];
}

export interface RestoredText {
  text: string;
  report: RestoreReport;
}

function priority(pair: TermPair): number {
  if (pair.source === "human_review") return 3;
  if (pair.status === "verified") return 2;
  if (pair.status === "attested") return 1;
  return 0;
}

/** Resolve duplicate English entries exactly as the PDF2zh glossary does. */
export function preferredTranslationPairs(pairs: TermPair[]): TermPair[] {
  const preferred = new Map<string, TermPair>();
  for (const pair of pairs) {
    const source = pair.en.trim().replace(/\s+/g, " ");
    const target = pair.zh.trim().replace(/\s+/g, " ");
    if (!source || !target || !/[A-Za-z]/.test(source)) continue;

    const key = source.toLocaleLowerCase("en-US");
    const current = preferred.get(key);
    if (
      !current ||
      priority(pair) > priority(current) ||
      (priority(pair) === priority(current) &&
        pair.confidence > current.confidence)
    ) {
      preferred.set(key, { ...pair, en: source, zh: target });
    }
  }
  return [...preferred.values()].sort(
    (a, b) => b.en.length - a.en.length || a.en.localeCompare(b.en),
  );
}

function isAsciiWord(char: string | undefined): boolean {
  return !!char && /[A-Za-z0-9]/.test(char);
}

interface Match {
  start: number;
  end: number;
  pair: TermPair;
}

/**
 * Find all source terms before replacing anything, then keep the longest
 * non-overlapping matches. This prevents a short abbreviation from matching
 * inside a longer term or inside a marker inserted for an earlier match.
 */
function findMatches(raw: string, pairs: TermPair[]): Match[] {
  const lower = raw.toLocaleLowerCase("en-US");
  const found: Match[] = [];

  for (const pair of preferredTranslationPairs(pairs)) {
    const needle = pair.en.toLocaleLowerCase("en-US");
    let from = 0;
    while (from < lower.length) {
      const start = lower.indexOf(needle, from);
      if (start < 0) break;
      const end = start + needle.length;
      const needsLeftBoundary = isAsciiWord(needle[0]);
      const needsRightBoundary = isAsciiWord(needle[needle.length - 1]);
      if (
        (!needsLeftBoundary || !isAsciiWord(raw[start - 1])) &&
        (!needsRightBoundary || !isAsciiWord(raw[end]))
      ) {
        found.push({ start, end, pair });
      }
      from = start + Math.max(1, needle.length);
    }
  }

  found.sort(
    (a, b) => a.start - b.start || b.end - b.start - (a.end - a.start),
  );
  const selected: Match[] = [];
  let occupiedUntil = -1;
  for (const match of found) {
    if (match.start < occupiedUntil) continue;
    selected.push(match);
    occupiedUntil = match.end;
  }
  return selected;
}

/**
 * Put the preferred Chinese translation inside a neutral marker. CNKI normally
 * preserves both the marker and the already-Chinese text; the matching marker
 * lets us enforce the preferred target after translation.
 */
export function protectCnkiTerms(
  raw: string,
  pairs: TermPair[],
): ProtectedText {
  const matches = findMatches(raw, pairs);
  if (!matches.length) return { text: raw, terms: [] };

  const terms: ProtectedTerm[] = [];
  let cursor = 0;
  let text = "";
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index];
    const tag = `TG${index.toString().padStart(4, "0")}`;
    text += raw.slice(cursor, match.start);
    text += `[[${tag}]]${match.pair.zh}[[/${tag}]]`;
    terms.push({ source: match.pair.en, target: match.pair.zh, tag });
    cursor = match.end;
  }
  text += raw.slice(cursor);
  return { text, terms };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Restore every intact marker and remove any harmless leftover marker tags.
 *
 * Also counts what it could not enforce. A term whose marker pair did not
 * survive translation keeps the engine's own wording, and the caller needs that
 * number to say so instead of reporting success for the whole batch.
 */
export function restoreCnkiTerms(
  translated: string,
  terms: ProtectedTerm[],
): RestoredText {
  let result = translated;
  const lostTerms: string[] = [];
  let restored = 0;

  for (const term of terms) {
    const tag = escapeRegExp(term.tag);
    const wrapped = new RegExp(
      `\\[\\[\\s*${tag}\\s*\\]\\][\\s\\S]*?\\[\\[\\s*\\/\\s*${tag}\\s*\\]\\]`,
      "gi",
    );
    /*
     * test() on a /g/ regex advances lastIndex, so rewind it before the
     * replace() below — otherwise that replace starts mid-string and misses the
     * very marker test() just found.
     */
    const intact = wrapped.test(result);
    wrapped.lastIndex = 0;
    if (intact) {
      result = result.replace(wrapped, () => term.target);
      restored++;
    } else {
      lostTerms.push(term.source);
    }
  }

  // If CNKI preserved the Chinese text but separated a tag from its mate,
  // remove the tag rather than leaking implementation markers into the UI.
  result = result.replace(/\[\[\s*\/?\s*TG\d{4}\s*\]\]/gi, "");

  return {
    text: result,
    report: { restored, lost: lostTerms.length, lostTerms },
  };
}
