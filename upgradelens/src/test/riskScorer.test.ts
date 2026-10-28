import assert from "node:assert/strict";
import { test } from "node:test";
import { RiskScorer } from "../analysis/RiskScorer";
import { ImpactFinding } from "../models/ImpactFinding";

const scorer = new RiskScorer();

function finding(overrides: Partial<ImpactFinding>): ImpactFinding {
  return {
    id: "f",
    severity: "medium",
    category: "unknown",
    certainty: "likely",
    packageName: "pkg",
    title: "t",
    description: "d",
    confidence: 0.8,
    ...overrides,
  };
}

test("no findings on a major bump yields low, non-zero risk", () => {
  const risk = scorer.score([], [], "major");
  assert.equal(risk.level, "low");
  assert.ok(risk.score > 0);
});

test("a single critical, high-confidence, used finding yields high or critical risk", () => {
  const findings = [finding({ severity: "critical", confidence: 0.98, filePath: "a.ts" })];
  const affected = [{ filePath: "a.ts", severity: "critical" as const, findingIds: ["f"] }];
  const risk = scorer.score(findings, affected, "major");
  assert.ok(risk.level === "high" || risk.level === "critical");
});

test("risk score is monotonic in finding count", () => {
  const one = scorer.score([finding({ severity: "high", filePath: "a.ts" })], [{ filePath: "a.ts", severity: "high", findingIds: ["1"] }], "minor");
  const two = scorer.score(
    [finding({ severity: "high", filePath: "a.ts" }), finding({ severity: "high", filePath: "b.ts", id: "2" })],
    [
      { filePath: "a.ts", severity: "high", findingIds: ["1"] },
      { filePath: "b.ts", severity: "high", findingIds: ["2"] },
    ],
    "minor"
  );
  assert.ok(two.score >= one.score);
});

test("low-confidence findings contribute less than high-confidence ones", () => {
  const lowConfidence = scorer.score([finding({ severity: "high", confidence: 0.3 })], [], "minor");
  const highConfidence = scorer.score([finding({ severity: "high", confidence: 1 })], [], "minor");
  assert.ok(highConfidence.score > lowConfidence.score);
});

test("every non-zero-weight reason is explainable (has a label)", () => {
  const risk = scorer.score([finding({ severity: "critical", filePath: "a.ts" })], [{ filePath: "a.ts", severity: "critical", findingIds: ["f"] }], "major");
  for (const reason of risk.reasons) {
    assert.ok(reason.label.length > 0);
  }
});

test("score is clamped to [0, 100]", () => {
  const manyFindings = Array.from({ length: 50 }, (_, i) => finding({ severity: "critical", confidence: 1, id: `${i}`, filePath: `f${i}.ts` }));
  const affected = manyFindings.map((f) => ({ filePath: f.filePath!, severity: "critical" as const, findingIds: [f.id] }));
  const risk = scorer.score(manyFindings, affected, "major");
  assert.ok(risk.score <= 100);
  assert.equal(risk.level, "critical");
});
