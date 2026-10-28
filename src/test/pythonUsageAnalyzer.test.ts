import assert from "node:assert/strict";
import { test } from "node:test";
import { PythonUsageAnalyzer } from "../analysis/PythonUsageAnalyzer";

function treeSitterAvailable(): boolean {
  try {
    require("web-tree-sitter");
    return true;
  } catch {
    return false;
  }
}

const analyzer = new PythonUsageAnalyzer();
const hasTreeSitter = treeSitterAvailable();
function skipWithoutTreeSitter(t: { skip: (msg?: string) => void }): boolean {
  if (!hasTreeSitter) {
    t.skip("web-tree-sitter not installed — run npm install");
    return true;
  }
  return false;
}

test("detects a simple from-import and its usage", async (t) => {
  if (skipWithoutTreeSitter(t)) return;
  const src = 'from requests import get\nget("http://example.com")';
  const summary = await analyzer.analyzeSource(src, "a.py", "requests");
  assert.ok(summary);
  assert.ok(summary!.usedSymbols.has("get"));
});

test("distinguishes imported-only from imported-and-used in a from-import", async (t) => {
  if (skipWithoutTreeSitter(t)) return;
  const src = "from requests import get, post\nget()";
  const summary = await analyzer.analyzeSource(src, "b.py", "requests");
  assert.ok(summary);
  assert.ok(summary!.importedSymbols.has("post"));
  assert.ok(!summary!.usedSymbols.has("post"));
  assert.ok(summary!.usedSymbols.has("get"));
});

test("handles 'as' aliasing in a from-import, tracking the original exported name", async (t) => {
  if (skipWithoutTreeSitter(t)) return;
  const src = "from requests import get as g\ng()";
  const summary = await analyzer.analyzeSource(src, "c.py", "requests");
  assert.ok(summary);
  assert.ok(summary!.usedSymbols.has("get"));
});

test("handles a multi-line parenthesized from-import without treating its own body as usage", async (t) => {
  if (skipWithoutTreeSitter(t)) return;
  const src = "from requests import (\n    get,\n    post,\n)\nget(\"x\")";
  const summary = await analyzer.analyzeSource(src, "d.py", "requests");
  assert.ok(summary);
  assert.ok(summary!.usedSymbols.has("get"));
  assert.ok(!summary!.usedSymbols.has("post"));
  const getRefs = summary!.symbolReferences.filter((r) => r.symbol === "get");
  assert.equal(getRefs.length, 1); // only the real call site, not the import's own line
});

test("handles a star import without crashing, tracking no specific symbols", async (t) => {
  if (skipWithoutTreeSitter(t)) return;
  const src = "from requests import *";
  const summary = await analyzer.analyzeSource(src, "e.py", "requests");
  assert.ok(summary);
  assert.equal(summary!.importedSymbols.size, 0);
});

test("detects a bare import and resolves member access to the specific member", async (t) => {
  if (skipWithoutTreeSitter(t)) return;
  const src = 'import requests\nrequests.get("http://example.com")';
  const summary = await analyzer.analyzeSource(src, "f.py", "requests");
  assert.ok(summary);
  assert.ok(summary!.usedSymbols.has("get"));
  assert.ok(summary!.usedSymbols.has("requests")); // the bare namespace binding itself is also tracked
});

test("handles an aliased bare import", async (t) => {
  if (skipWithoutTreeSitter(t)) return;
  const src = "import numpy as np\narr = np.array([1, 2, 3])";
  const summary = await analyzer.analyzeSource(src, "g.py", "numpy");
  assert.ok(summary);
  assert.ok(summary!.usedSymbols.has("array"));
});

test("binds a dotted bare import to its first component (real Python semantics)", async (t) => {
  if (skipWithoutTreeSitter(t)) return;
  const src = "import xml.etree.ElementTree\nxml.etree.ElementTree.parse('f.xml')";
  const summary = await analyzer.analyzeSource(src, "h.py", "xml");
  assert.ok(summary);
  // "xml" itself is the real local binding for a dotted import without an alias.
  assert.ok(summary!.usedSymbols.has("xml"));
});

test("resolves a PyPI package name that differs from its Python import name (Pillow -> PIL)", async (t) => {
  if (skipWithoutTreeSitter(t)) return;
  const src = 'from PIL import Image\nimg = Image.open("x.png")';
  const summary = await analyzer.analyzeSource(src, "i.py", "Pillow");
  assert.ok(summary);
  assert.ok(summary!.usedSymbols.has("Image"));
});

