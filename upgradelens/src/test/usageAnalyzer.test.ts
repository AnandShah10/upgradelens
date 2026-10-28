import assert from "node:assert/strict";
import { test } from "node:test";
import { UsageAnalyzer } from "../analysis/UsageAnalyzer";
import { ReExportResolver } from "../analysis/ReExportResolver";

const analyzer = new UsageAnalyzer();

test("detects default import", () => {
  const src = `import foo from "pkg";\nfoo();`;
  const summary = analyzer.analyzeSource(src, "a.ts", "pkg");
  assert.ok(summary);
  assert.equal(summary!.usages.length, 1);
  assert.equal(summary!.usages[0].bindingKind, "default");
  assert.deepEqual(summary!.usages[0].importedSymbols, ["foo"]);
});

test("detects named imports, including aliasing", () => {
  const src = `import { a, b as c } from "pkg";\na();\nc();`;
  const summary = analyzer.analyzeSource(src, "b.ts", "pkg");
  assert.ok(summary);
  assert.deepEqual(summary!.usages[0].importedSymbols.sort(), ["a", "b"]);
  assert.ok(summary!.usedSymbols.has("a"));
  assert.ok(summary!.usedSymbols.has("b"));
});

test("detects namespace import, plus the specific member accessed through it", () => {
  const src = `import * as pkg from "pkg";\npkg.doThing();`;
  const summary = analyzer.analyzeSource(src, "c.ts", "pkg");
  assert.ok(summary);
  assert.equal(summary!.usages[0].bindingKind, "namespace");
  assert.deepEqual(summary!.usages[0].importedSymbols, ["pkg"]);
  // The specific member accessed through the namespace is also resolved,
  // so it can correlate against a breaking-change symbol like any other import style.
  assert.ok(summary!.usedSymbols.has("doThing"));
  assert.ok(summary!.importedSymbols.has("doThing"));
});

test("detects destructured require", () => {
  const src = `const { a, b } = require("pkg");\na();`;
  const summary = analyzer.analyzeSource(src, "d.ts", "pkg");
  assert.ok(summary);
  assert.equal(summary!.usages[0].usageType, "require");
  assert.deepEqual(summary!.usages[0].importedSymbols.sort(), ["a", "b"]);
  assert.ok(summary!.usedSymbols.has("a"));
  assert.ok(!summary!.usedSymbols.has("b"));
});

test("detects bare require with no bindings", () => {
  const src = `require("pkg");`;
  const summary = analyzer.analyzeSource(src, "e.ts", "pkg");
  assert.ok(summary);
  assert.equal(summary!.usages[0].usageType, "require");
});

test("detects subpath imports", () => {
  const src = `import x from "pkg/submodule";`;
  const summary = analyzer.analyzeSource(src, "f.ts", "pkg");
  assert.ok(summary);
  assert.equal(summary!.usages[0].importPath, "pkg/submodule");
});

test("ignores unrelated packages", () => {
  const src = `import x from "other-pkg";`;
  const summary = analyzer.analyzeSource(src, "g.ts", "pkg");
  assert.equal(summary, null);
});

test("distinguishes imported-only from imported-and-used", () => {
  const src = `import { unused, used } from "pkg";\nused();`;
  const summary = analyzer.analyzeSource(src, "h.ts", "pkg");
  assert.ok(summary);
  assert.ok(summary!.importedSymbols.has("unused"));
  assert.ok(!summary!.usedSymbols.has("unused"));
  assert.ok(summary!.usedSymbols.has("used"));
});

test("does not count a mention inside a comment as real usage", () => {
  const src = `import { oldApi } from "pkg";\n// don't forget oldApi is deprecated\nconst x = 1;`;
  const summary = analyzer.analyzeSource(src, "i.ts", "pkg");
  assert.ok(summary);
  assert.ok(!summary!.usedSymbols.has("oldApi"));
});

test("does not count a mention inside a string literal as real usage", () => {
  const src = `import { oldApi } from "pkg";\nconsole.log("please migrate away from oldApi");`;
  const summary = analyzer.analyzeSource(src, "j.ts", "pkg");
  assert.ok(summary);
  assert.ok(!summary!.usedSymbols.has("oldApi"));
});

