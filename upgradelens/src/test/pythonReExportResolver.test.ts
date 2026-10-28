import assert from "node:assert/strict";
import { test } from "node:test";
import { PythonReExportResolver, findPythonReExports } from "../analysis/PythonReExportResolver";

test("findPythonReExports extracts named and star forms", () => {
  const src = "from requests import get, post as http_post\nfrom .utils import *\n";
  const entries = findPythonReExports(src);
  assert.ok(entries.some((e) => e.kind === "named" && e.moduleSpecifier === "requests"));
  assert.ok(entries.some((e) => e.kind === "star" && e.isRelative));
});

test("resolveToPackage follows __init__.py re-export of a third-party symbol", () => {
  const files = new Map<string, string>([
    [
      "mypkg/__init__.py",
      "from requests import get, post\n",
    ],
    [
      "app.py",
      "from mypkg import get\nget('https://example.com')\n",
    ],
  ]);
  const resolver = new PythonReExportResolver(files);
  const resolved = resolver.resolveToPackage("app.py", "mypkg", "get", "requests", ["requests"]);
  assert.equal(resolved, "get");
});

test("resolveToPackage follows relative re-export chain", () => {
  const files = new Map<string, string>([
    ["mypkg/http.py", "from requests import get\n"],
    ["mypkg/__init__.py", "from .http import get\n"],
    ["app.py", "from mypkg import get\n"],
  ]);
  const resolver = new PythonReExportResolver(files);
  const resolved = resolver.resolveToPackage("app.py", "mypkg", "get", "requests", ["requests"]);
  assert.equal(resolved, "get");
});

test("resolveToPackage returns null when the chain does not reach the package", () => {
  const files = new Map<string, string>([
    ["mypkg/__init__.py", "from os import path\n"],
    ["app.py", "from mypkg import path\n"],
  ]);
  const resolver = new PythonReExportResolver(files);
  const resolved = resolver.resolveToPackage("app.py", "mypkg", "path", "requests", ["requests"]);
  assert.equal(resolved, null);
});
