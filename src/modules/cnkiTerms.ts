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
 * Wrap each matched source term in a marker so it can be enforced afterwards.
 *
 * The English stays inside the marker — deliberately, and contrary to the first
 * revision, which put the Chinese translation there on the theory that CNKI
 * would pass already-Chinese text through untouched. Measured behaviour is the
 * opposite: injecting Chinese into an English source makes CNKI mis-detect the
 * language and hand the English back untranslated, with the mangled marker
 * visible in the result. Keeping the input English lets the engine translate
 * normally; the marker then only has to survive long enough for
 * restoreCnkiTerms to swap the whole span for the stored target.
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
    /* 用原文切片而不是 pair.en：保留大小写与原始写法，注入的仍是纯英文。 */
    text += `[[${tag}]]${raw.slice(match.start, match.end)}[[/${tag}]]`;
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
 * Marker pattern, tolerant of what the translation service does to it.
 *
 * Measured on CNKI: `[[TG0000]]` comes back as `[ [ TG0000 ] ]` — a space
 * between the two brackets — and the closing `]]` can even lose its last
 * bracket. Requiring the exact `[[…]]` form meant the restore never matched
 * (every call reported restored=0) *and* left the mangled tags sitting in the
 * user's translation. So whitespace is allowed between both bracket pairs, and
 * the final bracket is optional.
 */
function markerPattern(tag: string, closing: boolean): string {
  const slash = closing ? "\\/\\s*" : "";
  /*
   * 收尾写成 `\](\s*\])?` 而不是 `\]\s*\]?`：后者在标记后面跟着单词时会把那个
   * 空格一起吃掉，译出来就变成「路径规划算法for」这种粘连。
   */
  return `\\[\\s*\\[\\s*${slash}${escapeRegExp(tag)}\\s*\\](\\s*\\])?`;
}

/** 正文里剩下的孤立标记；成对的已经在替换那一步消掉了。 */
const ORPHAN_MARKER_RE = /\[\s*\[\s*\/?\s*TG\s*\d{4}\s*\](\s*\])?/gi;

/**
 * Restore every surviving marker and remove any leftover marker tags.
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
    const wrapped = new RegExp(
      `${markerPattern(term.tag, false)}[\\s\\S]*?${markerPattern(
        term.tag,
        true,
      )}`,
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

  // If the service separated a tag from its mate, remove the orphan rather than
  // leaking implementation markers into the user's translation.
  result = result.replace(ORPHAN_MARKER_RE, "");

  return {
    text: result,
    report: { restored, lost: lostTerms.length, lostTerms },
  };
}
