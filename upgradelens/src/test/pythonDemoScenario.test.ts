import assert from "node:assert/strict";
import { test } from "node:test";
import { ImpactEngine } from "../analysis/ImpactEngine";
import { PythonUsageAnalyzer } from "../analysis/PythonUsageAnalyzer";
import { RiskScorer } from "../analysis/RiskScorer";
import { KnownChangesProvider } from "../changelog/KnownChangesProvider";

// Exercises the real pipeline (PythonUsageAnalyzer -> ImpactEngine ->
// RiskScorer) end-to-end for a synthetic Django project, the same way
// demoScenario.test.ts does for the JS/TS pipeline - proving Python support
// isn't just unit-tested in isolation, but actually produces a coherent
// report when wired together.

const URLS_PY = `from django.conf.urls import url
from django.http import HttpResponse


def home(request):
    return HttpResponse("hello")


urlpatterns = [
    url(r"^$", home, name="home"),
]
`;

const UNRELATED_PY = `import os


def helper():
    return os.path.join("a", "b")
`;


function skipWithoutTreeSitter(t: { skip: (msg?: string) => void }): boolean {
  try {
    require("web-tree-sitter");
    return false;
  } catch {
    t.skip("web-tree-sitter not installed — run npm install");
    return true;
  }
}

test("django 3.2.0 -> 4.0.0 flags the removed url() shortcut as a real, high-risk finding", async (t) => {
  if (skipWithoutTreeSitter(t)) return;
  const usageAnalyzer = new PythonUsageAnalyzer();
  const impactEngine = new ImpactEngine();
  const riskScorer = new RiskScorer();
  const changeProvider = new KnownChangesProvider();

  const usageByFile = (
    await Promise.all([
      usageAnalyzer.analyzeSource(URLS_PY, "myapp/urls.py", "django"),
      usageAnalyzer.analyzeSource(UNRELATED_PY, "myapp/helpers.py", "django"),
    ])
  ).filter((s): s is NonNullable<typeof s> => s !== null);

  // Only urls.py actually imports/uses django - helpers.py shouldn't appear at all.
  assert.equal(usageByFile.length, 1);
  assert.equal(usageByFile[0].filePath, "myapp/urls.py");
  assert.ok(usageByFile[0].usedSymbols.has("url"));

  const changes = await changeProvider.getChanges("django", "3.2.0", "4.0.0");
  const findings = impactEngine.correlate(changes, usageByFile);
  const affectedFiles = impactEngine.buildAffectedFiles(findings);
  const risk = riskScorer.score(findings, affectedFiles, "major");

  assert.equal(affectedFiles.length, 1);
  assert.equal(affectedFiles[0].filePath, "myapp/urls.py");
  assert.ok(
    findings.some((f) => f.symbol === "url" && f.filePath === "myapp/urls.py" && (f.severity === "critical" || f.severity === "high")),
    "the removed url() shortcut, actually used in urls.py, should be a high-severity finding"
  );
  assert.ok(risk.level === "high" || risk.level === "critical", `expected high/critical risk, got ${risk.level}`);
});

test("a Django upgrade that doesn't cross the url() removal boundary produces no findings for it", async (t) => {
  if (skipWithoutTreeSitter(t)) return;
  const usageAnalyzer = new PythonUsageAnalyzer();
  const impactEngine = new ImpactEngine();
  const changeProvider = new KnownChangesProvider();

  const usageByFile = (
    await Promise.all([usageAnalyzer.analyzeSource(URLS_PY, "myapp/urls.py", "django")])
  ).filter((s): s is NonNullable<typeof s> => s !== null);

  const changes = await changeProvider.getChanges("django", "4.0.0", "4.2.0"); // already past the 4.0 removal
  const findings = impactEngine.correlate(changes, usageByFile);
  assert.equal(findings.filter((f) => f.symbol === "url").length, 0);
});
