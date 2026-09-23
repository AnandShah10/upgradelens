import assert from "node:assert/strict";
import { test } from "node:test";
import { ImpactEngine } from "../analysis/ImpactEngine";
import { UsageAnalyzer } from "../analysis/UsageAnalyzer";
import { PackageChange } from "../models/PackageChange";

const usageAnalyzer = new UsageAnalyzer();
const engine = new ImpactEngine();

test("removed API that is imported AND called produces a high-confidence, high-severity finding", () => {
  const src = `import { oldApi } from "pkg";\noldApi();`;
  const summary = usageAnalyzer.analyzeSource(src, "src/api.ts", "pkg")!;

  const changes: PackageChange[] = [
    {
      kind: "removed-export",
      packageName: "pkg",
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
      symbol: "oldApi",
      summary: "oldApi was removed",
      confidence: 0.98,
      source: "demo-fixture",
    },
  ];

  const findings = engine.correlate(changes, [summary]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "critical");
  assert.equal(findings[0].certainty, "confirmed");
  assert.equal(findings[0].filePath, "src/api.ts");
});

test("removed API that is only imported (never called) is downgraded but still surfaced", () => {
  const src = `import { oldApi } from "pkg";\n// not called anywhere`;
  const summary = usageAnalyzer.analyzeSource(src, "src/api.ts", "pkg")!;

  const changes: PackageChange[] = [
    {
      kind: "removed-export",
      packageName: "pkg",
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
      symbol: "oldApi",
      summary: "oldApi was removed",
      confidence: 0.98,
      source: "demo-fixture",
    },
  ];

  const findings = engine.correlate(changes, [summary]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "high"); // downgraded from "critical"
  assert.notEqual(findings[0].certainty, "confirmed");
});

test("a removed API with zero usage in the project produces no per-file finding", () => {
  const changes: PackageChange[] = [
    {
      kind: "removed-export",
      packageName: "pkg",
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
      symbol: "neverImported",
      summary: "neverImported was removed",
      confidence: 0.98,
      source: "demo-fixture",
    },
  ];

  const findings = engine.correlate(changes, []);
  assert.equal(findings.length, 0);
});

test("project-wide changes (no specific symbol) always produce exactly one finding", () => {
  const changes: PackageChange[] = [
    {
      kind: "engine-requirement-change",
      packageName: "pkg",
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
      summary: "Requires Node >=20",
      confidence: 1,
      source: "registry-metadata",
    },
  ];

  const findings = engine.correlate(changes, []);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].filePath, undefined);
});

test("buildAffectedFiles takes the highest severity per file", () => {
  const findings = [
    { id: "1", severity: "low" as const, category: "deprecated-api" as const, certainty: "likely" as const, packageName: "pkg", filePath: "a.ts", title: "t", description: "d", confidence: 0.5 },
    { id: "2", severity: "critical" as const, category: "removed-api" as const, certainty: "confirmed" as const, packageName: "pkg", filePath: "a.ts", title: "t2", description: "d2", confidence: 0.9 },
  ];
  const affected = engine.buildAffectedFiles(findings);
  assert.equal(affected.length, 1);
  assert.equal(affected[0].severity, "critical");
  assert.equal(affected[0].findingIds.length, 2);
});
