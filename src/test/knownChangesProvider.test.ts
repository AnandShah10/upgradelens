import assert from "node:assert/strict";
import { test } from "node:test";
import { KnownChangesProvider } from "../changelog/KnownChangesProvider";

const provider = new KnownChangesProvider();

test("returns known breaking changes for a major bump that crosses the effective version", async () => {
  const changes = await provider.getChanges("axios", "1.7.2", "2.0.0");
  assert.ok(changes.some((c) => c.symbol === "oldRequest"));
});

test("returns nothing when the upgrade doesn't cross any known breaking major", async () => {
  const changes = await provider.getChanges("axios", "1.6.0", "1.7.2");
  assert.equal(changes.length, 0);
});

test("returns nothing for a package with no curated entries", async () => {
  const changes = await provider.getChanges("some-random-package", "1.0.0", "9.0.0");
  assert.equal(changes.length, 0);
});

test("react-router-dom v5 -> v6 flags the Switch removal", async () => {
  const changes = await provider.getChanges("react-router-dom", "5.3.4", "6.22.3");
  assert.ok(changes.some((c) => c.symbol === "Switch"));
});

test("react-router-dom v6 -> v6 patch bump flags nothing new", async () => {
  const changes = await provider.getChanges("react-router-dom", "6.20.0", "6.22.3");
  assert.equal(changes.length, 0);
});

test("react-dom v17 -> v18 flags the render/unmountComponentAtNode deprecations", async () => {
  const changes = await provider.getChanges("react-dom", "17.0.2", "18.2.0");
  assert.ok(changes.some((c) => c.symbol === "render"));
  assert.ok(changes.some((c) => c.symbol === "unmountComponentAtNode"));
});

test("webpack v4 -> v5 flags the removed automatic Node polyfills", async () => {
  const changes = await provider.getChanges("webpack", "4.46.0", "5.90.0");
  assert.ok(changes.some((c) => c.summary.includes("polyfill")));
});

test("eslint v8 -> v9 flags the flat-config default change", async () => {
  const changes = await provider.getChanges("eslint", "8.57.0", "9.0.0");
  assert.ok(changes.some((c) => c.summary.includes("flat config")));
});

test("node-fetch v2 -> v3 flags ESM-only breakage", async () => {
  const changes = await provider.getChanges("node-fetch", "2.7.0", "3.3.2");
  assert.ok(changes.some((c) => c.summary.includes("ESM-only")));
});

test("mongoose v5 -> v7 flags both the v6 and v7 callback removals", async () => {
  const changes = await provider.getChanges("mongoose", "5.13.0", "7.6.0");
  assert.ok(changes.filter((c) => c.summary.toLowerCase().includes("callback")).length >= 2);
});

test("django v3 -> v4 flags the removed url() shortcut", async () => {
  const changes = await provider.getChanges("django", "3.2.0", "4.0.0");
  assert.ok(changes.some((c) => c.symbol === "url"));
});

test("flask v1 -> v2 flags the removed before_first_request decorator", async () => {
  const changes = await provider.getChanges("flask", "1.1.0", "2.2.0");
  assert.ok(changes.some((c) => c.symbol === "before_first_request"));
});

test("numpy v1 -> v2 flags the removed deprecated type aliases", async () => {
  const changes = await provider.getChanges("numpy", "1.26.0", "2.0.0");
  assert.ok(changes.some((c) => c.summary.includes("np.float")));
});

test("pandas v1 -> v2 flags the removed DataFrame.append", async () => {
  const changes = await provider.getChanges("pandas", "1.5.0", "2.0.0");
  assert.ok(changes.some((c) => c.symbol === "append"));
});
