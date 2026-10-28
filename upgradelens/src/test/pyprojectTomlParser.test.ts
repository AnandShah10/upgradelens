import assert from "node:assert/strict";
import { test } from "node:test";
import * as toml from "smol-toml";
import { parsePyprojectDependencies } from "../package/pyprojectTomlParser";

test("parses PEP 621 native [project] dependencies", () => {
  const doc = toml.parse(`
[project]
name = "myapp"
dependencies = [
  "requests>=2.28",
  "numpy",
]
`);
  const deps = parsePyprojectDependencies(doc);
  assert.equal(deps.length, 2);
  const requests = deps.find((d) => d.name === "requests");
  assert.equal(requests?.declaredRange, ">=2.28");
  assert.equal(requests?.kind, "dependencies");
});

test("parses PEP 621 optional-dependencies groups as optionalDependencies", () => {
  const doc = toml.parse(`
[project]
name = "myapp"
dependencies = []

[project.optional-dependencies]
test = ["pytest>=7.0"]
`);
  const deps = parsePyprojectDependencies(doc);
  const pytest = deps.find((d) => d.name === "pytest");
  assert.ok(pytest);
  assert.equal(pytest?.kind, "optionalDependencies");
});

test("parses Poetry [tool.poetry.dependencies] with bare string versions", () => {
  const doc = toml.parse(`
[tool.poetry.dependencies]
python = "^3.10"
requests = "^2.28"
`);
  const deps = parsePyprojectDependencies(doc);
  assert.equal(deps.length, 1); // "python" itself is skipped, not a real dependency
  assert.equal(deps[0].name, "requests");
  assert.equal(deps[0].declaredRange, "^2.28");
  assert.equal(deps[0].kind, "dependencies");
});

test("parses Poetry inline-table dependency values ({version = ..., extras = [...]})", () => {
  const doc = toml.parse(`
[tool.poetry.dependencies]
requests = { version = "^2.28", extras = ["security"] }
`);
  const deps = parsePyprojectDependencies(doc);
  assert.equal(deps[0].declaredRange, "^2.28");
});

test("parses legacy Poetry [tool.poetry.dev-dependencies]", () => {
  const doc = toml.parse(`
[tool.poetry.dependencies]
requests = "^2.28"

[tool.poetry.dev-dependencies]
pytest = "^7.0"
`);
  const deps = parsePyprojectDependencies(doc);
  const pytest = deps.find((d) => d.name === "pytest");
  assert.equal(pytest?.kind, "devDependencies");
});

test("parses modern Poetry dependency groups, mapping 'dev' to devDependencies and others to optionalDependencies", () => {
  const doc = toml.parse(`
[tool.poetry.dependencies]
requests = "^2.28"

[tool.poetry.group.dev.dependencies]
pytest = "^7.0"

[tool.poetry.group.docs.dependencies]
sphinx = "^7.0"
`);
  const deps = parsePyprojectDependencies(doc);
  const pytest = deps.find((d) => d.name === "pytest");
  const sphinx = deps.find((d) => d.name === "sphinx");
  assert.equal(pytest?.kind, "devDependencies");
  assert.equal(sphinx?.kind, "optionalDependencies");
});

test("combines PEP 621 and Poetry entries if a project somehow uses both", () => {
  const doc = toml.parse(`
[project]
dependencies = ["flask>=2.0"]

[tool.poetry.dependencies]
requests = "^2.28"
`);
  const deps = parsePyprojectDependencies(doc);
  const names = deps.map((d) => d.name).sort();
  assert.deepEqual(names, ["flask", "requests"]);
});

test("returns an empty array when there's nothing recognizable", () => {
  const doc = toml.parse(`[build-system]\nrequires = ["setuptools"]\n`);
  assert.deepEqual(parsePyprojectDependencies(doc), []);
});
