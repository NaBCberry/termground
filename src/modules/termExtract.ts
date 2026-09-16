/**
 * Terminology extraction rules.
 *
 * Pure functions only — no Zotero APIs — so the whole rule set can be exercised
 * with plain Node. The rules mirror the ones validated in the Python prototype:
 * the highest-value signal in Chinese scientific papers is the author's own
 * gloss ("超宽带（Ultra-Wideband, UWB）") plus the bilingual keyword list that
 * Chinese journals require.
 */

import {
  cleanSurface,
  hasCjk,
  hasLatin,
  lastSuspectToken,
  trimTermPrefix,
} from "./textUtils.ts";

export type ExtractionMethod =
  | "author_note"
  | "english_note"
  | "bilingual_keyword"
  | "zh_np_frequency";

export interface Segment {
  page: number;
  section: string;
  text: string;
}

export interface Candidate {
  zh: string;
  en?: string;
  abbr?: string;
  method: ExtractionMethod;
  score: number;
  quote: string;
  page: number;
  section: string;
}

export interface ExtractionStats {
  segments: number;
  authorNotes: number;
  keywordPairs: number;
  zhKeywords: number;
  enKeywords: number;
  unmappedCandidates: number;
}

export interface RawGloss {
  zh: string;
  en: string;
  abbr?: string;
  certain: boolean;
  method: ExtractionMethod;
}

/** Suffixes that make a Chinese noun phrase look like a domain term. */
export const DOMAIN_SUFFIXES = [
  "定位", "搜索", "导航", "追踪", "建图", "图优化", "里程计", "滤波", "估计",
  "算法", "模型", "系统", "方法", "技术", "网络", "传感器", "信号", "误差",
  "精度", "轨迹", "地图", "融合", "标定", "匹配", "特征", "参数", "矩阵",
  "函数", "分布", "空间", "框架", "策略", "机制", "平台", "装置", "测量",
  "检测", "识别", "分类", "聚类", "仿真", "约束", "优化", "求解", "重构",
];

const MIN_SUFFIX_LEN = Math.min(...DOMAIN_SUFFIXES.map((s) => s.length));

/**
 * A known term shorter than this is ignored when cutting the left boundary:
 * a bare generic entry such as 单元 would otherwise hijack 惯性测量单元.
 */
export const MIN_TRUSTED_KNOWN_SUFFIX = 3;

/** Only candidates at or above this score are allowed to enter the term base. */
export const PROMOTE_SCORE = 0.8;

export const PROMOTABLE: Record<
  string,
  { status: "verified"; confidence: number; source: string }
> = {
  author_note: { status: "verified", confidence: 0.92, source: "author_note" },
  english_note: { status: "verified", confidence: 0.88, source: "author_note" },
  bilingual_keyword: {
    status: "verified",
    confidence: 0.85,
    source: "bilingual_keyword",
  },
};

export const STOP_TERMS = new Set([
  "方法研究",
  "技术研究",
  "本文方法",
  "实验结果",
  "研究方法",
]);

