import assert from "node:assert/strict";
import { test } from "node:test";
import { maskPythonCommentsAndStrings } from "../analysis/pythonCommentStringMasker";

test("masks a line comment but preserves the newline", () => {
  const src = "x = 1  # mentions old_api here\ny = 2";
  const masked = maskPythonCommentsAndStrings(src);
  assert.ok(!masked.includes("old_api"));
  assert.equal(masked.split("\n").length, 2);
});

test("masks single- and double-quoted string contents", () => {
  const src = `a = 'old_api is deprecated'\nb = "old_api is deprecated"`;
  const masked = maskPythonCommentsAndStrings(src);
  assert.ok(!masked.includes("old_api"));
});

test("masks a triple-quoted docstring, preserving internal newlines", () => {
  const src = '"""\nThis module mentions old_api.\n"""\nx = 1';
  const masked = maskPythonCommentsAndStrings(src);
  assert.ok(!masked.includes("old_api"));
  assert.equal(masked.split("\n").length, 4);
});

test("masks a single-quoted triple-quoted docstring too", () => {
  const src = "'''\nmentions old_api\n'''\nx = 1";
  const masked = maskPythonCommentsAndStrings(src);
  assert.ok(!masked.includes("old_api"));
});

test("handles escaped quotes inside strings without ending the string early", () => {
  const src = String.raw`s = "he said \"old_api\" is old"` + "\nold_api()";
  const masked = maskPythonCommentsAndStrings(src);
  const occurrences = (masked.match(/old_api/g) ?? []).length;
  assert.equal(occurrences, 1);
});

test("keeps a real function call inside an f-string interpolation live", () => {
  const src = 'msg = f"Result: {old_api()}"';
  const masked = maskPythonCommentsAndStrings(src);
  assert.ok(masked.includes("old_api"));
});

test("masks literal text before and after an f-string interpolation", () => {
  const src = 'msg = f"old_api says: {old_api()} - old_api done"';
  const masked = maskPythonCommentsAndStrings(src);
  const occurrences = (masked.match(/old_api/g) ?? []).length;
  assert.equal(occurrences, 1);
});

test("does not treat braces in a non-f-string as interpolation", () => {
  const src = 'msg = "literal braces: {old_api}"';
  const masked = maskPythonCommentsAndStrings(src);
  assert.ok(!masked.includes("old_api"));
});

test("recognizes doubled braces as an escaped literal brace in an f-string", () => {
  const src = 'msg = f"escaped {{old_api}} then {old_api()}"';
  const masked = maskPythonCommentsAndStrings(src);
  const occurrences = (masked.match(/old_api/g) ?? []).length;
  assert.equal(occurrences, 1);
});

test("masks raw and byte string prefixes as fully opaque", () => {
  const src = 'a = r"old_api raw"\nb = b"old_api bytes"\nc = rb"old_api rawbytes"';
  const masked = maskPythonCommentsAndStrings(src);
  assert.ok(!masked.includes("old_api"));
});

test("preserves overall string length so line/column offsets stay valid", () => {
  const src = 'a = "hello"  # comment\nold_api()';
  const masked = maskPythonCommentsAndStrings(src);
  assert.equal(masked.length, src.length);
});

test("leaves ordinary code completely untouched", () => {
  const src = "def foo(a, b):\n    return a + b";
  assert.equal(maskPythonCommentsAndStrings(src), src);
});
