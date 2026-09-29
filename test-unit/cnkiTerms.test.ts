import assert from "node:assert/strict";
import { test } from "node:test";

import {
  preferredTranslationPairs,
  protectCnkiTerms,
  restoreCnkiTerms,
} from "../src/modules/cnkiTerms.ts";
import type { TermPair } from "../src/modules/termStore.ts";

function pair(
  en: string,
  zh: string,
  overrides: Partial<TermPair> = {},
): TermPair {
  return {
    id: `term-${en}`,
    en,
    zh,
    role: "preferred",
    status: "verified",
    source: "author_note",
    confidence: 0.9,
    at: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("CNKI protection uses longest non-overlapping terms", () => {
  const protectedText = protectCnkiTerms(
    "Automated machine learning improves machine learning.",
    [
      pair("machine learning", "机器学习"),
      pair("automated machine learning", "自动化机器学习"),
    ],
  );

  assert.equal(protectedText.terms.length, 2);
  assert.match(protectedText.text, /自动化机器学习/);
  assert.match(protectedText.text, /机器学习/);
  assert.doesNotMatch(protectedText.text, /Automated machine learning/i);
});

test("CNKI protection respects English word boundaries", () => {
  const protectedText = protectCnkiTerms("AUC differs from sauce.", [
    pair("AUC", "曲线下面积"),
  ]);
  assert.equal(protectedText.terms.length, 1);
  assert.match(protectedText.text, /sauce/);
});

test("CNKI restoration enforces the stored Chinese translation", () => {
  const protectedText = protectCnkiTerms("We use a support vector machine.", [
    pair("support vector machine", "支持向量机"),
  ]);
  const translated = `我们使用一个${protectedText.text.match(/\[\[TG0000\]\].+$/)![0]}`;
  const { text, report } = restoreCnkiTerms(translated, protectedText.terms);

  assert.equal(text, "我们使用一个支持向量机.");
  assert.doesNotMatch(text, /TG0000/);
  assert.deepEqual(report, { restored: 1, lost: 0, lostTerms: [] });
});

test("CNKI restoration still enforces a marker the service rewrote but kept paired", () => {
  const protectedText = protectCnkiTerms("A support vector machine.", [
    pair("support vector machine", "支持向量机"),
  ]);
  // 翻译服务把标记里的中文换成了自己的说法，还给标记加了空格——只要首尾标记
  // 还在，整段就该被换回术语库的译名，而不是把引擎的说法留在译文里。
  const translated = "一个 [[ TG0000 ]] 支持向量机 [[ / TG0000 ]] 。";
  const { text, report } = restoreCnkiTerms(translated, protectedText.terms);

  assert.equal(text, "一个 支持向量机 。");
  assert.equal(report.restored, 1);
  assert.equal(report.lost, 0);
});

test("CNKI restoration reports a term whose markers were swallowed", () => {
  const protectedText = protectCnkiTerms("A support vector machine.", [
    pair("support vector machine", "支持向量机"),
  ]);
  const { text, report } = restoreCnkiTerms(
    "一个支持向量机。",
    protectedText.terms,
  );

  assert.equal(text, "一个支持向量机。");
  assert.equal(report.restored, 0);
  assert.equal(report.lost, 1);
  assert.deepEqual(report.lostTerms, ["support vector machine"]);
});

test("CNKI restoration cleans a half-eaten marker and counts it as lost", () => {
  const protectedText = protectCnkiTerms("A support vector machine.", [
    pair("support vector machine", "支持向量机"),
  ]);
  // 只剩开始标记：无法确认引擎用了哪个译名，必须算 lost，而且不能把标记漏进界面。
  const { text, report } = restoreCnkiTerms(
    "一个[[TG0000]]支持向量机。",
    protectedText.terms,
  );

  assert.equal(text, "一个支持向量机。");
  assert.doesNotMatch(text, /\[\[/);
  assert.equal(report.lost, 1);
  assert.deepEqual(report.lostTerms, ["support vector machine"]);
});

test("CNKI restoration splits the count when only some markers survive", () => {
  const protectedText = protectCnkiTerms("machine learning and deep learning", [
    pair("machine learning", "机器学习"),
    pair("deep learning", "深度学习"),
  ]);
  const { text, report } = restoreCnkiTerms(
    "[[TG0000]]机器学习[[/TG0000]]与深度学习",
    protectedText.terms,
  );

  assert.equal(text, "机器学习与深度学习");
  assert.equal(report.restored, 1);
  assert.equal(report.lost, 1);
  assert.deepEqual(report.lostTerms, ["deep learning"]);
});

test("human review wins duplicate English mappings", () => {
  const selected = preferredTranslationPairs([
    pair("PASP", "肺动脉收缩压"),
    pair("PASP", "后负荷", {
      source: "human_review",
      status: "suggested",
      confidence: 0.5,
    }),
  ]);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].zh, "后负荷");
});
