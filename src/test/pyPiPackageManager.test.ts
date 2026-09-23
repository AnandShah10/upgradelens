import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PyPiPackageManager } from "../package/PyPiPackageManager";
import { CacheService } from "../services/CacheService";

function makeTempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "upgradelens-pypi-test-"));
}

test("reads dependencies from a plain requirements.txt project", async () => {
  const root = makeTempProject();
  try {
    fs.writeFileSync(path.join(root, "requirements.txt"), "requests==2.31.0\nflask>=2.0\n# a comment\nnumpy\n");
    const pm = new PyPiPackageManager(new CacheService(undefined));
    const manifest = await pm.readManifest(root);

    const names = manifest.dependencies.map((d) => d.name).sort();
    assert.deepEqual(names, ["flask", "numpy", "requests"]);

    const requests = manifest.dependencies.find((d) => d.name === "requests");
    assert.equal(requests?.installedVersion, "2.31.0"); // exact == pin treated as resolved
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reads dependencies from a PEP 621 pyproject.toml project", async () => {
  const root = makeTempProject();
  try {
    fs.writeFileSync(
      path.join(root, "pyproject.toml"),
      '[project]\nname = "myapp"\ndependencies = ["requests>=2.28", "numpy"]\n'
    );
    const pm = new PyPiPackageManager(new CacheService(undefined));
    const manifest = await pm.readManifest(root);
    const names = manifest.dependencies.map((d) => d.name).sort();
    assert.deepEqual(names, ["numpy", "requests"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolves exact versions from poetry.lock for a Poetry-based project", async () => {
  const root = makeTempProject();
  try {
    fs.writeFileSync(
      path.join(root, "pyproject.toml"),
      '[tool.poetry.dependencies]\npython = "^3.10"\nrequests = "^2.28"\n'
    );
    fs.writeFileSync(path.join(root, "poetry.lock"), '[[package]]\nname = "requests"\nversion = "2.31.0"\n');

    const pm = new PyPiPackageManager(new CacheService(undefined));
    const manifest = await pm.readManifest(root);
    const requests = manifest.dependencies.find((d) => d.name === "requests");
    assert.equal(requests?.declaredRange, "^2.28");
    assert.equal(requests?.installedVersion, "2.31.0");
    assert.equal(manifest.lockfile.present, true);
    assert.equal(manifest.lockfile.fileName, "poetry.lock");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("combines requirements.txt and pyproject.toml without duplicating an entry present in both", async () => {
  const root = makeTempProject();
  try {
    fs.writeFileSync(root + "/requirements.txt", "requests==2.31.0\n");
    fs.writeFileSync(root + "/pyproject.toml", '[project]\ndependencies = ["requests>=2.28", "flask"]\n');

    const pm = new PyPiPackageManager(new CacheService(undefined));
    const manifest = await pm.readManifest(root);
    const requestsEntries = manifest.dependencies.filter((d) => d.name === "requests");
    assert.equal(requestsEntries.length, 1); // not duplicated
    assert.equal(requestsEntries[0].installedVersion, "2.31.0"); // requirements.txt's exact pin wins

    const names = manifest.dependencies.map((d) => d.name).sort();
    assert.deepEqual(names, ["flask", "requests"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reports no lockfile present and empty dependencies for a project with none of the recognized files", async () => {
  const root = makeTempProject();
  try {
    const pm = new PyPiPackageManager(new CacheService(undefined));
    const manifest = await pm.readManifest(root);
    assert.deepEqual(manifest.dependencies, []);
    assert.equal(manifest.lockfile.present, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a malformed pyproject.toml doesn't block reading a valid requirements.txt", async () => {
  const root = makeTempProject();
  try {
    fs.writeFileSync(path.join(root, "requirements.txt"), "requests==2.31.0\n");
    fs.writeFileSync(path.join(root, "pyproject.toml"), "this is not valid toml {{{");

    const pm = new PyPiPackageManager(new CacheService(undefined));
    const manifest = await pm.readManifest(root);
    const names = manifest.dependencies.map((d) => d.name);
    assert.deepEqual(names, ["requests"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
