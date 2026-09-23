import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePnpmLock } from "../package/PnpmPackageManager";

test("parses packages: entries with a leading slash and version in the key", () => {
  const lock = `
lockfileVersion: '6.0'
packages:
  /lodash@4.17.21:
    resolution: {integrity: sha512-abc}
  /axios@1.6.8:
    resolution: {integrity: sha512-def}
`;
  const versions = parsePnpmLock(lock);
  assert.equal(versions["lodash"], "4.17.21");
  assert.equal(versions["axios"], "1.6.8");
});

test("parses scoped package names in packages: keys", () => {
  const lock = `
packages:
  /@babel/core@7.24.0:
    resolution: {integrity: sha512-abc}
`;
  const versions = parsePnpmLock(lock);
  assert.equal(versions["@babel/core"], "7.24.0");
});

test("strips peer-dependency suffixes in parentheses", () => {
  const lock = `
packages:
  /react-dom@18.2.0(react@18.2.0):
    resolution: {integrity: sha512-abc}
`;
  const versions = parsePnpmLock(lock);
  assert.equal(versions["react-dom"], "18.2.0");
});

test("falls back to importers: entries when packages: version differs from key", () => {
  const lock = `
importers:
  .:
    dependencies:
      express:
        version: 4.19.2
    devDependencies:
      typescript:
        version: 5.4.5
`;
  const versions = parsePnpmLock(lock);
  assert.equal(versions["express"], "4.19.2");
  assert.equal(versions["typescript"], "5.4.5");
});

test("returns an empty map for malformed YAML rather than throwing", () => {
  assert.deepEqual(parsePnpmLock("not: valid: yaml: : ::"), {});
});

test("returns an empty map for an empty document", () => {
  assert.deepEqual(parsePnpmLock(""), {});
});
