import assert from "node:assert/strict";
import { test } from "node:test";
import * as ts from "typescript";
import { findReExports, ReExportResolver } from "../analysis/ReExportResolver";

function parse(text: string): ts.SourceFile {
  return ts.createSourceFile("f.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

// --- findReExports -----------------------------------------------------

test("findReExports detects a named re-export, including aliasing", () => {
  const sf = parse('export { oldApi, legacyClient as client } from "some-package";');
  const entries = findReExports(sf);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "named");
  const named = entries[0] as { kind: "named"; moduleSpecifier: string; exports: { exportedName: string; originalName: string }[] };
  assert.equal(named.moduleSpecifier, "some-package");
  assert.deepEqual(
    named.exports.sort((a, b) => a.exportedName.localeCompare(b.exportedName)),
    [
      { exportedName: "client", originalName: "legacyClient" },
      { exportedName: "oldApi", originalName: "oldApi" },
    ]
  );
});

test("findReExports detects a star re-export", () => {
  const sf = parse('export * from "./inner";');
  const entries = findReExports(sf);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "star");
  assert.equal(entries[0].moduleSpecifier, "./inner");
});

test("findReExports ignores a namespace re-export (export * as ns from)", () => {
  const sf = parse('export * as ns from "some-package";');
  const entries = findReExports(sf);
  assert.equal(entries.length, 0);
});

test("findReExports ignores a plain local export (no 'from' clause)", () => {
  const sf = parse("export const x = 1;\nexport { x as y };");
  const entries = findReExports(sf);
  assert.equal(entries.length, 0);
});

test("findReExports returns multiple entries for multiple re-export statements", () => {
  const sf = parse('export { a } from "pkg-a";\nexport * from "./pkg-b-barrel";');
  const entries = findReExports(sf);
  assert.equal(entries.length, 2);
});

// --- ReExportResolver ----------------------------------------------------

test("resolves a direct one-hop re-export", () => {
  const files = new Map([
    ["barrel.ts", 'export { oldApi } from "some-package";'],
    ["consumer.ts", 'import { oldApi } from "./barrel";'],
  ]);
  const resolver = new ReExportResolver(files);
  const result = resolver.resolveToPackage("consumer.ts", "./barrel", "oldApi", "some-package");
  assert.equal(result, "oldApi");
});

test("resolves aliasing through a one-hop re-export", () => {
  const files = new Map([
    ["barrel.ts", 'export { legacyClient as client } from "some-package";'],
    ["consumer.ts", 'import { client } from "./barrel";'],
  ]);
  const resolver = new ReExportResolver(files);
  // Consumer's local import calls it "client"; barrel maps "client" -> "legacyClient" on the package side.
  const result = resolver.resolveToPackage("consumer.ts", "./barrel", "client", "some-package");
  assert.equal(result, "legacyClient");
});

test("resolves a two-hop transitive re-export chain", () => {
  const files = new Map([
    ["deep-barrel.ts", 'export { oldApi } from "some-package";'],
    ["mid-barrel.ts", 'export { oldApi } from "./deep-barrel";'],
    ["consumer.ts", 'import { oldApi } from "./mid-barrel";'],
  ]);
  const resolver = new ReExportResolver(files);
  const result = resolver.resolveToPackage("consumer.ts", "./mid-barrel", "oldApi", "some-package");
  assert.equal(result, "oldApi");
});

test("resolves through a star re-export", () => {
  const files = new Map([
    ["barrel.ts", 'export * from "some-package";'],
    ["consumer.ts", 'import { oldApi } from "./barrel";'],
  ]);
  const resolver = new ReExportResolver(files);
  const result = resolver.resolveToPackage("consumer.ts", "./barrel", "oldApi", "some-package");
  assert.equal(result, "oldApi");
});

test("resolves relative paths correctly across subdirectories", () => {
  const files = new Map([
    ["src/lib/barrel.ts", 'export { oldApi } from "some-package";'],
    ["src/consumer.ts", 'import { oldApi } from "./lib/barrel";'],
  ]);
  const resolver = new ReExportResolver(files);
  const result = resolver.resolveToPackage("src/consumer.ts", "./lib/barrel", "oldApi", "some-package");
  assert.equal(result, "oldApi");
});

test("resolves a barrel that is a directory with an index file", () => {
  const files = new Map([
    ["lib/index.ts", 'export { oldApi } from "some-package";'],
    ["consumer.ts", 'import { oldApi } from "./lib";'],
  ]);
  const resolver = new ReExportResolver(files);
  const result = resolver.resolveToPackage("consumer.ts", "./lib", "oldApi", "some-package");
  assert.equal(result, "oldApi");
});

test("returns null when the chain re-exports from a different, unrelated package", () => {
  const files = new Map([
    ["barrel.ts", 'export { oldApi } from "other-package";'],
    ["consumer.ts", 'import { oldApi } from "./barrel";'],
  ]);
  const resolver = new ReExportResolver(files);
  const result = resolver.resolveToPackage("consumer.ts", "./barrel", "oldApi", "some-package");
  assert.equal(result, null);
});

test("returns null when the local file can't be resolved (not among scanned files)", () => {
  const files = new Map([["consumer.ts", 'import { oldApi } from "./missing-barrel";']]);
  const resolver = new ReExportResolver(files);
  const result = resolver.resolveToPackage("consumer.ts", "./missing-barrel", "oldApi", "some-package");
  assert.equal(result, null);
});

test("terminates instead of looping forever on a circular re-export chain", () => {
  const files = new Map([
    ["a.ts", 'export { thing } from "./b";'],
    ["b.ts", 'export { thing } from "./a";'], // circular: a -> b -> a -> ...
  ]);
  const resolver = new ReExportResolver(files);
  const result = resolver.resolveToPackage("consumer.ts", "./a", "thing", "some-package");
  assert.equal(result, null); // never reaches the package, and must not hang
});

test("respects the max chain depth rather than resolving an arbitrarily long chain", () => {
  const files = new Map<string, string>();
  const depth = 10; // deeper than the resolver's internal cap
  for (let i = 0; i < depth; i++) {
    const next = i === depth - 1 ? 'export { thing } from "some-package";' : `export { thing } from "./hop${i + 1}";`;
    files.set(`hop${i}.ts`, next);
  }
  const resolver = new ReExportResolver(files);
  const result = resolver.resolveToPackage("consumer.ts", "./hop0", "thing", "some-package");
  assert.equal(result, null); // chain is longer than the resolver will follow
});

test("a short chain within the depth limit still resolves", () => {
  const files = new Map([
    ["hop0.ts", 'export { thing } from "./hop1";'],
    ["hop1.ts", 'export { thing } from "./hop2";'],
    ["hop2.ts", 'export { thing } from "some-package";'],
  ]);
  const resolver = new ReExportResolver(files);
  const result = resolver.resolveToPackage("consumer.ts", "./hop0", "thing", "some-package");
  assert.equal(result, "thing");
});
