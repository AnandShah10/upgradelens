import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyChange, isValidVersion, stripRangePrefix } from "../analysis/SemverUtil";

test("classifyChange detects major bumps", () => {
  assert.equal(classifyChange("2.4.0", "3.0.0"), "major");
});

test("classifyChange detects minor bumps", () => {
  assert.equal(classifyChange("2.4.0", "2.5.0"), "minor");
});

test("classifyChange detects patch bumps", () => {
  assert.equal(classifyChange("2.4.0", "2.4.1"), "patch");
});

test("classifyChange returns unknown for invalid input", () => {
  assert.equal(classifyChange("not-a-version", "2.4.1"), "unknown");
});

test("stripRangePrefix removes common range operators", () => {
  assert.equal(stripRangePrefix("^4.2.1"), "4.2.1");
  assert.equal(stripRangePrefix("~4.2.1"), "4.2.1");
  assert.equal(stripRangePrefix(">=4.2.1"), "4.2.1");
  assert.equal(stripRangePrefix("4.2.1"), "4.2.1");
});

test("isValidVersion accepts valid semver and rejects garbage", () => {
  assert.equal(isValidVersion("1.2.3"), true);
  assert.equal(isValidVersion("^1.2.3"), true);
  assert.equal(isValidVersion("latest"), false);
  assert.equal(isValidVersion(""), false);
});
