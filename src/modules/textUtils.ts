/**
 * Pure text helpers. No Zotero APIs here on purpose: everything in this file is
 * unit-testable with plain Node, and it mirrors the rules that were validated in
 * the Python prototype (see docs/术语-证据一致性引擎-技术方案.md).
 */

export const CJK_RE = /[\u4e00-\u9fff]/;

export function isCjkChar(ch: string): boolean {
  return !!ch && /[\u4e00-\u9fff]/.test(ch);
}

export function hasCjk(text: string): boolean {
  return CJK_RE.test(text);
}

export function hasLatin(text: string): boolean {
  return /[A-Za-z]/.test(text);
}

/** Normalise full-width punctuation that PDF extraction leaves behind. */
export function toHalfwidth(input: string): string {
  const map: Record<string, string> = {
    "\uFF08": "(",
    "\uFF09": ")",
    "\uFF0C": ",",
    "\uFF1B": ";",
    "\uFF1A": ":",
    "\u3001": ",",
    "\u3000": " ",
  };
  return input.replace(
    /[\uFF08\uFF09\uFF0C\uFF1B\uFF1A\u3001\u3000]/g,
    (c) => map[c] ?? c,
  );
}

/**
 * PDF text layers frequently put a space between every pair of CJK glyphs
 * ("遍 历 路 径 规 划"). Left alone, that breaks both term matching and the
 * stored evidence quotes.
 */
export function normalizeCjkSpacing(text: string): string {
  return text.replace(/(?<=[\u4e00-\u9fff])[ \t]+(?=[\u4e00-\u9fff])/g, "");
}

const TRIM_CHARS = " \t\r\n,.;:\u3002\uFF0C\uFF1B\uFF1A\u3001\"'\u201C\u201D\u2018\u2019";

/**
 * Trim whitespace and sentence punctuation, but never brackets: seed entries
 * such as "AUC(ROC曲线下方面积)" would otherwise lose the closing paren and end
 * up as a corrupted headword.
 */
export function cleanSurface(input: string): string {
  let s = input.normalize("NFKC");
  s = s.replace(/\u3000/g, " ").trim();
  s = s.replace(/\s+/g, " ");
  s = normalizeCjkSpacing(s);
  let start = 0;
  let end = s.length;
  while (start < end && TRIM_CHARS.includes(s[start])) start++;
  while (end > start && TRIM_CHARS.includes(s[end - 1])) end--;
  return s.slice(start, end);
}

export function lemmaEn(surface: string): string {
  let s = cleanSurface(surface).toLowerCase();
  s = s.replace(/[\u2010\u2011\u2013]/g, "-");
  s = s.replace(/\s*-\s*/g, "-");
  s = s.replace(/\s+/g, " ");
  s = s.replace(/^(a|an|the)\s+/, "");
  return s.trim();
}

export function lemmaZh(surface: string): string {
  return cleanSurface(surface).replace(/\s+/g, "");
}

/**
 * Split a seed cell such as "A法/A采样法" into variants. Only split when every
 * part is at least two characters wide, which keeps terms like "零/少/单试学习"
 * intact.
 */
export function splitVariants(zhText: string): string[] {
  const cleaned = cleanSurface(zhText);
  const parts = cleaned
    .split(/[/,]/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length > 1 && parts.every((p) => p.length >= 2)) {
    return parts;
  }
  return [cleaned];
}

/**
 * Leading verbs and connectives that frequently precede a glossed term, e.g.
 * "提出一种结合超宽带（Ultra-Wideband, UWB）" -> "超宽带".
 */
export const PREFIX_NOISE = [
  "结合", "采用", "提出", "基于", "利用", "通过", "使用", "构建", "引入",
  "设计", "实现", "定义", "称为", "记为", "一种", "本文", "以及", "并且",
  "其中", "对于", "针对", "为了", "能够", "可以", "将该", "进而", "从而",
  "将", "把", "在", "对", "与", "和", "及", "的", "并", "且", "该",
].sort((a, b) => b.length - a.length);

/**
 * Tokens that are unlikely to appear *inside* a term head. If one survives in
 * the middle of a trimmed run, the cut went too far left and the real term
 * starts after it: "方法在因子图" -> "因子图".
 *
 * 与/和/及 are deliberately absent: they occur legitimately inside terms such
 * as 同时定位与建图.
 */
