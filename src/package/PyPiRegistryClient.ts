import { PackageVersionMetadata } from "../models/PackageChange";
import { CacheService } from "../services/CacheService";
import { getJson, NetworkUnavailableError } from "../utils/httpJson";

interface PyPiReleaseInfo {
  name: string;
  version: string;
  requires_python?: string;
  project_urls?: Record<string, string> | null;
  yanked?: boolean;
  yanked_reason?: string | null;
}

interface PyPiPackageDoc {
  info: PyPiReleaseInfo;
  releases?: Record<string, unknown[]>;
}

function extractRepositoryUrl(urls: Record<string, string> | null | undefined): string | undefined {
  if (!urls) return undefined;
  const preferredKeys = ["Source", "Source Code", "Repository", "GitHub", "Code", "Homepage"];
  for (const key of preferredKeys) {
    const value = urls[key];
    if (value?.includes("github.com")) return value;
  }
  for (const value of Object.values(urls)) {
    if (value?.includes("github.com")) return value;
  }
  return undefined;
}

/**
 * The PyPI JSON API client - the Python-ecosystem equivalent of
 * `NpmRegistryClient`. PyPI's per-version metadata is much thinner than
 * npm's: there's no direct equivalent of `peerDependencies` (Python's
 * dependency model doesn't have the same "must also be present in the
 * consumer" concept in general use), and no bundled type declarations or
 * tarball-based export-surface comparison the way `TypeDeclarationDiffer`
 * does for npm packages. What DOES carry over cleanly: `requires_python`
 * maps onto the same `engines` field `NpmRegistryChangeProvider` already
 * knows how to diff, `yanked` maps onto `deprecated`, and `project_urls`
 * often contains a GitHub repository link, which is exactly what
 * `GitHubChangeProvider` needs - so that evidence source works unchanged
 * for Python packages with no Python-specific code at all.
 */
export class PyPiRegistryClient {
  constructor(private readonly cache: CacheService, private readonly indexUrl: string = "https://pypi.org/pypi") {}

  private async getPackageDoc(packageName: string): Promise<PyPiPackageDoc | null> {
    const cacheKey = `pypi-doc:${this.indexUrl}:${packageName}`;
    const cached = this.cache.get<PyPiPackageDoc>(cacheKey);
    if (cached) return cached;

    try {
      const doc = await getJson<PyPiPackageDoc>(`${this.indexUrl}/${encodeURIComponent(packageName)}/json`);
      // PyPI release metadata for a package's current state changes (new
      // releases appear), so a shorter TTL than npm's immutable-per-version
      // cache is appropriate for the package-level doc.
      this.cache.set(cacheKey, doc, 1000 * 60 * 60 * 6);
      return doc;
    } catch (err) {
      if (err instanceof NetworkUnavailableError) return null;
      throw err;
    }
  }

  private async getVersionDoc(packageName: string, version: string): Promise<PyPiReleaseInfo | null> {
    const cacheKey = `pypi-version:${this.indexUrl}:${packageName}@${version}`;
    const cached = this.cache.get<PyPiReleaseInfo>(cacheKey);
    if (cached) return cached;

    try {
      const doc = await getJson<{ info: PyPiReleaseInfo }>(`${this.indexUrl}/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}/json`);
      // A specific published version's own metadata is immutable - safe to cache long-term.
      this.cache.set(cacheKey, doc.info, 1000 * 60 * 60 * 24);
      return doc.info;
    } catch (err) {
      if (err instanceof NetworkUnavailableError) return null;
      throw err;
    }
  }

  async getVersionMetadata(packageName: string, version: string): Promise<PackageVersionMetadata | null> {
    const info = await this.getVersionDoc(packageName, version);
    if (!info) return null;
    return {
      name: info.name,
      version: info.version,
      engines: info.requires_python ? { python: info.requires_python } : undefined,
      deprecated: info.yanked ? info.yanked_reason ?? "This release was yanked from PyPI." : undefined,
      hasTypes: false,
      repositoryUrl: extractRepositoryUrl(info.project_urls),
    };
  }

  async listVersions(packageName: string): Promise<{ versions: string[]; latest: string | null; latestMajor: string | null }> {
    const doc = await this.getPackageDoc(packageName);
    if (!doc) return { versions: [], latest: null, latestMajor: null };

    const versions = Object.keys(doc.releases ?? {});
    const latest = doc.info.version || null;
    let latestMajor: string | null = null;
    if (latest) {
      const latestMajorNum = Number(latest.split(".")[0]);
      if (!Number.isNaN(latestMajorNum)) {
        // Not every published Python version is strict semver (PEP 440
        // permits things like "2021.3" or "1.0.0rc1"), so this only
        // considers versions that at least start with a plain integer
        // major component - the rest degrade gracefully to "unknown"
        // version-change classification elsewhere in the pipeline.
        const candidates = versions.filter((v) => {
          const major = Number(v.split(".")[0]);
          return !Number.isNaN(major) && major > latestMajorNum;
        });
        latestMajor = candidates.length > 0 ? candidates.sort().reverse()[0] : latest;
      }
    }
    return { versions, latest, latestMajor };
  }
}
