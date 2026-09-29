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
  const restored = restoreCnkiTerms(translated, protectedText.terms);

  assert.equal(restored, "我们使用一个支持向量机.");
  assert.doesNotMatch(restored, /TG0000/);
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
