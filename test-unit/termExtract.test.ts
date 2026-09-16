import assert from "node:assert/strict";
import { test } from "node:test";

import {
  extractFromSegments,
  findAuthorNotes,
  findEnglishFirstNotes,
  isPlausiblePair,
  refineZhBoundary,
  selectPromotable,
  truncateAtMetadata,
  type Segment,
} from "../src/modules/termExtract.ts";

test("a short generic known term does not hijack a longer term", () => {
  // The shared seed table really does contain a bare 单元 entry.
  const notes = findAuthorNotes(
    "与惯性测量单元（Inertial Measurement Unit, IMU）的航向角。",
    new Set(["单元"]),
  );
  assert.equal(notes.length, 1);
  assert.equal(notes[0].zh, "惯性测量单元");
  assert.equal(notes[0].en, "Inertial Measurement Unit");
  assert.equal(notes[0].abbr, "IMU");
  assert.equal(notes[0].certain, true);
});

test("a specific known suffix wins over a broken trim", () => {
  const [term, certain] = refineZhBoundary(
    "提出了跨模态对齐",
    new Set(["跨模态对齐"]),
  );
  assert.equal(term, "跨模态对齐");
  assert.equal(certain, true);
});

test("a leading connective is trimmed and treated as certain", () => {
  const [term, certain] = refineZhBoundary("本文的导航", new Set());
  assert.equal(term, "导航");
  assert.equal(certain, true);
});

test("an unrecoverable boundary stays uncertain", () => {
  const [term, certain] = refineZhBoundary(
    "研究者通常依赖惯性测量单元",
    new Set(),
  );
  assert.equal(certain, false);
  assert.ok(term.length > 0);
});

test("a connective in the middle is used to cut the head", () => {
  // "该方法在因子图（Factor Graph, FG）" must yield 因子图, not 方法在因子图.
  const [term, certain] = refineZhBoundary("该方法在因子图", new Set());
  assert.equal(term, "因子图");
  assert.equal(certain, true);
});

test("English-first glosses are read from the parentheses", () => {
  const notes = findEnglishFirstNotes("Particle Filter（粒子滤波）is used.");
  assert.equal(notes.length, 1);
  assert.equal(notes[0].en, "Particle Filter");
  assert.equal(notes[0].zh, "粒子滤波");
  assert.equal(notes[0].certain, true);
});

const PAPER: Segment[] = [
  {
    page: 1,
    section: "abstract_zh",
    text:
      "摘要：本文提出一种结合超宽带（Ultra-Wideband, UWB）与粒子滤波" +
      "（Particle Filter, PF）的交叉定位（Cross-Localization, CL）方法。" +
      "该方法在因子图（Factor Graph, FG）框架下融合到达时间差" +
      "（Time Difference of Arrival, TDOA）观测，用于目标搜索与导航。",
  },
  {
    page: 1,
    section: "keywords_zh",
    text: "关键词：交叉定位；目标搜索；导航；超宽带；粒子滤波；因子图",
  },
  {
    page: 1,
    section: "keywords_en",
    text:
      "Keywords: Cross-Localization; Target Search; Navigation; " +
      "Ultra-Wideband; Particle Filter; Factor Graph",
  },
];

test("author glosses and keyword pairs are both extracted", () => {
  const { candidates, stats } = extractFromSegments(PAPER, new Set());

  assert.equal(stats.authorNotes, 5);
  assert.equal(stats.zhKeywords, 6);
  assert.equal(stats.enKeywords, 6);
  assert.equal(stats.keywordPairs, 6);

  const pairs = candidates.filter((c) => c.method === "bilingual_keyword");
  assert.deepEqual(
    pairs.map((c) => [c.zh, c.en]),
    [
      ["交叉定位", "Cross-Localization"],
      ["目标搜索", "Target Search"],
      ["导航", "Navigation"],
      ["超宽带", "Ultra-Wideband"],
      ["粒子滤波", "Particle Filter"],
      ["因子图", "Factor Graph"],
    ],
  );
});

test("every evidence quote carries the page it came from", () => {
  const { candidates } = extractFromSegments(
    [{ page: 7, section: "method", text: "采用超宽带（Ultra-Wideband）测距。" }],
    new Set(),
  );
  const gloss = candidates.find((c) => c.method === "author_note");
  assert.ok(gloss);
  assert.equal(gloss.page, 7);
  assert.equal(gloss.section, "method");
  assert.match(gloss.quote, /超宽带/);
});