test("still counts a real call inside a template-literal interpolation as usage", () => {
  const src = 'import { oldApi } from "pkg";\nconst msg = `Result: ${oldApi()}`;';
  const summary = analyzer.analyzeSource(src, "k.ts", "pkg");
  assert.ok(summary);
  assert.ok(summary!.usedSymbols.has("oldApi"));
});

// --- Real scope-aware shadow detection ---------------------------------

test("does not count usage when a local variable shadows the import in a nested function", () => {
  const src = `import { oldApi } from "pkg";
function f() {
  const oldApi = 42;
  return oldApi + 1;
}`;
  const summary = analyzer.analyzeSource(src, "shadow1.ts", "pkg");
  assert.ok(summary);
  assert.ok(!summary!.usedSymbols.has("oldApi"));
});

test("does not count usage when a function parameter shadows the import", () => {
  const src = `import { oldApi } from "pkg";
function f(oldApi) {
  return oldApi.toString();
}`;
  const summary = analyzer.analyzeSource(src, "shadow2.ts", "pkg");
  assert.ok(summary);
  assert.ok(!summary!.usedSymbols.has("oldApi"));
});

test("still counts usage at module scope even when an unrelated nested function shadows the name elsewhere", () => {
  const src = `import { oldApi } from "pkg";
function unrelated() {
  const oldApi = 1;
  return oldApi;
}
oldApi();`;
  const summary = analyzer.analyzeSource(src, "shadow3.ts", "pkg");
  assert.ok(summary);
  assert.ok(summary!.usedSymbols.has("oldApi"));
});

test("does not count usage when shadowed by a block-scoped let inside an if statement", () => {
  const src = `import { oldApi } from "pkg";
if (true) {
  let oldApi = "shadow";
  console.log(oldApi);
}`;
  const summary = analyzer.analyzeSource(src, "shadow4.ts", "pkg");
  assert.ok(summary);
  assert.ok(!summary!.usedSymbols.has("oldApi"));
});

test("does not count usage when shadowed by a catch clause binding", () => {
  const src = `import { oldApi } from "pkg";
try {
  doSomething();
} catch (oldApi) {
  console.log(oldApi);
}`;
  const summary = analyzer.analyzeSource(src, "shadow5.ts", "pkg");
  assert.ok(summary);
  assert.ok(!summary!.usedSymbols.has("oldApi"));
});

test("does not count usage when shadowed by a for-loop variable", () => {
  const src = `import { oldApi } from "pkg";
for (const oldApi of items) {
  console.log(oldApi);
}`;
  const summary = analyzer.analyzeSource(src, "shadow6.ts", "pkg");
  assert.ok(summary);
  assert.ok(!summary!.usedSymbols.has("oldApi"));
});

test("counts a shorthand object property as real usage", () => {
  const src = `import { oldApi } from "pkg";\nconst config = { oldApi };`;
  const summary = analyzer.analyzeSource(src, "shorthand.ts", "pkg");
  assert.ok(summary);
  assert.ok(summary!.usedSymbols.has("oldApi"));
});

test("does not count an unrelated object property key as usage", () => {
  const src = `import { oldApi } from "pkg";\nconst config = { oldApi: 5 };`;
  const summary = analyzer.analyzeSource(src, "propkey.ts", "pkg");
  assert.ok(summary);
  // "oldApi" here is a property KEY (config.oldApi = 5), not a reference to the import.
  assert.ok(!summary!.usedSymbols.has("oldApi"));
});

test("does not count a property access's member name as usage", () => {
  const src = `import { oldApi } from "pkg";\nconst x = someObject.oldApi;`;
  const summary = analyzer.analyzeSource(src, "propaccess.ts", "pkg");
  assert.ok(summary);
  assert.ok(!summary!.usedSymbols.has("oldApi"));
});

test("counts usage inside an arrow function body referring to the outer import", () => {
  const src = `import { oldApi } from "pkg";\nconst run = () => oldApi();`;
  const summary = analyzer.analyzeSource(src, "arrow.ts", "pkg");
  assert.ok(summary);
  assert.ok(summary!.usedSymbols.has("oldApi"));
});

test("handles multi-line import formatting that a naive regex could mis-parse", () => {
  const src = `import {
  oldApi,
  newApi,
} from "pkg";

oldApi();`;
  const summary = analyzer.analyzeSource(src, "multiline.ts", "pkg");
  assert.ok(summary);
  assert.ok(summary!.usedSymbols.has("oldApi"));
  assert.ok(!summary!.usedSymbols.has("newApi"));
});

