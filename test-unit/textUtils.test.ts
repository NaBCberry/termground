import assert from "node:assert/strict";
import { test } from "node:test";

import {
  cleanSurface,
  joinLines,
  lemmaEn,
  normalizeCjkSpacing,
  splitBlocks,
  splitPages,
  splitSentences,
  splitVariants,
  trimTermPrefix,
} from "../src/modules/textUtils.ts";

test("cleanSurface keeps brackets", () => {
  // Stripping brackets would corrupt entries such as this one.
  assert.equal(cleanSurface("AUC(ROC曲线下方面积)"), "AUC(ROC曲线下方面积)");
});

test("cleanSurface trims sentence punctuation and collapses spaces", () => {
  assert.equal(cleanSurface("  超宽带。  "), "超宽带");
  assert.equal(cleanSurface("Ultra-Wideband, "), "Ultra-Wideband");
});

test("splitVariants splits slash alternatives", () => {
  assert.deepEqual(splitVariants("接受-拒绝抽样法/接受-拒绝采样法"), [
    "接受-拒绝抽样法",
    "接受-拒绝采样法",
  ]);
});

test("splitVariants keeps inner slashes", () => {
  assert.deepEqual(splitVariants("零/少/单试学习"), ["零/少/单试学习"]);
});

test("lemmaEn normalises case, dashes and articles", () => {
  assert.equal(lemmaEn("The Ultra-Wideband"), "ultra-wideband");
  assert.equal(lemmaEn("Cross - Localization"), "cross-localization");
});

test("joinLines does not inject spaces between Chinese characters", () => {
  assert.equal(joinLines(["超宽带测距", "精度较高"]), "超宽带测距精度较高");
});

test("joinLines repairs a hyphenated English wrap", () => {
  assert.equal(joinLines(["Cross", "-Localization"]), "Cross-Localization");
});

test("joinLines keeps a normal English word gap", () => {
  assert.equal(joinLines(["Particle", "Filter"]), "Particle Filter");
});

test("splitPages splits on the form feed Zotero inserts between pages", () => {
  assert.deepEqual(splitPages("第一页\f第二页\f第三页"), [
    "第一页",
    "第二页",
    "第三页",
  ]);
});

test("splitSentences does not split on a Chinese semicolon", () => {
  // Splitting here would fragment the keyword line and lose every keyword pair.
  const line = "关键词：交叉定位；目标搜索；导航；超宽带";
  assert.deepEqual(splitSentences(line), [line]);
});

test("splitSentences splits on a full stop", () => {
  assert.deepEqual(splitSentences("第一句。第二句。"), ["第一句。", "第二句。"]);
});

test("splitBlocks breaks before a section heading", () => {
  const page = "关键词：导航\nAbstract: This paper proposes a method.";
  const blocks = splitBlocks(page);
  assert.equal(blocks.length, 2);
  assert.match(blocks[0], /关键词/);
  assert.match(blocks[1], /^Abstract:/);
});

test("trimTermPrefix strips leading verbs and connectives", () => {
  assert.equal(trimTermPrefix("本文提出一种结合超宽带"), "超宽带");
});

test("spaces between CJK glyphs are merged", () => {
  // Real PDF text layers come out like this.
  assert.equal(normalizeCjkSpacing("遍 历 路 径 规 划"), "遍历路径规划");
  assert.equal(cleanSurface("覆 盖 路 径 规 划"), "覆盖路径规划");
});

