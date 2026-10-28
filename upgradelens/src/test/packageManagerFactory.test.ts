import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PackageManagerFactory } from "../package/PackageManagerFactory";
import { CacheService } from "../services/CacheService";

function makeTempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "upgradelens-pm-factory-test-"));
}

function withProject(files: string[], test_: (root: string) => void): void {
  const root = makeTempProject();
  try {
    fs.writeFileSync(path.join(root, "package.json"), "{}");
    for (const f of files) fs.writeFileSync(path.join(root, f), "");
    test_(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** Like withProject, but WITHOUT a package.json - for testing Python detection, since a project with
 * both package.json and Python signals should still be treated as npm-family (see the precedence test below). */
function withPythonProject(files: string[], test_: (root: string) => void): void {
  const root = makeTempProject();
  try {
    for (const f of files) fs.writeFileSync(path.join(root, f), "");
    test_(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const factory = new PackageManagerFactory(new CacheService(undefined));

test("detects npm when only package-lock.json is present", () => {
  withProject(["package-lock.json"], (root) => {
    assert.equal(factory.detect(root).id, "npm");
  });
});

test("detects yarn when yarn.lock is present", () => {
  withProject(["yarn.lock"], (root) => {
    assert.equal(factory.detect(root).id, "yarn");
  });
});

test("detects pnpm when pnpm-lock.yaml is present", () => {
  withProject(["pnpm-lock.yaml"], (root) => {
    assert.equal(factory.detect(root).id, "pnpm");
  });
});

test("detects bun from the text bun.lock file", () => {
  withProject(["bun.lock"], (root) => {
    assert.equal(factory.detect(root).id, "bun");
  });
});

test("detects bun from the binary bun.lockb file", () => {
  withProject(["bun.lockb"], (root) => {
    assert.equal(factory.detect(root).id, "bun");
  });
});

test("defaults to npm when no lockfile is present at all", () => {
  withProject([], (root) => {
    assert.equal(factory.detect(root).id, "npm");
  });
});

test("bun takes precedence over other lockfiles if multiple are somehow present", () => {
  withProject(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock"], (root) => {
    assert.equal(factory.detect(root).id, "bun");
  });
});

test("detects pypi from a bare requirements.txt with no package.json", () => {
  withPythonProject(["requirements.txt"], (root) => {
    assert.equal(factory.detect(root).id, "pypi");
  });
});

test("detects pypi from a bare pyproject.toml with no package.json", () => {
  withPythonProject(["pyproject.toml"], (root) => {
    assert.equal(factory.detect(root).id, "pypi");
  });
});

test("detects pypi from a bare poetry.lock with no package.json", () => {
  withPythonProject(["poetry.lock"], (root) => {
    assert.equal(factory.detect(root).id, "pypi");
  });
});

test("npm-family evidence (package.json) takes precedence over Python signals if both somehow exist", () => {
  withProject(["requirements.txt", "pyproject.toml"], (root) => {
    assert.equal(factory.detect(root).id, "npm");
  });
});

test("defaults to npm when there is truly nothing recognizable at all (no package.json, no Python signals)", () => {
  withPythonProject([], (root) => {
    assert.equal(factory.detect(root).id, "npm");
  });
});
