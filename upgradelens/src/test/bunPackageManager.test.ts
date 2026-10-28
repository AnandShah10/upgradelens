import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBunLock } from "../package/BunPackageManager";

test("parses packages with an array-form resolution string", () => {
  const lock = `{
    "lockfileVersion": 0,
    "packages": {
      "lodash": ["lodash@4.17.21", "", {}, "sha512-abc"],
      "axios": ["axios@1.6.8", "", {}, "sha512-def"]
    }
  }`;
  const versions = parseBunLock(lock);
  assert.equal(versions["lodash"], "4.17.21");
  assert.equal(versions["axios"], "1.6.8");
});

test("parses scoped package names", () => {
  const lock = `{
    "packages": {
      "@babel/core": ["@babel/core@7.24.0", "", {}, "sha512-abc"]
    }
  }`;
  const versions = parseBunLock(lock);
  assert.equal(versions["@babel/core"], "7.24.0");
});

test("parses an object-form entry with an explicit version field", () => {
  const lock = `{
    "packages": {
      "react": { "version": "18.2.0" }
    }
  }`;
  const versions = parseBunLock(lock);
  assert.equal(versions["react"], "18.2.0");
});

test("strips // line comments and block comments before parsing (JSONC)", () => {
  const lock = `{
    // this is a comment
    "packages": {
      /* block comment */
      "express": ["express@4.19.2", "", {}, "sha512-abc"]
    }
  }`;
  const versions = parseBunLock(lock);
  assert.equal(versions["express"], "4.19.2");
});

test("does not strip characters that look like comment markers inside string values", () => {
  const lock = `{
    "packages": {
      "weird-pkg": ["weird-pkg@1.0.0", "https://example.com//not-a-comment", {}, "sha512-abc"]
    }
  }`;
  const versions = parseBunLock(lock);
  assert.equal(versions["weird-pkg"], "1.0.0");
});

test("returns an empty map for malformed JSON rather than throwing", () => {
  assert.deepEqual(parseBunLock("{ not json"), {});
});
