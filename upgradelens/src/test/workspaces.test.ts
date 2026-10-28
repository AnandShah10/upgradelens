import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NpmPackageManager } from "../package/NpmPackageManager";
import { CacheService } from "../services/CacheService";

function makeTempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "upgradelens-workspace-test-"));
}

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data));
}

test("aggregates dependencies from workspace member packages matched by a glob pattern", async () => {
  const root = makeTempProject();
  try {
    writeJson(path.join(root, "package.json"), {
      name: "monorepo-root",
      private: true,
      workspaces: ["packages/*"],
      dependencies: { typescript: "^5.4.0" },
    });
    writeJson(path.join(root, "packages", "api", "package.json"), {
      name: "@acme/api",
      dependencies: { express: "^4.19.2" },
    });
    writeJson(path.join(root, "packages", "web", "package.json"), {
      name: "@acme/web",
      dependencies: { react: "^18.2.0" },
    });

    const pm = new NpmPackageManager(new CacheService(undefined));
    const manifest = await pm.readManifest(root);

    assert.equal(manifest.isWorkspaceRoot, true);
    assert.deepEqual(manifest.workspacePackagePaths.sort(), ["packages/api", "packages/web"]);

    const names = manifest.dependencies.map((d) => d.name).sort();
    assert.deepEqual(names, ["express", "react", "typescript"]);

    const expressDep = manifest.dependencies.find((d) => d.name === "express");
    assert.equal(expressDep?.workspacePackage, "packages/api");

    const tsDep = manifest.dependencies.find((d) => d.name === "typescript");
    assert.equal(tsDep?.workspacePackage, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a project with no workspaces field reports isWorkspaceRoot=false and no member paths", async () => {
  const root = makeTempProject();
  try {
    writeJson(path.join(root, "package.json"), { name: "single-package", dependencies: { lodash: "^4.17.21" } });
    const pm = new NpmPackageManager(new CacheService(undefined));
    const manifest = await pm.readManifest(root);
    assert.equal(manifest.isWorkspaceRoot, false);
    assert.deepEqual(manifest.workspacePackagePaths, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ignores workspace directories without a package.json", async () => {
  const root = makeTempProject();
  try {
    writeJson(path.join(root, "package.json"), { name: "root", workspaces: ["packages/*"] });
    writeJson(path.join(root, "packages", "real", "package.json"), { name: "real-pkg", dependencies: { chalk: "^5.0.0" } });
    fs.mkdirSync(path.join(root, "packages", "empty-dir"), { recursive: true }); // no package.json here

    const pm = new NpmPackageManager(new CacheService(undefined));
    const manifest = await pm.readManifest(root);
    assert.deepEqual(manifest.workspacePackagePaths, ["packages/real"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
