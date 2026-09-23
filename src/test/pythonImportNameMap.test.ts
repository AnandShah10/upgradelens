import assert from "node:assert/strict";
import { test } from "node:test";
import { candidateImportNames } from "../analysis/pythonImportNameMap";

test("returns the curated import name for a well-known mismatch (Pillow -> PIL)", () => {
  assert.ok(candidateImportNames("Pillow").includes("PIL"));
});

test("returns the curated import name for beautifulsoup4 -> bs4", () => {
  assert.ok(candidateImportNames("beautifulsoup4").includes("bs4"));
});

test("is case-insensitive when matching the curated table", () => {
  assert.ok(candidateImportNames("PILLOW").includes("PIL"));
  assert.ok(candidateImportNames("pillow").includes("PIL"));
});

test("falls back to a normalized form for an ordinary package with no exception", () => {
  const candidates = candidateImportNames("requests");
  assert.ok(candidates.includes("requests"));
});

test("normalizes hyphens to underscores for the fallback form", () => {
  const candidates = candidateImportNames("some-random-package");
  assert.ok(candidates.includes("some_random_package"));
});

test("returns multiple candidates for a package importable under more than one name (attrs)", () => {
  const candidates = candidateImportNames("attrs");
  assert.ok(candidates.includes("attr"));
  assert.ok(candidates.includes("attrs"));
});

test("dotted curated import names are preserved as-is (protobuf -> google.protobuf)", () => {
  assert.ok(candidateImportNames("protobuf").includes("google.protobuf"));
});