export const BOUNDARY_SUSPECT_TOKENS = [
  "称为", "提出", "采用", "一种", "本文", "可以", "能够", "将该",
  "在", "的", "把", "对", "是", "占",
].sort((a, b) => b.length - a.length);

/** Index and token of the last suspect token inside the run, or null. */
export function lastSuspectToken(
  surface: string,
): { index: number; token: string } | null {
  let best: { index: number; token: string } | null = null;
  for (const token of BOUNDARY_SUSPECT_TOKENS) {
    const index = surface.lastIndexOf(token);
    // Ignore a match at position 0: that is the normal leading-noise case.
    if (index > 0 && (!best || index > best.index)) {
      best = { index, token };
    }
  }
  return best;
}

export function trimTermPrefix(surface: string, maxLen = 8): string {
  const strip = (input: string): string => {
    let s = input;
    let changed = true;
    while (changed && s.length > 2) {
      changed = false;
      for (const noise of PREFIX_NOISE) {
        if (s.startsWith(noise) && s.length - noise.length >= 2) {
          s = s.slice(noise.length);
          changed = true;
          break;
        }
      }
    }
    return s;
  };

  // Strip noise first, then cap the length. Capping first can cut a noise word
  // in half ("本文提出一种结合超宽带" -> "出一种结合超宽带"), after which the
  // noise list no longer matches and the trim silently gives up.
  let s = strip(surface.trim());
  if (s.length > maxLen) {
    s = strip(s.slice(-maxLen));
  }
  return s;
}

/**
 * Re-join wrapped lines coming out of a PDF text layer.
 *
 * Chinese text wrapped by a layout engine carries no word separator, and English
 * words may be broken after a hyphen; both must be repaired or every downstream
 * term surface inherits a stray space.
 */
export function joinLines(lines: string[]): string {
  let out = "";
  for (const line of lines) {
    if (!out) {
      out = line;
      continue;
    }
    const prev = out[out.length - 1];
    const next = line[0];
    const cjkPair = isCjkChar(prev) && isCjkChar(next);
    const hyphenContinuation = "-–—".includes(next) || prev === "-";
    out += cjkPair || hyphenContinuation ? line : " " + line;
  }
  return out;
}

/**
 * Zotero's PDF text extraction inserts a form feed between pages
 * (see resource/document-worker/worker.js in the Zotero distribution), so page
 * numbers come for free.
 */
export function splitPages(text: string): string[] {
  return text.split("\f");
}

const SECTION_PATTERNS: Array<[string, RegExp]> = [
  ["abstract_zh", /^\s*摘\s*要\s*[:：]/],
  ["abstract_en", /^\s*[Aa]bstract\b/],
  ["keywords_zh", /^\s*关\s*键\s*词\s*[:：]/],
  ["keywords_en", /^\s*[Kk]ey\s*[Ww]ords?\b/],
  ["references", /^\s*参\s*考\s*文\s*献\s*$|^\s*References\s*$/],
  ["conclusion", /^\s*结\s*论\s*$|^\s*[Cc]onclusions?\b/],
  ["method", /^\s*\d+(\.\d+)*\s*(方\s*法|Method|Methods|算法)\b/],
  ["experiment", /^\s*\d+(\.\d+)*\s*(实\s*验|Experiment|Results)/],
  ["introduction", /^\s*\d+(\.\d+)*\s*(引\s*言|Introduction)/],
];

export function detectSection(line: string): string | null {
  for (const [name, pattern] of SECTION_PATTERNS) {
    if (pattern.test(line)) return name;
  }
  return null;
}

export function splitBlocks(pageText: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length) {
      blocks.push(joinLines(current));
      current = [];
    }
  };
  for (const rawLine of pageText.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      flush();
      continue;
    }
    if (detectSection(line)) flush();
    current.push(line);
  }
  flush();
  return blocks;
}

/**
 * Split a block into sentences.
 *
 * Chinese semicolons are clause separators, not sentence ends. Splitting on them
 * would fragment keyword lines such as 关键词：A；B；C, and keyword pairs are the
 * highest-value evidence source we have.
 */
export function splitSentences(block: string): string[] {
  const parts = block
    .split(/(?<=[。！？!?])|(?<=\.)(?=\s+[A-Z])/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length ? parts : [block];
}
