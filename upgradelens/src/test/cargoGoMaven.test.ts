import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { test } from "node:test";
import { CargoPackageManager } from "../package/CargoPackageManager";
import { GoPackageManager } from "../package/GoPackageManager";
import { MavenPackageManager } from "../package/MavenPackageManager";
import { CacheService } from "../services/CacheService";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "upgradelens-"));
}

test("CargoPackageManager reads workspace members", async () => {
  const root = tmpDir();
  fs.writeFileSync(
    path.join(root, "Cargo.toml"),
    `[workspace]\nmembers = ["crates/core"]\n`
  );
  fs.mkdirSync(path.join(root, "crates", "core"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "crates", "core", "Cargo.toml"),
    `[package]\nname = "core"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1.0"\n`
  );
  const pm = new CargoPackageManager(new CacheService(undefined));
  const manifest = await pm.readManifest(root);
  assert.ok(manifest.isWorkspaceRoot);
  assert.ok(manifest.dependencies.some((d) => d.name === "serde"));
  assert.ok(manifest.workspacePackagePaths.some((p) => p.includes("core")));
});

test("GoPackageManager reads go.work modules", async () => {
  const root = tmpDir();
  fs.writeFileSync(path.join(root, "go.work"), `go 1.21\nuse (\n  ./svc\n)\n`);
  fs.mkdirSync(path.join(root, "svc"));
  fs.writeFileSync(
    path.join(root, "svc", "go.mod"),
    `module example.com/svc\n\ngo 1.21\n\nrequire github.com/pkg/errors v0.9.1\n`
  );
  const pm = new GoPackageManager(new CacheService(undefined));
  const manifest = await pm.readManifest(root);
  assert.ok(manifest.dependencies.some((d) => d.name === "github.com/pkg/errors"));
  assert.ok(manifest.workspacePackagePaths.includes("svc"));
});

test("MavenPackageManager aggregates multi-module poms", async () => {
  const root = tmpDir();
  fs.writeFileSync(
    path.join(root, "pom.xml"),
    `<project><modules><module>core</module></modules></project>`
  );
  fs.mkdirSync(path.join(root, "core"));
  fs.writeFileSync(
    path.join(root, "core", "pom.xml"),
    `<project><dependencies>
      <dependency><groupId>junit</groupId><artifactId>junit</artifactId><version>4.13.2</version><scope>test</scope></dependency>
    </dependencies></project>`
  );
  const pm = new MavenPackageManager(new CacheService(undefined));
  const manifest = await pm.readManifest(root);
  assert.ok(manifest.isWorkspaceRoot);
  assert.ok(manifest.dependencies.some((d) => d.name === "junit:junit"));
});
