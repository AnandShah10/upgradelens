import { PackageManager } from "../package/PackageManager";
import { CacheService } from "../services/CacheService";
import { getBuffer } from "../utils/httpBuffer";
import { NetworkUnavailableError } from "../utils/httpJson";
import { extractTarball, stripPackagePrefix, TarEntry } from "../utils/tarball";
import { extractExportedSymbols } from "./dtsExportExtractor";

export interface TypeDiffResult {
  fromVersion: string;
  toVersion: string;
  removedSymbols: string[];
  addedSymbols: string[];
}

interface TarballPackageJson {
  types?: string;
  typings?: string;
  main?: string;
}

function findEntryPointDts(entries: TarEntry[]): string | null {
  const byPath = new Map<string, TarEntry>();
  for (const e of entries) byPath.set(stripPackagePrefix(e.name), e);

  const pkgJsonEntry = byPath.get("package.json");
  if (pkgJsonEntry) {
    try {
      const pkgJson: TarballPackageJson = JSON.parse(pkgJsonEntry.content.toString("utf8"));
      const declared = pkgJson.types ?? pkgJson.typings;
      if (declared) {
        const normalized = declared.replace(/^\.\//, "");
        if (byPath.has(normalized)) return byPath.get(normalized)!.content.toString("utf8");
      }
    } catch {
      // Fall through to conventional locations below.
    }
  }

  for (const candidate of ["index.d.ts", "dist/index.d.ts", "lib/index.d.ts", "types/index.d.ts", "build/index.d.ts"]) {
    const entry = byPath.get(candidate);
    if (entry) return entry.content.toString("utf8");
  }

  return null;
}

/**
 * Downloads the actual published tarball for a specific package version
 * (from the registry's `dist.tarball` URL) and extracts its exported
 * symbol names, entirely in memory - nothing is written to disk, and
 * nothing in the user's project is touched.
 *
 * This is the "full" version of what `ApiAnalyzer` does for the locally
 * installed version only: it lets `removed-export` claims be corroborated
 * (or contradicted) against the *actual target version's* published types,
 * not just inferred from a known-changes table.
 */
export class TypeDeclarationDiffer {
  constructor(
    private readonly packageManager: PackageManager,
    private readonly cache: CacheService,
    private readonly fetchTarball: (url: string) => Promise<Buffer> = (url) => getBuffer(url, { maxBytes: 15 * 1024 * 1024 })
  ) {}

  /** Best-effort: returns null (never throws) if either version's types can't be resolved or downloaded. */
  async getExportedSymbols(packageName: string, version: string): Promise<Set<string> | null> {
    const cacheKey = `dts-symbols:${packageName}@${version}`;
    const cached = this.cache.get<string[]>(cacheKey);
    if (cached) return new Set(cached);

    try {
      const meta = await this.packageManager.getVersionMetadata(packageName, version);
      if (!meta?.hasTypes || !meta.tarballUrl) return null;

      const gzipped = await this.fetchTarball(meta.tarballUrl);
      const entries = extractTarball(gzipped);
      const dtsText = findEntryPointDts(entries);
      if (!dtsText) return null;

      const symbols = extractExportedSymbols(dtsText);
      // Published tarball contents for a given version never change - safe to cache long-term.
      this.cache.set(cacheKey, Array.from(symbols), 1000 * 60 * 60 * 24 * 14);
      return symbols;
    } catch (err) {
      if (err instanceof NetworkUnavailableError) return null;
      return null; // Malformed tarball, unexpected package layout, etc. - never fail the overall analysis for this.
    }
  }

  /** Diffs the exported symbol sets of two versions. Returns null if either side couldn't be resolved. */
  async diffVersions(packageName: string, fromVersion: string, toVersion: string): Promise<TypeDiffResult | null> {
    const [fromSymbols, toSymbols] = await Promise.all([
      this.getExportedSymbols(packageName, fromVersion),
      this.getExportedSymbols(packageName, toVersion),
    ]);
    if (!fromSymbols || !toSymbols) return null;

    const removedSymbols = Array.from(fromSymbols).filter((s) => !toSymbols.has(s));
    const addedSymbols = Array.from(toSymbols).filter((s) => !fromSymbols.has(s));

    return { fromVersion, toVersion, removedSymbols, addedSymbols };
  }
}
