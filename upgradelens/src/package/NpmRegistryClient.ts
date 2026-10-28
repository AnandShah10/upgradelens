import { PackageVersionMetadata } from "../models/PackageChange";
import { CacheService } from "../services/CacheService";
import { getJson, NetworkUnavailableError } from "../utils/httpJson";

interface RegistryVersionDoc {
  name: string;
  version: string;
  peerDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
  engines?: Record<string, string>;
  deprecated?: string;
  types?: string;
  typings?: string;
  exports?: unknown;
  dist?: { tarball?: string };
  repository?: string | { url?: string };
}

interface RegistryPackageDoc {
  "dist-tags"?: Record<string, string>;
  versions?: Record<string, RegistryVersionDoc>;
  time?: Record<string, string>;
}

function collectExportPaths(pkgName: string, exportsField: unknown): string[] | undefined {
  if (!exportsField) return undefined;
  const paths = new Set<string>();
  const walk = (key: string) => {
    if (key === ".") {
      paths.add(pkgName);
    } else if (key.startsWith("./")) {
      paths.add(`${pkgName}/${key.slice(2)}`);
    }
  };
  if (typeof exportsField === "string") {
    paths.add(pkgName);
  } else if (typeof exportsField === "object" && exportsField !== null) {
    for (const key of Object.keys(exportsField as Record<string, unknown>)) {
      walk(key);
    }
  }
  return paths.size > 0 ? Array.from(paths) : undefined;
}

function normalizeRepositoryUrl(repository: RegistryVersionDoc["repository"]): string | undefined {
  const raw = typeof repository === "string" ? repository : repository?.url;
  if (!raw) return undefined;
  return raw
    .replace(/^git\+/, "")
    .replace(/\.git$/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^git@github\.com:/, "https://github.com/");
}

/**
 * The npm registry HTTP client, shared by every `PackageManager`
 * implementation. Yarn, pnpm, and Bun all resolve packages from the same
 * npm registry by default (only their manifest/lockfile *formats* differ),
 * so this is the one piece of registry-facing logic that doesn't need to
 * be reimplemented per package manager.
 */
export class NpmRegistryClient {
  constructor(private readonly cache: CacheService, private readonly registryUrl: string = "https://registry.npmjs.org") {}

  private async getRegistryDoc(packageName: string): Promise<RegistryPackageDoc> {
    const cacheKey = `registry-doc:${this.registryUrl}:${packageName}`;
    const cached = this.cache.get<RegistryPackageDoc>(cacheKey);
    if (cached) return cached;

    const url = `${this.registryUrl}/${encodeURIComponent(packageName).replace(/^%40/, "@")}`;
    const doc = await getJson<RegistryPackageDoc>(url);
    // Registry metadata for published versions is immutable, so a longer TTL is safe.
    this.cache.set(cacheKey, doc, 1000 * 60 * 60 * 24);
    return doc;
  }

  async getVersionMetadata(packageName: string, version: string): Promise<PackageVersionMetadata | null> {
    try {
      const doc = await this.getRegistryDoc(packageName);
      const versionDoc = doc.versions?.[version];
      if (!versionDoc) return null;
      return {
        name: versionDoc.name,
        version: versionDoc.version,
        peerDependencies: versionDoc.peerDependencies,
        dependencies: versionDoc.dependencies,
        engines: versionDoc.engines,
        deprecated: versionDoc.deprecated,
        hasTypes: Boolean(versionDoc.types || versionDoc.typings),
        exportPaths: collectExportPaths(packageName, versionDoc.exports),
        tarballUrl: versionDoc.dist?.tarball,
        repositoryUrl: normalizeRepositoryUrl(versionDoc.repository),
      };
    } catch (err) {
      if (err instanceof NetworkUnavailableError) return null;
      throw err;
    }
  }

  async listVersions(packageName: string): Promise<{ versions: string[]; latest: string | null; latestMajor: string | null }> {
    try {
      const doc = await this.getRegistryDoc(packageName);
      const versions = Object.keys(doc.versions ?? {});
      const latest = doc["dist-tags"]?.latest ?? null;
      let latestMajor: string | null = null;
      if (latest) {
        const latestMajorNum = Number(latest.split(".")[0]);
        const candidates = versions.filter((v) => Number(v.split(".")[0]) > latestMajorNum);
        latestMajor = candidates.length > 0 ? candidates.sort().reverse()[0] : latest;
      }
      return { versions, latest, latestMajor };
    } catch (err) {
      if (err instanceof NetworkUnavailableError) {
        return { versions: [], latest: null, latestMajor: null };
      }
      throw err;
    }
  }
}