/** 中文术语（English Term, ABBR） */
function zhFirstRegex(): RegExp {
  return /([\u4e00-\u9fff]{2,24})\s*[（(]\s*([A-Za-z][A-Za-z0-9 \-/&'’.]{1,60}?)\s*(?:[,，]\s*([A-Za-z][A-Za-z0-9-]{1,11}))?\s*[)）]/g;
}

/** English Term（中文术语） */
function enFirstRegex(): RegExp {
  return /([A-Za-z][A-Za-z0-9 \-/&'’.]{2,60}?)\s*[（(]\s*([\u4e00-\u9fff][\u4e00-\u9fffA-Za-z0-9\-·]{1,19})\s*[)）]/g;
}

const KEYWORDS_ZH_RE = /关\s*键\s*词\s*[:：]\s*(.+)/;
const KEYWORDS_EN_RE = /Key\s*[Ww]ords?\s*[:：]\s*(.+)/;

/**
 * Recover the Chinese term from the raw run that precedes a gloss.
 *
 * "已有研究广泛采用超宽带（Ultra-Wideband, UWB）" carries the term at its right
 * edge. A specific known term there is the most reliable cut; short generic ones
 * are ignored because they match too eagerly. Otherwise fall back to a
 * length-capped heuristic and mark the candidate uncertain so it is never
 * auto-promoted.
 */
export function refineZhBoundary(
  run: string,
  known: Set<string>,
): [string, boolean] {
  let best = "";
  for (const term of known) {
    if (
      term.length >= MIN_TRUSTED_KNOWN_SUFFIX &&
      run.endsWith(term) &&
      term.length > best.length
    ) {
      best = term;
    }
  }
  if (best) return [best, true];

  let trimmed = trimTermPrefix(run, 8);
  // A connective that survived inside the run means the cut went too far left:
  // "方法在因子图" really is "因子图".
  const suspect = lastSuspectToken(trimmed);
  if (suspect) {
    const tail = trimmed.slice(suspect.index + suspect.token.length);
    if (tail.length >= 2 && tail.length <= 6 && !lastSuspectToken(tail)) {
      trimmed = tail;
    }
  }
  if (trimmed !== run && known.has(trimmed) && trimmed.length >= 2) {
    return [trimmed, true];
  }
  if (run.length >= 2 && known.has(run)) {
    return [run, true];
  }
  // Trimming a leading connective such as 的/在 leaves a plausible headword.
  const certain =
    trimmed !== run &&
    trimmed.length >= 2 &&
    trimmed.length <= 6 &&
    !lastSuspectToken(trimmed);
  return [trimmed, certain];
}

export function findAuthorNotes(text: string, known: Set<string>): RawGloss[] {
  const found: RawGloss[] = [];
  for (const match of text.matchAll(zhFirstRegex())) {
    const [zh, certain] = refineZhBoundary(match[1], known);
    const en = cleanSurface(match[2]);
    const abbr = match[3] ? cleanSurface(match[3]) : undefined;
    if (!en || zh.length < 2) continue;
    found.push({ zh: cleanSurface(zh), en, abbr, certain, method: "author_note" });
  }
  return found;
}

export function findEnglishFirstNotes(text: string): RawGloss[] {
  const found: RawGloss[] = [];
  for (const match of text.matchAll(enFirstRegex())) {
    const en = cleanSurface(match[1]);
    const zh = cleanSurface(match[2]);
    if (!en || !zh) continue;
    // The Chinese term comes straight out of the parentheses, so it is exact.
    found.push({ zh, en, certain: true, method: "english_note" });
  }
  return found;
}

export function splitKeywordList(raw: string, cutLatin = false): string[] {
  let text = raw.replace(/[（(].*?[)）]/g, "");
  if (cutLatin) {
    // A Chinese keyword line is occasionally merged with the following English
    // abstract by the PDF layout; cut it at the first long Latin run.
    const match = /[A-Za-z]{4,}/.exec(text);
    if (match) text = text.slice(0, match.index);
  }
  return text
    .split(/[;；,，、]/)
    .map((part) => cleanSurface(part))
    .filter(Boolean);
}

/** All substrings of length MIN_SUFFIX_LEN..maxLen that end in a domain suffix. */
export function zhNgrams(text: string, maxLen = 10): string[] {
  const out: string[] = [];
  for (const run of text.match(/[\u4e00-\u9fff]{2,40}/g) ?? []) {
    for (let end = run.length; end > 0; end--) {
      for (let length = MIN_SUFFIX_LEN; length <= maxLen; length++) {
        const start = end - length;
        if (start < 0) continue;
        const sub = run.slice(start, end);
        if (DOMAIN_SUFFIXES.some((suffix) => sub.endsWith(suffix))) {
          out.push(sub);
        }
      }
    }
  }
  return out;
}

export interface ExtractionResult {
  candidates: Candidate[];
  stats: ExtractionStats;
}

export function extractFromSegments(
  segments: Segment[],
  knownZh: Set<string>,
  minFreq = 2,
): ExtractionResult {
  const candidates: Candidate[] = [];
  const counts = new Map<string, number>();
  const zhKeywords: Array<{ segment: Segment; value: string }> = [];
  const enKeywords: Array<{ segment: Segment; value: string }> = [];
  let authorNotes = 0;

  for (const segment of segments) {
    const text = segment.text;

    const glosses = [
      ...findAuthorNotes(text, knownZh),
      ...findEnglishFirstNotes(text),
    ];
    for (const gloss of glosses) {
      const score =
        gloss.method === "author_note" ? (gloss.certain ? 0.95 : 0.6) : 0.9;
      candidates.push({
        zh: gloss.zh,
        en: gloss.en,
        abbr: gloss.abbr,
        method: gloss.method,
        score,
        quote: text,
        page: segment.page,
        section: segment.section,
      });
      authorNotes++;
    }

    const matchZh = KEYWORDS_ZH_RE.exec(text);
    if (matchZh) {
      for (const value of splitKeywordList(matchZh[1], true)) {
        zhKeywords.push({ segment, value });
      }
    }
    const matchEn = KEYWORDS_EN_RE.exec(text);
    if (matchEn) {
      for (const value of splitKeywordList(matchEn[1])) {
        enKeywords.push({ segment, value });
      }
    }

    for (const ngram of zhNgrams(text)) {
      counts.set(ngram, (counts.get(ngram) ?? 0) + 1);
    }
  }

  let keywordPairs = 0;
  const pairCount = Math.min(zhKeywords.length, enKeywords.length);
  for (let i = 0; i < pairCount; i++) {
    const { segment, value: zh } = zhKeywords[i];
    const en = enKeywords[i].value;
    if (!hasCjk(zh) || !hasLatin(en)) continue;
    candidates.push({
      zh,
      en,
      method: "bilingual_keyword",
      score: 0.88,
      quote: `关键词：${zh} / Keywords: ${en}`,
      page: segment.page,
      section: segment.section,
    });
    keywordPairs++;
  }

  const unmapped: Candidate[] = [];
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [candidate, freq] of sorted) {
    if (freq < minFreq) continue;
    if (STOP_TERMS.has(candidate)) continue;
    if (DOMAIN_SUFFIXES.includes(candidate)) continue;
    if (knownZh.has(candidate)) continue;
    // Drop a candidate that is contained in a longer one with comparable
    // frequency: 定位 should not survive next to 定位精度.
    const shadowed = sorted.some(
      ([other, otherFreq]) =>
        other !== candidate &&
        other.includes(candidate) &&
        otherFreq >= 0.5 * freq,
    );
    if (shadowed) continue;
    unmapped.push({
      zh: candidate,
      method: "zh_np_frequency",
      score: Math.min(0.6, 0.2 + freq / 40),
      quote: `全文出现 ${freq} 次`,
      page: 0,
      section: "body",
    });
  }
  candidates.push(...unmapped);

  return {
    candidates,
    stats: {
      segments: segments.length,
      authorNotes,
      keywordPairs,
      zhKeywords: zhKeywords.length,
      enKeywords: enKeywords.length,
      unmappedCandidates: unmapped.length,
    },
  };
}

/** Candidates the rules are confident enough to write into the term base. */
export function selectPromotable(candidates: Candidate[]): Candidate[] {
  return candidates.filter(
    (candidate) =>
      candidate.en !== undefined &&
      PROMOTABLE[candidate.method] !== undefined &&
      candidate.score >= PROMOTE_SCORE &&
      hasLatin(candidate.en) &&
      hasCjk(candidate.zh),
  );
}
