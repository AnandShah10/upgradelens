import assert from "node:assert/strict";
import { test } from "node:test";
import { PythonUsageAnalyzer } from "../analysis/PythonUsageAnalyzer";

const analyzer = new PythonUsageAnalyzer();

test("detects a simple from-import and its usage", () => {
  const src = 'from requests import get\nget("http://example.com")';
  const summary = analyzer.analyzeSource(src, "a.py", "requests");
  assert.ok(summary);
  assert.ok(summary!.usedSymbols.has("get"));
});

test("distinguishes imported-only from imported-and-used in a from-import", () => {
  const src = "from requests import get, post\nget()";
  const summary = analyzer.analyzeSource(src, "b.py", "requests");
  assert.ok(summary);
  assert.ok(summary!.importedSymbols.has("post"));
  assert.ok(!summary!.usedSymbols.has("post"));
  assert.ok(summary!.usedSymbols.has("get"));
});

test("handles 'as' aliasing in a from-import, tracking the original exported name", () => {
  const src = "from requests import get as g\ng()";
  const summary = analyzer.analyzeSource(src, "c.py", "requests");
  assert.ok(summary);
  assert.ok(summary!.usedSymbols.has("get"));
});

test("handles a multi-line parenthesized from-import without treating its own body as usage", () => {
  const src = "from requests import (\n    get,\n    post,\n)\nget(\"x\")";
  const summary = analyzer.analyzeSource(src, "d.py", "requests");
  assert.ok(summary);
  assert.ok(summary!.usedSymbols.has("get"));
  assert.ok(!summary!.usedSymbols.has("post"));
  const getRefs = summary!.symbolReferences.filter((r) => r.symbol === "get");
  assert.equal(getRefs.length, 1); // only the real call site, not the import's own line
});

test("handles a star import without crashing, tracking no specific symbols", () => {
  const src = "from requests import *";
  const summary = analyzer.analyzeSource(src, "e.py", "requests");
  assert.ok(summary);
  assert.equal(summary!.importedSymbols.size, 0);
});

test("detects a bare import and resolves member access to the specific member", () => {
  const src = 'import requests\nrequests.get("http://example.com")';
  const summary = analyzer.analyzeSource(src, "f.py", "requests");
  assert.ok(summary);
  assert.ok(summary!.usedSymbols.has("get"));
  assert.ok(summary!.usedSymbols.has("requests")); // the bare namespace binding itself is also tracked
});

test("handles an aliased bare import", () => {
  const src = "import numpy as np\narr = np.array([1, 2, 3])";
  const summary = analyzer.analyzeSource(src, "g.py", "numpy");
  assert.ok(summary);
  assert.ok(summary!.usedSymbols.has("array"));
});

test("binds a dotted bare import to its first component (real Python semantics)", () => {
  const src = "import xml.etree.ElementTree\nxml.etree.ElementTree.parse('f.xml')";
  const summary = analyzer.analyzeSource(src, "h.py", "xml");
  assert.ok(summary);
  // "xml" itself is the real local binding for a dotted import without an alias.
  assert.ok(summary!.usedSymbols.has("xml"));
});

test("resolves a PyPI package name that differs from its Python import name (Pillow -> PIL)", () => {
  const src = 'from PIL import Image\nimg = Image.open("x.png")';
  const summary = analyzer.analyzeSource(src, "i.py", "Pillow");
  assert.ok(summary);
  assert.ok(summary!.usedSymbols.has("Image"));
});

test("resolves a PyPI package name via the bare namespace import too (beautifulsoup4 -> bs4)", () => {
  const src = 'import bs4\nsoup = bs4.BeautifulSoup("<html></html>", "html.parser")';
  const summary = analyzer.analyzeSource(src, "j.py", "beautifulsoup4");
  assert.ok(summary);
  assert.ok(summary!.usedSymbols.has("BeautifulSoup"));
});

test("returns null for a file that doesn't import the target package at all", () => {
  const src = 'import os\nos.path.join("a", "b")';
  const summary = analyzer.analyzeSource(src, "k.py", "requests");
  assert.equal(summary, null);
});

test("does not count a mention inside a docstring as real usage", () => {
  const src = '"""\nThis module relies on requests internally.\n"""\nimport os';
  const summary = analyzer.analyzeSource(src, "l.py", "requests");
  assert.equal(summary, null);
});

test("does not count a mention inside a comment as real usage", () => {
  const src = "# consider using requests here\nimport os";
  const summary = analyzer.analyzeSource(src, "m.py", "requests");
  assert.equal(summary, null);
});

test("still counts a real call inside an f-string interpolation as usage", () => {
  const src = "from requests import get\nmsg = f\"Response: {get('x').status_code}\"";
  const summary = analyzer.analyzeSource(src, "n.py", "requests");
  assert.ok(summary);
  assert.ok(summary!.usedSymbols.has("get"));
});

test("detects an import nested inside a function body (a common lazy-import pattern)", () => {
  const src = "def helper():\n    import requests\n    return requests.get('x')";
  const summary = analyzer.analyzeSource(src, "o.py", "requests");
  assert.ok(summary);
  assert.ok(summary!.usedSymbols.has("get"));
});

test("handles multiple comma-separated bare imports on one line", () => {
  const src = "import os, requests, sys\nrequests.get('x')";
  const summary = analyzer.analyzeSource(src, "p.py", "requests");
  assert.ok(summary);
  assert.ok(summary!.usedSymbols.has("get"));
});

test("records the import site location, not just the usage site", () => {
  const src = 'from requests import get\n\n\nget("x")';
  const summary = analyzer.analyzeSource(src, "q.py", "requests");
  assert.ok(summary);
  const usage = summary!.usages.find((u) => u.importedSymbols.includes("get"));
  assert.ok(usage);
  assert.equal(usage!.line, 1);
});
