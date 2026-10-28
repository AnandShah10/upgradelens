import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBunLockb } from "../package/BunPackageManager";

test("parseBunLockb extracts name@version tokens from a synthetic buffer", () => {
  // Simulate a binary-ish buffer with embedded ASCII coordinates
  const payload = Buffer.from(
    "bun-lockfile-format-v0\x00\x00lodash@4.17.21\x00react@18.2.0\x00@scope/pkg@1.0.0-beta.1\x00junk",
    "binary"
  );
  const resolved = parseBunLockb(payload);
  assert.equal(resolved["lodash"], "4.17.21");
  assert.equal(resolved["react"], "18.2.0");
  assert.equal(resolved["@scope/pkg"], "1.0.0-beta.1");
});

test("parseBunLockb ignores non-semver-looking noise", () => {
  const payload = Buffer.from("random@notversion foo@1 bar@2.3.4.5.6", "utf8");
  const resolved = parseBunLockb(payload);
  // bar@2.3.4 may match (strict is major.minor.patch optional pre); 2.3.4.5.6 might still match first 2.3.4
  assert.ok(!("random" in resolved));
  assert.ok(!("foo" in resolved));
});
