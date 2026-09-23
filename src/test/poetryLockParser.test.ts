import assert from "node:assert/strict";
import { test } from "node:test";
import * as toml from "smol-toml";
import { parsePoetryLock } from "../package/poetryLockParser";

test("parses resolved versions from a poetry.lock document", () => {
  const doc = toml.parse(`
[[package]]
name = "requests"
version = "2.31.0"

[[package]]
name = "numpy"
version = "1.24.0"
`);
  const versions = parsePoetryLock(doc);
  assert.equal(versions["requests"], "2.31.0");
  assert.equal(versions["numpy"], "1.24.0");
});

test("returns an empty map when there's no package array", () => {
  assert.deepEqual(parsePoetryLock(toml.parse('metadata = { lock-version = "2.0" }')), {});
});

test("returns an empty map for a non-object input", () => {
  assert.deepEqual(parsePoetryLock(null), {});
  assert.deepEqual(parsePoetryLock(undefined), {});
});

test("first entry wins if a name somehow appears twice", () => {
  const doc = toml.parse(`
[[package]]
name = "requests"
version = "2.31.0"

[[package]]
name = "requests"
version = "2.30.0"
`);
  const versions = parsePoetryLock(doc);
  assert.equal(versions["requests"], "2.31.0");
});
