import { Dependency } from "../models/Dependency";
import { PackageVersionMetadata } from "../models/PackageChange";

export interface LockfileInfo {
  present: boolean;
  fileName?: string;
  resolvedVersions: Record<string, string>;
}

export interface ProjectManifest {
  dependencies: Dependency[];
  isWorkspaceRoot: boolean;
  workspacePatterns: string[];
  /** Workspace-relative paths (e.g. "packages/api") to member packages discovered from workspacePatterns. */
  workspacePackagePaths: string[];
  lockfile: LockfileInfo;
}

/**
 * Abstraction over a package ecosystem's manifest/lockfile format and
 * registry. Implemented for npm, yarn, pnpm, and bun (all sharing the npm
 * registry via `NpmRegistryClient`) and for Python/PyPI (`PyPiPackageManager`,
 * backed by `PyPiRegistryClient`) - the interface is the seam any further
 * ecosystem plugs into without touching
 * analysis/impact/risk code.
 */
export interface PackageManager {
  readonly id: "npm" | "yarn" | "pnpm" | "bun" | "pypi" | "cargo" | "go" | "maven";

  /** Parses package.json (and lockfile, if present) in the given project root. */
  readManifest(projectRoot: string): Promise<ProjectManifest>;

  /** Fetches metadata for a specific published version of a package. */
  getVersionMetadata(packageName: string, version: string): Promise<PackageVersionMetadata | null>;

  /** Lists published versions, most recent first, respecting dist-tags like "latest". */
  listVersions(packageName: string): Promise<{ versions: string[]; latest: string | null; latestMajor: string | null }>;
}