test("only confident pairs are promoted", () => {
  const { candidates } = extractFromSegments(PAPER, new Set());
  const promotable = selectPromotable(candidates);

  // Four confident author glosses plus six keyword pairs. The fifth gloss
  // (到达时间差) has a head that cannot be cut reliably, so it stays in review,
  // and frequency candidates never qualify.
  assert.equal(promotable.length, 10);
  assert.ok(promotable.every((c) => (c.en ?? "").length > 0));
  assert.equal(
    promotable.filter((c) => c.method === "zh_np_frequency").length,
    0,
  );
});

test("no promoted pair carries a connective in its head", () => {
  const { candidates } = extractFromSegments(PAPER, new Set());
  for (const candidate of selectPromotable(candidates)) {
    assert.doesNotMatch(candidate.zh, /[在的]/);
  }
});

test("an uncertain boundary is not promoted", () => {
  const segments: Segment[] = [
    {
      page: 1,
      section: "body",
      text: "研究者通常依赖惯性测量单元（Inertial Measurement Unit, IMU）。",
    },
  ];
  const { candidates } = extractFromSegments(segments, new Set());
  const gloss = candidates.find((c) => c.method === "author_note");
  assert.ok(gloss);
  assert.equal(gloss.score, 0.6);
  assert.equal(selectPromotable(candidates).length, 0);
});

test("known terms are not reported as unmapped candidates", () => {
  const segments: Segment[] = [
    {
      page: 1,
      section: "body",
      text: "交叉定位精度与交叉定位轨迹误差都在评估范围内。",
    },
  ];
  const known = new Set(["交叉定位", "定位精度", "轨迹误差"]);
  const { candidates } = extractFromSegments(segments, known);
  assert.equal(
    candidates.filter((c) => c.method === "zh_np_frequency").length,
    0,
  );
});

// The cases below all come from a real run over 21 Chinese journal papers.

test("keyword lines are cut at journal boilerplate", () => {
  const raw =
    "路径规划中图分类号: V279 文献标志码: A 文章编号: 1000-1093 收稿日期: 2025-06-19";
  assert.equal(truncateAtMetadata(raw), "路径规划");

  const { candidates } = extractFromSegments(
    [
      { page: 1, section: "keywords_zh", text: `关键词：${raw}` },
      {
        page: 1,
        section: "keywords_en",
        text: "Keywords: path planning; route planning",
      },
    ],
    new Set(),
  );
  const pairs = candidates.filter((c) => c.method === "bilingual_keyword");
  assert.deepEqual(
    pairs.map((c) => [c.zh, c.en]),
    [["路径规划", "path planning"]],
  );
});

test("spaces between CJK glyphs are removed from the stored quote", () => {
  const { candidates } = extractFromSegments(
    [
      {
        page: 2,
        section: "body",
        text: "采 用 覆 盖 路 径 规 划（Coverage Path Planning, CPP）方法。",
      },
    ],
    new Set(),
  );
  const gloss = candidates.find((c) => c.method === "author_note");
  assert.ok(gloss);
  assert.equal(gloss.zh, "覆盖路径规划");
  assert.doesNotMatch(gloss.quote, /覆 盖/);
});

test("pseudo-code glosses are rejected", () => {
  // "当前时间-最近尝试时间（if …）" came out of a table in a real paper.
  assert.equal(isPlausiblePair("当前时间-最近尝试时间", "if"), false);
});

test("shredded English keywords are rejected", () => {
  assert.equal(
    isPlausiblePair("分布式模型预测控制", "dist rib ut ed model predicti ve cont r ol"),
    false,
  );
  assert.equal(isPlausiblePair("避开障碍物和威胁源", "Revised:2015-05-24"), false);
});

test("plausible pairs still pass the guard", () => {
  assert.equal(isPlausiblePair("覆盖路径规划", "coverage path planning"), true);
  assert.equal(isPlausiblePair("无人机集群", "unmanned aerial vehicle swarm"), true);
});

test("CJK-only Chinese is required", () => {
  assert.equal(isPlausiblePair("PI D 控制", "PID controller"), false);
});

test("concatenated English keywords are dropped, not stored", () => {
  // The text layer stripped the spaces in the English keyword list.
  const { candidates } = extractFromSegments(
    [
      { page: 1, section: "keywords_zh", text: "关键词：无人机集群；滚动窗口" },
      {
        page: 1,
        section: "keywords_en",
        text: "Keywords: unmannedaerialvehicle; rolling window",
      },
    ],
    new Set(),
  );
  const pairs = candidates.filter((c) => c.method === "bilingual_keyword");
  // The first pair is unusable; the second one is still good.
  assert.deepEqual(
    pairs.map((c) => [c.zh, c.en]),
    [["滚动窗口", "rolling window"]],
  );
});
