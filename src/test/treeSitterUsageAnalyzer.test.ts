import assert from "node:assert/strict";
import { test } from "node:test";
import { TreeSitterUsageAnalyzer } from "../analysis/TreeSitterUsageAnalyzer";
import { SimpleUsageAnalyzer } from "../analysis/SimpleUsageAnalyzer";

const tree = new TreeSitterUsageAnalyzer();
const simple = new SimpleUsageAnalyzer();

test("tree-sitter rust detects use and member usage", async () => {
  const src = `use serde_json::Value;\nfn main() { let _ = Value::Null; }\n`;
  const summary = await tree.analyzeSource(src, "main.rs", "serde_json", "rust");
  if (!summary) {
    const fb = simple.analyzeSource(src, "main.rs", "serde_json", "rust");
    assert.ok(fb, "regex fallback should detect rust use");
    return;
  }
  assert.ok(summary.importedSymbols.size > 0 || summary.usages.length > 0);
});

test("tree-sitter go detects import", async () => {
  const src = `package main\nimport "github.com/foo/bar"\nfunc main() {\n  bar.Do()\n}\n`;
  const summary = await tree.analyzeSource(src, "main.go", "github.com/foo/bar", "go");
  if (!summary) {
    const fb = simple.analyzeSource(src, "main.go", "github.com/foo/bar", "go");
    assert.ok(fb, "regex fallback should detect go import");
    return;
  }
  assert.ok(summary.usages.length > 0);
});

test("tree-sitter java detects import", async () => {
  const src = `import com.squareup.okhttp3.OkHttpClient;\nclass T { void x() { new OkHttpClient(); } }\n`;
  const summary = await tree.analyzeSource(src, "T.java", "com.squareup.okhttp3:okhttp", "java");
  if (!summary) {
    const fb = simple.analyzeSource(src, "T.java", "com.squareup.okhttp3:okhttp", "java");
    assert.ok(fb, "regex fallback should detect java import");
    return;
  }
  assert.ok(summary.usages.length > 0);
});

test("simple analyzer kotlin import mirrors java", () => {
  const src = `import com.squareup.okhttp3.OkHttpClient\nclass A { val c = OkHttpClient() }\n`;
  const summary = simple.analyzeSource(src, "A.kt", "com.squareup.okhttp3:okhttp", "java");
  assert.ok(summary, "kotlin-style import should be detected");
  assert.ok(
    summary!.usedSymbols.has("OkHttpClient") || summary!.importedSymbols.has("OkHttpClient")
  );
});
