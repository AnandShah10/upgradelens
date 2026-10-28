import assert from "node:assert/strict";
import { test } from "node:test";
import { isWebviewMessage } from "../ui/webviewProtocol";

test("accepts a well-formed open-file message", () => {
  assert.equal(isWebviewMessage({ type: "open-file", filePath: "a.ts", line: 1, column: 1 }), true);
});

test("rejects open-file with missing fields", () => {
  assert.equal(isWebviewMessage({ type: "open-file", filePath: "a.ts" }), false);
});

test("rejects open-file with wrong field types", () => {
  assert.equal(isWebviewMessage({ type: "open-file", filePath: "a.ts", line: "1", column: 1 }), false);
});

test("accepts copy-checklist with a string payload", () => {
  assert.equal(isWebviewMessage({ type: "copy-checklist", text: "- do the thing" }), true);
});

test("rejects copy-checklist with a non-string payload", () => {
  assert.equal(isWebviewMessage({ type: "copy-checklist", text: 42 }), false);
});

test("accepts bare refresh and export-report messages", () => {
  assert.equal(isWebviewMessage({ type: "refresh" }), true);
  assert.equal(isWebviewMessage({ type: "export-report" }), true);
});

test("rejects unknown message types", () => {
  assert.equal(isWebviewMessage({ type: "delete-everything" }), false);
});

test("rejects non-object payloads", () => {
  assert.equal(isWebviewMessage("open-file"), false);
  assert.equal(isWebviewMessage(null), false);
  assert.equal(isWebviewMessage(undefined), false);
  assert.equal(isWebviewMessage(42), false);
});