test("resolves a PyPI package name via the bare namespace import too (beautifulsoup4 -> bs4)", async (t) => {
  if (skipWithoutTreeSitter(t)) return;
  const src = 'import bs4\nsoup = bs4.BeautifulSoup("<html></html>", "html.parser")';
  const summary = await analyzer.analyzeSource(src, "j.py", "beautifulsoup4");
  assert.ok(summary);
  assert.ok(summary!.usedSymbols.has("BeautifulSoup"));
});

test("returns null for a file that doesn't import the target package at all", async (t) => {
  if (skipWithoutTreeSitter(t)) return;
  const src = 'import os\nos.path.join("a", "b")';
  const summary = await analyzer.analyzeSource(src, "k.py", "requests");
  assert.equal(summary, null);
});

test("does not count a mention inside a docstring as real usage", async (t) => {
  if (skipWithoutTreeSitter(t)) return;
  const src = '"""\nThis module relies on requests internally.\n"""\nimport os';
  const summary = await analyzer.analyzeSource(src, "l.py", "requests");
  assert.equal(summary, null);
});

test("does not count a mention inside a comment as real usage", async (t) => {
  if (skipWithoutTreeSitter(t)) return;
  const src = "# consider using requests here\nimport os";
  const summary = await analyzer.analyzeSource(src, "m.py", "requests");
  assert.equal(summary, null);
});

test("still counts a real call inside an f-string interpolation as usage", async (t) => {
  if (skipWithoutTreeSitter(t)) return;
  const src = "from requests import get\nmsg = f\"Response: {get('x').status_code}\"";
  const summary = await analyzer.analyzeSource(src, "n.py", "requests");
  assert.ok(summary);
  assert.ok(summary!.usedSymbols.has("get"));
});

test("detects an import nested inside a function body (a common lazy-import pattern)", async (t) => {
  if (skipWithoutTreeSitter(t)) return;
  const src = "def helper():\n    import requests\n    return requests.get('x')";
  const summary = await analyzer.analyzeSource(src, "o.py", "requests");
  assert.ok(summary);
  assert.ok(summary!.usedSymbols.has("get"));
});

test("handles multiple comma-separated bare imports on one line", async (t) => {
  if (skipWithoutTreeSitter(t)) return;
  const src = "import os, requests, sys\nrequests.get('x')";
  const summary = await analyzer.analyzeSource(src, "p.py", "requests");
  assert.ok(summary);
  assert.ok(summary!.usedSymbols.has("get"));
});

test("records the import site location, not just the usage site", async (t) => {
  if (skipWithoutTreeSitter(t)) return;
  const src = 'from requests import get\n\n\nget("x")';
  const summary = await analyzer.analyzeSource(src, "q.py", "requests");
  assert.ok(summary);
  const usage = summary!.usages.find((u) => u.importedSymbols.includes("get"));
  assert.ok(usage);
  assert.equal(usage!.line, 1);
});

test("does NOT count a parameter that shadows an imported name as package usage", async (t) => {
  if (skipWithoutTreeSitter(t)) return;
  // The classic false-positive the regex analyzer had:
  //   import requests
  //   def f(requests): requests.get(...)
  // must not count the body reference as usage of the package.
  const src = "import requests\ndef f(requests):\n    return requests.get('x')\n";
  const summary = await analyzer.analyzeSource(src, "shadow_param.py", "requests");
  assert.ok(summary);
  // The import itself is still recorded, but the shadowed body reference is not.
  assert.ok(!summary!.usedSymbols.has("get"), "shadowed parameter must not count as usage");
});

test("does NOT count a local assignment that shadows an imported name", async (t) => {
  if (skipWithoutTreeSitter(t)) return;
  const src = "from requests import get\ndef f():\n    get = 1\n    return get\n";
  const summary = await analyzer.analyzeSource(src, "shadow_assign.py", "requests");
  assert.ok(summary);
  assert.ok(summary!.importedSymbols.has("get"));
  assert.ok(!summary!.usedSymbols.has("get"), "local assignment must shadow the import");
});

test("still counts usage when the name is NOT shadowed in a nested function", async (t) => {
  if (skipWithoutTreeSitter(t)) return;
  const src = "from requests import get\ndef outer():\n    def inner():\n        return get('x')\n    return inner\n";
  const summary = await analyzer.analyzeSource(src, "no_shadow.py", "requests");
  assert.ok(summary);
  assert.ok(summary!.usedSymbols.has("get"));
});

test("does NOT count a for-loop target that shadows an imported name", async (t) => {
  if (skipWithoutTreeSitter(t)) return;
  const src = "import requests\nfor requests in []:\n    requests.get('x')\n";
  const summary = await analyzer.analyzeSource(src, "shadow_for.py", "requests");
  assert.ok(summary);
  assert.ok(!summary!.usedSymbols.has("get"));
});
