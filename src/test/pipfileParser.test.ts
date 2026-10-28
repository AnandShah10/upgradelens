import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePipfile, parsePipfileLock } from "../package/pipfileParser";

test("parsePipfile reads packages and dev-packages", () => {
  const doc = {
    packages: {
      requests: "==2.31.0",
      flask: { version: ">=2.0" },
    },
    "dev-packages": {
      pytest: "*",
    },
  };
  const deps = parsePipfile(doc);
  assert.equal(deps.length, 3);
  assert.ok(deps.some((d) => d.name === "requests" && d.declaredRange === "==2.31.0" && d.kind === "production"));
  assert.ok(deps.some((d) => d.name === "flask" && d.declaredRange === ">=2.0"));
  assert.ok(deps.some((d) => d.name === "pytest" && d.kind === "development"));
});

test("parsePipfileLock strips == from versions", () => {
  const lock = JSON.stringify({
    default: { requests: { version: "==2.31.0" } },
    develop: { pytest: { version: "==7.4.0" } },
  });
  const resolved = parsePipfileLock(lock);
  assert.equal(resolved["requests"], "2.31.0");
  assert.equal(resolved["pytest"], "7.4.0");
});