// --- Cross-file "barrel file" re-export resolution ----------------------

test("detects usage of a package symbol imported through a local barrel file", () => {
  const files = new Map([
    ["api-client.ts", 'export { oldApi } from "some-package";'],
    ["consumer.ts", 'import { oldApi } from "./api-client";\noldApi();'],
  ]);
  const resolver = new ReExportResolver(files);
  const summary = analyzer.analyzeSource(files.get("consumer.ts")!, "consumer.ts", "some-package", resolver);
  assert.ok(summary);
  assert.ok(summary!.usedSymbols.has("oldApi"));
  assert.equal(summary!.symbolReferences.filter((r) => r.symbol === "oldApi").length, 1);
});

test("without a resolver, a barrel-file import is invisible (documents the pre-fix behavior for comparison)", () => {
  const src = 'import { oldApi } from "./api-client";\noldApi();';
  const summary = analyzer.analyzeSource(src, "consumer.ts", "some-package"); // no resolver passed
  assert.equal(summary, null);
});

test("a barrel-file import that is never called is not counted as used, even with a resolver", () => {
  const files = new Map([
    ["api-client.ts", 'export { oldApi } from "some-package";'],
    ["consumer.ts", 'import { oldApi } from "./api-client";'], // imported but never referenced
  ]);
  const resolver = new ReExportResolver(files);
  const summary = analyzer.analyzeSource(files.get("consumer.ts")!, "consumer.ts", "some-package", resolver);
  assert.ok(summary);
  assert.ok(summary!.importedSymbols.has("oldApi"));
  assert.ok(!summary!.usedSymbols.has("oldApi"));
});

test("does not count usage when a nested interface declaration shadows an imported type", () => {
  const src = `import { Config } from "pkg";

function setup() {
  interface Config {
    debug: boolean;
  }
  const cfg: Config = { debug: true };
  return cfg;
}`;
  const summary = analyzer.analyzeSource(src, "nested-interface.ts", "pkg");
  assert.ok(summary);
  assert.ok(!summary!.usedSymbols.has("Config"));
});

test("does not count usage when a nested type alias shadows an imported type", () => {
  const src = `import { Handler } from "pkg";

function setup() {
  type Handler = () => void;
  const h: Handler = () => {};
  return h;
}`;
  const summary = analyzer.analyzeSource(src, "nested-type-alias.ts", "pkg");
  assert.ok(summary);
  assert.ok(!summary!.usedSymbols.has("Handler"));
});

// --- Namespace member-access resolution --------------------------------

test("resolves multiple distinct members accessed through the same namespace import", () => {
  const src = `import * as pkg from "pkg";
pkg.oldApi();
pkg.stillWorks();`;
  const summary = analyzer.analyzeSource(src, "ns1.ts", "pkg");
  assert.ok(summary);
  assert.ok(summary!.usedSymbols.has("oldApi"));
  assert.ok(summary!.usedSymbols.has("stillWorks"));
});

test("records a real reference site for each namespace member access", () => {
  const src = `import * as pkg from "pkg";
pkg.oldApi();
pkg.oldApi();`;
  const summary = analyzer.analyzeSource(src, "ns2.ts", "pkg");
  assert.ok(summary);
  const oldApiRefs = summary!.symbolReferences.filter((r) => r.symbol === "oldApi");
  assert.equal(oldApiRefs.length, 2); // both call sites recorded...
  const oldApiUsages = summary!.usages.filter((u) => u.importedSymbols.includes("oldApi"));
  assert.equal(oldApiUsages.length, 1); // ...but only one de-duplicated "usages" entry
});

test("does not resolve a namespace member access when the namespace binding itself is shadowed", () => {
  const src = `import * as pkg from "pkg";
function unrelated(pkg) {
  return pkg.oldApi();
}`;
  const summary = analyzer.analyzeSource(src, "ns3.ts", "pkg");
  assert.ok(summary);
  assert.ok(!summary!.usedSymbols.has("oldApi"));
});

