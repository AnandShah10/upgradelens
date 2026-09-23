import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ImpactEngine } from "../analysis/ImpactEngine";
import { RiskScorer } from "../analysis/RiskScorer";
import { UsageAnalyzer } from "../analysis/UsageAnalyzer";
import { DemoChangeProvider, DEMO_FROM_VERSION, DEMO_PACKAGE_NAME, DEMO_TO_VERSION } from "../changelog/DemoChangeProvider";

// Exercises the exact same pipeline the "Run Demo Simulation" command and
// SimulationService use, minus the vscode.workspace file-finding step
// (replaced here with plain fs reads of the same fixture files) - this is
// what keeps the demo mode and the tests both honest about using the real
// ImpactEngine/RiskScorer rather than a parallel mock implementation.

const FIXTURE_ROOT = path.join(__dirname, "fixtures", "demo-project", "src");

function readFixture(relativePath: string): string {
  return fs.readFileSync(path.join(FIXTURE_ROOT, relativePath), "utf8");
}

test("demo-package 1.4.0 -> 2.0.0 produces a HIGH+ risk report with 4 affected files", async () => {
  const usageAnalyzer = new UsageAnalyzer();
  const impactEngine = new ImpactEngine();
  const riskScorer = new RiskScorer();
  const changeProvider = new DemoChangeProvider();

  const files = [
    "api/client.ts",
    "services/auth.ts",
    "config.ts",
    "components/App.tsx",
  ];

  const usageByFile = files
    .map((f) => usageAnalyzer.analyzeSource(readFixture(f), `src/${f}`, DEMO_PACKAGE_NAME))
    .filter((s): s is NonNullable<typeof s> => s !== null);

  assert.equal(usageByFile.length, 4, "all four fixture files should reference demo-package");

  const changes = await changeProvider.getChanges(DEMO_PACKAGE_NAME, DEMO_FROM_VERSION, DEMO_TO_VERSION);
  assert.equal(changes.length, 4);

  const findings = impactEngine.correlate(changes, usageByFile);
  const affectedFiles = impactEngine.buildAffectedFiles(findings);
  const checklist = impactEngine.buildMigrationChecklist(findings);
  const risk = riskScorer.score(findings, affectedFiles, "major");

  assert.equal(affectedFiles.length, 4, "every fixture file should show up as affected");
  assert.ok(
    findings.some((f) => f.symbol === "oldApi" && f.severity === "critical" && f.filePath === "src/api/client.ts"),
    "removed oldApi() used in client.ts should be a critical finding"
  );
  assert.ok(
    findings.some((f) => f.symbol === "legacyClient" && f.filePath === "src/services/auth.ts"),
    "renamed legacyClient used in auth.ts should be flagged"
  );
  assert.ok(checklist.length > 0, "a migration checklist should be generated");
  assert.ok(risk.level === "high" || risk.level === "critical", `expected high/critical risk, got ${risk.level}`);
});
