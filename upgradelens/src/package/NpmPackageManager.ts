import * as fs from "fs";
import * as path from "path";
import { PackageVersionMetadata } from "../models/PackageChange";
import { CacheService } from "../services/CacheService";
import { readManifestDependencies } from "./manifestUtils";
import { NpmRegistryClient } from "./NpmRegistryClient";
import { LockfileInfo, PackageManager, ProjectManifest } from "./PackageManager";

interface NpmLockfilePackageEntry {
  version?: string;
}

interface NpmLockfileV2Plus {
  packages?: Record<string, NpmLockfilePackageEntry>;
  dependencies?: Record<string, NpmLockfilePackageEntry>;
}

export { PackageJsonParseError, NoManifestError } from "./manifestUtils";

export class NpmPackageManager implements PackageManager {
  readonly id = "npm" as const;
  private readonly registryClient: NpmRegistryClient;

  constructor(cache: CacheService, registryUrl?: string) {
    this.registryClient = new NpmRegistryClient(cache, registryUrl);
  }

  async readManifest(projectRoot: string): Promise<ProjectManifest> {
    const lockfile = this.readLockfile(projectRoot);
    const { dependencies, workspacePatterns, workspacePackagePaths } = readManifestDependencies(projectRoot, lockfile);
    return {
      dependencies,
      isWorkspaceRoot: workspacePatterns.length > 0,
      workspacePatterns,
      workspacePackagePaths,
      lockfile,
    };
  }

  private readLockfile(projectRoot: string): LockfileInfo {
    const lockPath = path.join(projectRoot, "package-lock.json");
    if (!fs.existsSync(lockPath)) {
      return { present: false, resolvedVersions: {} };
    }
    try {
      const lock = JSON.parse(fs.readFileSync(lockPath, "utf8")) as NpmLockfileV2Plus;
      const resolvedVersions: Record<string, string> = {};

      // npm v7+ lockfile format: "packages" keyed by node_modules path.
      if (lock.packages) {
        for (const [pkgPath, entry] of Object.entries(lock.packages)) {
          if (!pkgPath.startsWith("node_modules/") || !entry.version) continue;
          const name = pkgPath.slice("node_modules/".length);
          // Only take the top-level (hoisted) resolution, not nested copies.
          if (!name.includes("node_modules/")) {
            resolvedVersions[name] = entry.version;
          }
        }
      } else if (lock.dependencies) {
        // Legacy npm v6 lockfile format.
        for (const [name, entry] of Object.entries(lock.dependencies)) {
          if (entry.version) resolvedVersions[name] = entry.version;
        }
      }

      return { present: true, fileName: "package-lock.json", resolvedVersions };
    } catch {
      // A malformed lockfile shouldn't break analysis - fall back to declared ranges only.
      return { present: true, fileName: "package-lock.json", resolvedVersions: {} };
    }
  }

  async getVersionMetadata(packageName: string, version: string): Promise<PackageVersionMetadata | null> {
    return this.registryClient.getVersionMetadata(packageName, version);
  }

  async listVersions(packageName: string): Promise<{ versions: string[]; latest: string | null; latestMajor: string | null }> {
    return this.registryClient.listVersions(packageName);
  }
}
