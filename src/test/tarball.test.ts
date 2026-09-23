import assert from "node:assert/strict";
import { test } from "node:test";
import * as zlib from "node:zlib";
import { extractTarball, parseTar, stripPackagePrefix } from "../utils/tarball";
import { buildFakeTarball, buildPaxEntry } from "./testUtils/buildTarball";

test("parseTar reads back a single file entry with correct name and content", () => {
  const gz = buildFakeTarball([{ name: "package/index.d.ts", content: "export function foo(): void;" }]);
  const entries = parseTar(zlib.gunzipSync(gz));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "package/index.d.ts");
  assert.equal(entries[0].content.toString("utf8"), "export function foo(): void;");
});

test("parseTar reads back multiple entries in order", () => {
  const gz = buildFakeTarball([
    { name: "package/package.json", content: '{"name":"demo-package"}' },
    { name: "package/index.d.ts", content: "export const x: number;" },
  ]);
  const entries = parseTar(zlib.gunzipSync(gz));
  assert.equal(entries.length, 2);
  assert.equal(entries[0].name, "package/package.json");
  assert.equal(entries[1].name, "package/index.d.ts");
});

test("parseTar handles content that isn't a multiple of 512 bytes", () => {
  const longContent = "x".repeat(1000);
  const gz = buildFakeTarball([{ name: "package/big.d.ts", content: longContent }]);
  const entries = parseTar(zlib.gunzipSync(gz));
  assert.equal(entries[0].content.length, 1000);
  assert.equal(entries[0].content.toString("utf8"), longContent);
});

test("extractTarball gunzips then parses correctly", () => {
  const gzipped = buildFakeTarball([{ name: "package/index.d.ts", content: "export class Widget {}" }]);
  const entries = extractTarball(gzipped);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].content.toString("utf8"), "export class Widget {}");
});

test("stripPackagePrefix removes the leading package/ directory", () => {
  assert.equal(stripPackagePrefix("package/index.d.ts"), "index.d.ts");
  assert.equal(stripPackagePrefix("package/dist/index.d.ts"), "dist/index.d.ts");
  assert.equal(stripPackagePrefix("no-prefix.d.ts"), "no-prefix.d.ts");
});

test("parseTar resolves a long file name via a PAX extended header ('path' override)", () => {
  const longName = "package/" + "very-deeply/".repeat(10) + "nested-declarations.d.ts";
  const paxBlock = buildPaxEntry(longName, Buffer.from("export const deep: boolean;", "utf8"));
  const end = Buffer.alloc(1024);
  const entries = parseTar(Buffer.concat([paxBlock, end]));

  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, longName);
  assert.equal(entries[0].content.toString("utf8"), "export const deep: boolean;");
});

test("parseTar handles a mix of PAX-prefixed and ordinary entries in the same archive", () => {
  const longName = "package/" + "x/".repeat(20) + "deep.d.ts";
  const paxBlock = buildPaxEntry(longName, Buffer.from("export type Deep = 1;", "utf8"));
  const ordinary = buildFakeTarball([{ name: "package/index.d.ts", content: "export const shallow: number;" }]);
  // buildFakeTarball already gzips + terminates; unwrap it back to raw tar bytes to concatenate.
  const ordinaryRaw = zlib.gunzipSync(ordinary);
  const combined = Buffer.concat([paxBlock, ordinaryRaw]);

  const entries = parseTar(combined);
  const names = entries.map((e) => e.name);
  assert.ok(names.includes(longName));
  assert.ok(names.includes("package/index.d.ts"));
});

