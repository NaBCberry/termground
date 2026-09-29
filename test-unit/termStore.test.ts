import assert from "node:assert/strict";
import { test } from "node:test";

import { splitCandidates, type Candidate } from "../src/modules/termExtract.ts";
import {
  buildPdf2zhGlossary,
  TermStore,
  type TermPair,
} from "../src/modules/termStore.ts";

function candidate(overrides: Partial<Candidate>): Candidate {
  return {
    zh: "交叉定位",
    en: "Cross-Localization",
    method: "author_note",
    score: 0.95,
    quote: "本文提出一种交叉定位（Cross-Localization, CL）方法。",
    page: 3,
    section: "abstract_zh",
    ...overrides,
  };
}

test("confident pairs are promotable and nothing else is", () => {
  const { promotable, pending } = splitCandidates([
    candidate({}), // confident author note
    candidate({ score: 0.6 }), // unsure about the Chinese boundary
    candidate({
      zh: "覆盖路径规划",
      en: undefined,
      method: "zh_np_frequency",
      score: 0.45,
    }),
    candidate({
      zh: "低频短语",
      en: undefined,
      method: "zh_np_frequency",
      score: 0.25,
    }),
  ]);

  assert.equal(promotable.length, 1);
  assert.equal(promotable[0].zh, "交叉定位");
  // The unsure one and the frequent Chinese-only one are worth a human's time;
  // the low-frequency phrase would only add noise.
  assert.deepEqual(
    pending.map((c) => c.zh),
    ["交叉定位", "覆盖路径规划"],
  );
});

test("a rejected candidate is not resurrected by a later run", () => {
  const store = TermStore.fromData();
  const entry = candidate({ score: 0.6 });

  assert.equal(store.addPending(entry), "new");
  const [pending] = store.openPending();
  store.rejectPending(pending);
  assert.equal(store.pendingCounts().open, 0);
  assert.equal(store.pendingCounts().rejected, 1);

  // Re-running extraction over the same papers must not bring it back.
  assert.equal(store.addPending(entry), "rejected");
  assert.equal(store.pendingCounts().open, 0);
});

test("seeing the same candidate again only bumps its counter", () => {
  const store = TermStore.fromData();
  assert.equal(store.addPending(candidate({ score: 0.6 })), "new");
  assert.equal(store.addPending(candidate({ score: 0.6 })), "seen");
  assert.equal(store.openPending().length, 1);
  assert.equal(store.openPending()[0].seenCount, 2);
});

test("accepting unchanged keeps the verified status and its evidence", () => {
  const store = TermStore.fromData();
  store.addPending(candidate({ score: 0.6 }));
  const [pending] = store.openPending();

  assert.equal(store.acceptPending(pending), true);
  assert.equal(store.pendingCounts().open, 0);
  assert.equal(store.data.pairs.length, 1);
  assert.equal(store.data.pairs[0].status, "verified");
  assert.equal(store.data.evidence.length, 1);
  assert.equal(store.data.evidence[0].page, 3);
});

test("a pair the reviewer completed is only suggested, not verified", () => {
  const store = TermStore.fromData();
  store.addPending(
    candidate({
      zh: "覆盖路径规划",
      en: undefined,
      method: "zh_np_frequency",
      score: 0.45,
    }),
  );
  const [pending] = store.openPending();

  // The reviewer supplies the English the corpus never stated.
  assert.equal(
    store.acceptPending(pending, { en: "coverage path planning" }),
    true,
  );
  const pair = store.data.pairs[0];
  assert.equal(pair.status, "suggested");
  assert.equal(pair.source, "human_review");
});

test("a corrected Chinese term is stored as the reviewer typed it", () => {
  const store = TermStore.fromData();
  store.addPending(candidate({ zh: "框架下融合到达时间差", score: 0.6 }));
  const [pending] = store.openPending();

  store.acceptPending(pending, { zh: "到达时间差" });
  assert.equal(store.data.pairs[0].zh, "到达时间差");
  assert.equal(store.data.pairs[0].status, "suggested");
  assert.equal(store.lookupZh("到达时间差").length, 1);
});

test("accepted terms immediately feed the next boundary decision", () => {
  const store = TermStore.fromData();
  store.addPending(candidate({ score: 0.6 }));
  const [pending] = store.openPending();
  store.acceptPending(pending);
  assert.ok(store.knownZhLemmas().has("交叉定位"));
});

test("PDF2zh glossary is English-to-Chinese and prefers human review", () => {
  const base: TermPair = {
    id: "term-automl",
    en: "Automated Machine Learning",
    zh: "自动化机器学习",
    role: "preferred",
    status: "verified",
    source: "author_note",
    confidence: 0.95,
    at: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const csv = buildPdf2zhGlossary([
    base,
    {
      ...base,
      zh: "自动机器学习",
      status: "suggested",
      source: "human_review",
      confidence: 0.5,
    },
    {
      ...base,
      en: 'Model "Selection", Method',
      zh: "模型选择",
    },
  ]);

  assert.match(csv, /^source,target,tgt_lng\n/);
  assert.match(csv, /"Automated Machine Learning","自动机器学习","zh-CN"/);
  assert.doesNotMatch(csv, /自动化机器学习/);
  assert.match(csv, /"Model ""Selection"", Method","模型选择","zh-CN"/);
});

test("legacy data receives stable ids and keeps evidence attached after editing", () => {
  const store = TermStore.fromData({
    version: 1,
    pairs: [
      {
        en: "Machine Learning",
        zh: "机器学习",
        role: "preferred",
        status: "verified",
        source: "author_note",
        confidence: 0.95,
        at: "2026-01-01T00:00:00.000Z",
      } as TermPair,
    ],
    evidence: [
      {
        en: "Machine Learning",
        zh: "机器学习",
        quote: "机器学习（Machine Learning）",
        page: 1,
        section: "abstract_zh",
        source: "author_note",
        at: "2026-01-01T00:00:00.000Z",
      } as never,
    ],
  });
  const pair = store.data.pairs[0];
  assert.ok(pair.id);
  assert.equal(store.evidenceForTerm(pair.id).length, 1);
  store.updateTerm(pair.id, { en: "Machine Learning", zh: "机器学习方法" });
  assert.equal(store.evidenceForTerm(pair.id).length, 1);
});

test("manual CRUD rejects duplicates and deletion can be restored", () => {
  const store = TermStore.fromData();
  const pair = store.createTerm({ en: "Deep Learning", zh: "深度学习" });
  assert.equal(pair.source, "human_review");
  assert.throws(
    () => store.createTerm({ en: "deep learning", zh: "深度学习" }),
    /已经存在/,
  );
  const snapshot = { pairs: [pair], evidence: store.evidenceForTerm(pair.id) };
  assert.equal(store.deleteTerms([pair.id]).pairs, 1);
  assert.equal(store.data.pairs.length, 0);
  store.restoreDeleted(snapshot.pairs, snapshot.evidence);
  assert.equal(store.data.pairs[0].id, pair.id);
});