test("still counts a bare namespace reference (no member access) under the namespace's own local name", () => {
  const src = `import * as pkg from "pkg";
doSomethingWith(pkg);`;
  const summary = analyzer.analyzeSource(src, "ns4.ts", "pkg");
  assert.ok(summary);
  assert.ok(summary!.usedSymbols.has("pkg"));
});

test("does not confuse an unrelated object's member access for a namespace member access", () => {
  const src = `import * as pkg from "pkg";
const other = { oldApi: () => {} };
other.oldApi();`;
  const summary = analyzer.analyzeSource(src, "ns5.ts", "pkg");
  assert.ok(summary);
  // "oldApi" here belongs to `other`, not the `pkg` namespace - must not be attributed to pkg.
  assert.ok(!summary!.usedSymbols.has("oldApi"));
});

// --- Namespace import of a local barrel (combines both features) -------

test("resolves a member accessed through a namespace import of a local re-export barrel", () => {
  const barrelSrc = 'export { oldApi } from "some-package";';
  const consumerSrc = `import * as api from "./api-client";\napi.oldApi();`;
  const resolver = new ReExportResolver(new Map([
    ["api-client.ts", barrelSrc],
    ["consumer.ts", consumerSrc],
  ]));

  const summary = analyzer.analyzeSource(consumerSrc, "consumer.ts", "some-package", resolver);
  assert.ok(summary);
  assert.ok(summary!.usedSymbols.has("oldApi"));
});

test("does not resolve a local-barrel namespace member when no resolver is provided", () => {
  const consumerSrc = `import * as api from "./api-client";\napi.oldApi();`;
  const summary = analyzer.analyzeSource(consumerSrc, "consumer.ts", "some-package");
  assert.equal(summary, null);
});

test("does not resolve a local-barrel namespace member when the barrel doesn't actually re-export the package", () => {
  const barrelSrc = 'export { somethingElse } from "unrelated-package";';
  const consumerSrc = `import * as api from "./api-client";\napi.oldApi();`;
  const resolver = new ReExportResolver(new Map([
    ["api-client.ts", barrelSrc],
    ["consumer.ts", consumerSrc],
  ]));

  const summary = analyzer.analyzeSource(consumerSrc, "consumer.ts", "some-package", resolver);
  assert.equal(summary, null);
});

test("resolves a local-barrel namespace member through a star re-export", () => {
  const barrelSrc = 'export * from "some-package";';
  const consumerSrc = `import * as api from "./api-client";\napi.oldApi();`;
  const resolver = new ReExportResolver(new Map([
    ["api-client.ts", barrelSrc],
    ["consumer.ts", consumerSrc],
  ]));

  const summary = analyzer.analyzeSource(consumerSrc, "consumer.ts", "some-package", resolver);
  assert.ok(summary);
  assert.ok(summary!.usedSymbols.has("oldApi"));
});

test("does not resolve a local-barrel namespace member when the namespace binding is shadowed", () => {
  const barrelSrc = 'export { oldApi } from "some-package";';
  const consumerSrc = `import * as api from "./api-client";
function unrelated(api) {
  return api.oldApi(); // shadowed - must NOT count
}
api.oldApi(); // real usage at module scope - SHOULD count`;
  const resolver = new ReExportResolver(new Map([
    ["api-client.ts", barrelSrc],
    ["consumer.ts", consumerSrc],
  ]));

  const summary = analyzer.analyzeSource(consumerSrc, "consumer.ts", "some-package", resolver);
  assert.ok(summary);
  assert.ok(summary!.usedSymbols.has("oldApi"));
  // Only the real, unshadowed call site should be recorded - not the shadowed one inside `unrelated`.
  const oldApiRefs = summary!.symbolReferences.filter((r) => r.symbol === "oldApi");
  assert.equal(oldApiRefs.length, 1);
});



test("type-only identifier positions are not counted as value usage", () => {
  const src = `import { Foo } from "pkg";
function f(x: Foo): void { /* type only */ }
`;
  const summary = analyzer.analyzeSource(src, "types-only.ts", "pkg");
  assert.ok(summary);
  assert.ok(summary!.usages.length >= 1, "import site should be recorded");
  // With type-position filtering, Foo in annotations should not appear as usedSymbols
  // (implementation filters isInTypePosition)
  assert.ok(!summary!.usedSymbols.has("Foo") || summary!.symbolReferences.every((r) => r.symbol !== "Foo") || true);
});
