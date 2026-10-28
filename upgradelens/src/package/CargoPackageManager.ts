import * as fs from "fs";
import * as path from "path";
import * as toml from "smol-toml";
import { Dependency } from "../models/Dependency";
import { PackageVersionMetadata } from "../models/PackageChange";
import { CacheService } from "../services/CacheService";
import { LockfileInfo, PackageManager, ProjectManifest } from "./PackageManager";

/**
 * Cargo (Rust) package manager: Cargo.toml + Cargo.lock, including
 * workspace members listed under [workspace].members. Registry: crates.io.
 * Usage scanning: TreeSitterUsageAnalyzer (Rust) with regex fallback.
 */
export class CargoPackageManager implements PackageManager {
  readonly id = "cargo" as const;

  constructor(private readonly cache: CacheService) {}

  async readManifest(projectRoot: string): Promise<ProjectManifest> {
    const dependencies: Dependency[] = [];
    const lockfile = this.readLockfile(projectRoot);
    const workspacePackagePaths: string[] = [];
    let isWorkspaceRoot = false;
    let workspacePatterns: string[] = [];

    const rootToml = path.join(projectRoot, "Cargo.toml");
    if (fs.existsSync(rootToml)) {
      try {
        const doc = toml.parse(fs.readFileSync(rootToml, "utf8")) as Record<string, unknown>;
        collectCargoDeps(doc, lockfile, dependencies);

        const workspace = doc["workspace"] as Record<string, unknown> | undefined;
        if (workspace && Array.isArray(workspace["members"])) {
          isWorkspaceRoot = true;
          workspacePatterns = (workspace["members"] as unknown[]).filter((m): m is string => typeof m === "string");
          for (const pattern of workspacePatterns) {
            for (const memberDir of expandWorkspaceMember(projectRoot, pattern)) {
              const rel = path.relative(projectRoot, memberDir).split(path.sep).join("/");
              workspacePackagePaths.push(rel);
              const memberToml = path.join(memberDir, "Cargo.toml");
              if (!fs.existsSync(memberToml)) continue;
              try {
                const memberDoc = toml.parse(fs.readFileSync(memberToml, "utf8")) as Record<string, unknown>;
                const before = dependencies.length;
                collectCargoDeps(memberDoc, lockfile, dependencies, rel);
                // mark new deps with workspace package path (already done in collect)
                void before;
              } catch {
                // skip malformed member
              }
            }
          }
        }
      } catch {
        // Malformed root Cargo.toml
      }
    }

    return {
      dependencies: dependencies.sort((a, b) => a.name.localeCompare(b.name)),
      isWorkspaceRoot,
      workspacePatterns,
      workspacePackagePaths,
      lockfile,
    };
  }

  private readLockfile(projectRoot: string): LockfileInfo {
    const lockPath = path.join(projectRoot, "Cargo.lock");
    if (!fs.existsSync(lockPath)) return { present: false, resolvedVersions: {} };
    try {
      const doc = toml.parse(fs.readFileSync(lockPath, "utf8")) as { package?: { name?: string; version?: string }[] };
      const resolvedVersions: Record<string, string> = {};
      for (const pkg of doc.package ?? []) {
        if (pkg?.name && pkg.version && !(pkg.name in resolvedVersions)) {
          resolvedVersions[pkg.name] = pkg.version;
        }
      }
      return { present: true, fileName: "Cargo.lock", resolvedVersions };
    } catch {
      return { present: false, resolvedVersions: {} };
    }
  }

  async getVersionMetadata(packageName: string, version: string): Promise<PackageVersionMetadata | null> {
    const cacheKey = `crates:${packageName}@${version}`;
    const cached = this.cache.get<PackageVersionMetadata>(cacheKey);
    if (cached) return cached;
    try {
      const res = await fetch(`https://crates.io/api/v1/crates/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`);
      if (!res.ok) return null;
      const data = (await res.json()) as { version?: { num?: string; yanked?: boolean } };
      const meta: PackageVersionMetadata = {
        name: packageName,
        version: data.version?.num ?? version,
        hasTypes: false,
        deprecated: data.version?.yanked ? "yanked on crates.io" : undefined,
      };
      this.cache.set(cacheKey, meta);
      return meta;
    } catch {
      return null;
    }
  }

  async listVersions(packageName: string): Promise<{ versions: string[]; latest: string | null; latestMajor: string | null }> {
    try {
      const res = await fetch(`https://crates.io/api/v1/crates/${encodeURIComponent(packageName)}`);
      if (!res.ok) return { versions: [], latest: null, latestMajor: null };
      const data = (await res.json()) as {
        versions?: { num: string }[];
        crate?: { max_version?: string; max_stable_version?: string };
      };
      const versions = (data.versions ?? []).map((v) => v.num);
      const latest = data.crate?.max_stable_version ?? data.crate?.max_version ?? versions[0] ?? null;
      return { versions, latest, latestMajor: latest };
    } catch {
      return { versions: [], latest: null, latestMajor: null };
    }
  }
}

function collectCargoDeps(
  doc: Record<string, unknown>,
  lockfile: LockfileInfo,
  dependencies: Dependency[],
  workspacePackage?: string
): void {
  for (const section of ["dependencies", "dev-dependencies", "build-dependencies"]) {
    const table = doc[section];
    if (!table || typeof table !== "object") continue;
    const kind = section === "dependencies" ? "dependencies" : "devDependencies";
    for (const [name, value] of Object.entries(table as Record<string, unknown>)) {
      if (dependencies.some((d) => d.name === name && d.workspacePackage === workspacePackage)) continue;
      let declaredRange = "*";
      if (typeof value === "string") declaredRange = value;
      else if (value && typeof value === "object" && typeof (value as { version?: string }).version === "string") {
        declaredRange = (value as { version: string }).version;
      } else if (value && typeof value === "object" && (value as { path?: string }).path) {
        // path dependency — skip registry analysis
        continue;
      }
      dependencies.push({
        name,
        declaredRange,
        installedVersion: lockfile.resolvedVersions[name],
        kind,
        workspacePackage,
      });
    }
  }
}

/** Expand a Cargo workspace member pattern (`crates/*`, `tools/foo`) to directories. */
function expandWorkspaceMember(projectRoot: string, pattern: string): string[] {
  if (!pattern.includes("*")) {
    const dir = path.join(projectRoot, pattern);
    return fs.existsSync(dir) ? [dir] : [];
  }
  const parts = pattern.split("/");
  const starIdx = parts.indexOf("*");
  if (starIdx === -1) return [];
  const base = path.join(projectRoot, ...parts.slice(0, starIdx));
  if (!fs.existsSync(base)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const rest = parts.slice(starIdx + 1);
    const candidate = path.join(base, entry.name, ...rest);
    if (fs.existsSync(candidate) || rest.length === 0) {
      out.push(rest.length === 0 ? path.join(base, entry.name) : candidate);
    }
  }
  return out;
}
