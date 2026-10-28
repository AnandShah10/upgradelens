import assert from "node:assert/strict";
import { test } from "node:test";
import { satisfiesRange } from "../analysis/SemverUtil";

test("caret range: same major, any minor/patch >= base", () => {
  assert.equal(satisfiesRange("18.2.0", "^18.0.0"), true);
  assert.equal(satisfiesRange("18.0.0", "^18.0.0"), true);
  assert.equal(satisfiesRange("19.0.0", "^18.0.0"), false);
  assert.equal(satisfiesRange("17.9.9", "^18.0.0"), false);
});

test("caret range on 0.x locks the minor", () => {
  assert.equal(satisfiesRange("0.4.3", "^0.4.0"), true);
  assert.equal(satisfiesRange("0.5.0", "^0.4.0"), false);
});

test("caret range on 0.0.x locks the patch", () => {
  assert.equal(satisfiesRange("0.0.3", "^0.0.3"), true);
  assert.equal(satisfiesRange("0.0.4", "^0.0.3"), false);
});

test("tilde range locks the minor", () => {
  assert.equal(satisfiesRange("4.2.9", "~4.2.0"), true);
  assert.equal(satisfiesRange("4.3.0", "~4.2.0"), false);
});

test("plain comparators", () => {
  assert.equal(satisfiesRange("20.0.0", ">=18.0.0"), true);
  assert.equal(satisfiesRange("16.0.0", ">=18.0.0"), false);
  assert.equal(satisfiesRange("18.0.0", ">18.0.0"), false);
});

test("space-separated AND range", () => {
  assert.equal(satisfiesRange("17.0.0", ">=16.8.0 <19.0.0"), true);
  assert.equal(satisfiesRange("19.0.0", ">=16.8.0 <19.0.0"), false);
});

test("OR range across major versions", () => {
  assert.equal(satisfiesRange("17.0.2", "^16.8.0 || ^17.0.0 || ^18.0.0"), true);
  assert.equal(satisfiesRange("15.0.0", "^16.8.0 || ^17.0.0 || ^18.0.0"), false);
});

test("wildcard / bare major ranges", () => {
  assert.equal(satisfiesRange("18.4.2", "18.x"), true);
  assert.equal(satisfiesRange("19.0.0", "18.x"), false);
  assert.equal(satisfiesRange("18.4.2", "18"), true);
});

test("wildcard star always satisfies", () => {
  assert.equal(satisfiesRange("1.2.3", "*"), true);
});

test("returns null for an unparseable target version rather than a false negative", () => {
  assert.equal(satisfiesRange("not-a-version", "^1.0.0"), null);
});
