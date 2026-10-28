import assert from "node:assert/strict";
import { test } from "node:test";
import { extractExactPin, parseRequirementString } from "../package/pythonRequirementParser";
import { parseRequirementsTxt } from "../package/requirementsTxtParser";

test("parses a bare package name with no version constraint", () => {
  assert.deepEqual(parseRequirementString("requests"), { name: "requests", declaredRange: "*" });
});

test("parses an exact pin", () => {
  assert.deepEqual(parseRequirementString("requests==2.31.0"), { name: "requests", declaredRange: "==2.31.0" });
});

test("parses a comparison range", () => {
  assert.deepEqual(parseRequirementString("requests>=2.28,<3.0"), { name: "requests", declaredRange: ">=2.28,<3.0" });
});

test("strips extras markers", () => {
  assert.deepEqual(parseRequirementString("requests[security]>=2.28"), { name: "requests", declaredRange: ">=2.28" });
});

test("strips environment markers", () => {
  assert.deepEqual(parseRequirementString('requests>=2.28; python_version >= "3.8"'), { name: "requests", declaredRange: ">=2.28" });
});

test("skips direct URL/VCS references rather than misreporting a range", () => {
  assert.equal(parseRequirementString("requests @ git+https://github.com/psf/requests.git"), null);
});

test("returns null for an empty or whitespace-only line", () => {
  assert.equal(parseRequirementString(""), null);
  assert.equal(parseRequirementString("   "), null);
});

test("extractExactPin finds a plain == pin", () => {
  assert.equal(extractExactPin("==2.31.0"), "2.31.0");
});

test("extractExactPin returns undefined for a non-exact range", () => {
  assert.equal(extractExactPin(">=2.28,<3.0"), undefined);
  assert.equal(extractExactPin("*"), undefined);
});

test("parseRequirementsTxt parses multiple lines, skipping comments and pip options", () => {
  const content = `# top-level comment
requests==2.31.0
numpy>=1.24  # inline comment
-r other-requirements.txt
--index-url https://example.com/simple
-e .
flask
`;
  const entries = parseRequirementsTxt(content);
  const names = entries.map((e) => e.name);
  assert.deepEqual(names.sort(), ["flask", "numpy", "requests"]);

  const requestsEntry = entries.find((e) => e.name === "requests");
  assert.equal(requestsEntry?.exactVersion, "2.31.0");

  const numpyEntry = entries.find((e) => e.name === "numpy");
  assert.equal(numpyEntry?.exactVersion, undefined);
  assert.equal(numpyEntry?.declaredRange, ">=1.24");

  const flaskEntry = entries.find((e) => e.name === "flask");
  assert.equal(flaskEntry?.declaredRange, "*");
});

test("parseRequirementsTxt returns an empty array for an empty file", () => {
  assert.deepEqual(parseRequirementsTxt(""), []);
});
