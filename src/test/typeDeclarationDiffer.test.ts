import assert from "node:assert/strict";
import { test } from "node:test";
import { TypeDeclarationDiffer } from "../analysis/TypeDeclarationDiffer";
import { PackageManager, ProjectManifest } from "../package/PackageManager";
import { PackageVersionMetadata } from "../models/PackageChange";
import { CacheService } from "../services/CacheService";
import { buildFakeTarball } from "./testUtils/buildTarball";

function fakePackageManager(versionToTarball: Record<string, Buffer>): PackageManager {
  return {
    id: "npm",
    async readManifest(): Promise<ProjectManifest> {
      throw new Error("not used in this test");
    },
    async getVersionMetadata(packageName: string, version: string): Promise<PackageVersionMetadata | null> {
      const key = `${packageName}@${version}`;
      if (!(key in versionToTarball)) return null;
      return {
        name: packageName,
        version,
        hasTypes: true,
        tarballUrl: `https://example.invalid/${key}.tgz`,
      };
    },
    async listVersions() {
      return { versions: [], latest: null, latestMajor: null };
    },
  };
}

test("diffVersions finds a symbol removed between two versions", async () => {
  const fromTar = buildFakeTarball([
    { name: "package/package.json", content: '{"types":"index.d.ts"}' },
    { name: "package/index.d.ts", content: "export function oldApi(): void;\nexport function stable(): void;" },
  ]);
  const toTar = buildFakeTarball([
    { name: "package/package.json", content: '{"types":"index.d.ts"}' },
    { name: "package/index.d.ts", content: "export function stable(): void;\nexport function newApi(): void;" },
  ]);

  const pm = fakePackageManager({ "demo@1.0.0": fromTar, "demo@2.0.0": toTar });
  const cache = new CacheService(undefined);
  const fetchTarball = async (url: string) => {
    if (url.includes("1.0.0")) return fromTar;
    if (url.includes("2.0.0")) return toTar;
    throw new Error("unexpected url");
  };

  const differ = new TypeDeclarationDiffer(pm, cache, fetchTarball);
  const diff = await differ.diffVersions("demo", "1.0.0", "2.0.0");

  assert.ok(diff);
  assert.deepEqual(diff!.removedSymbols.sort(), ["oldApi"]);
  assert.deepEqual(diff!.addedSymbols.sort(), ["newApi"]);
});

test("returns null when a version's metadata/types can't be resolved", async () => {
  const pm = fakePackageManager({});
  const cache = new CacheService(undefined);
  const differ = new TypeDeclarationDiffer(pm, cache, async () => Buffer.alloc(0));
  const diff = await differ.diffVersions("demo", "1.0.0", "2.0.0");
  assert.equal(diff, null);
});

test("resolves the entry point via the package.json types field, not just index.d.ts", async () => {
  const tar = buildFakeTarball([
    { name: "package/package.json", content: '{"types":"dist/types.d.ts"}' },
    { name: "package/dist/types.d.ts", content: "export const flag: boolean;" },
  ]);
  const pm = fakePackageManager({ "demo@1.0.0": tar });
  const cache = new CacheService(undefined);
  const differ = new TypeDeclarationDiffer(pm, cache, async () => tar);
  const symbols = await differ.getExportedSymbols("demo", "1.0.0");
  assert.ok(symbols?.has("flag"));
});
