import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { PackageVersionMetadata } from "../models/PackageChange";
import { CacheService } from "../services/CacheService";
import { expandWorkspacePatterns, readDependenciesFromManifest, readManifestDependencies, readPackageJson } from "./manifestUtils";
import { NpmRegistryClient } from "./NpmRegistryClient";
import { LockfileInfo, PackageManager, ProjectManifest } from "./PackageManager";

interface PnpmLockfileV6Plus {
  lockfileVersion?: string | number;
  packages?: Record<string, { version?: string; resolution?: unknown }>;
  importers?: Record<string, { dependencies?: Record<string, { version?: string }>; devDependencies?: Record<string, { version?: string }> }>;
}

/**
 * Extracts the bare version out of a pnpm-lock.yaml package key, which
 * (depending on lockfile version) looks like one of:
 *   "/lodash@4.17.21"
 *   "/lodash@4.17.21(peer-dep-suffix)"
 *   "lodash@4.17.21"
 * Scoped packages ("@scope/name@version") are handled by only splitting on
 * the LAST "@" that isn't part of a leading scope.
 */
function parsePackageKey(key: string): { name: string; version: string } | null {
  const withoutLeadingSlash = key.startsWith("/") ? key.slice(1) : key;
  const withoutPeerSuffix = withoutLeadingSlash.replace(/\(.*\)$/, "");
  const atIndex = withoutPeerSuffix.startsWith("@") ? withoutPeerSuffix.indexOf("@", 1) : withoutPeerSuffix.indexOf("@");
  if (atIndex === -1) return null;
  return { name: withoutPeerSuffix.slice(0, atIndex), version: withoutPeerSuffix.slice(atIndex + 1) };
}

/**
 * Parses a `pnpm-lock.yaml` file (a real YAML document - hence the actual
 * YAML parser, unlike the hand-rolled parsers for yarn.lock/bun.lock, which
 * are simpler custom formats) into a package-name -> resolved-version map.
 * Supports both the older `packages:` top-level key layout and, as a
 * fallback, versions embedded directly in `importers:` entries.
 */
export function parsePnpmLock(content: string): Record<string, string> {
  const resolvedVersions: Record<string, string> = {};
  let doc: PnpmLockfileV6Plus;
  try {
    doc = yaml.load(content) as PnpmLockfileV6Plus;
  } catch {
    return resolvedVersions;
  }
  if (!doc || typeof doc !== "object") return resolvedVersions;

  if (doc.packages) {
    for (const key of Object.keys(doc.packages)) {
      const parsed = parsePackageKey(key);
      const explicitVersion = doc.packages[key]?.version;
      if (!parsed) continue;
      const version = explicitVersion ?? parsed.version;
      if (!(parsed.name in resolvedVersions)) resolvedVersions[parsed.name] = version;
    }
  }

  if (doc.importers) {
    for (const importer of Object.values(doc.importers)) {
      for (const bucket of [importer.dependencies, importer.devDependencies]) {
        if (!bucket) continue;
        for (const [name, entry] of Object.entries(bucket)) {
          if (entry?.version && !(name in resolvedVersions)) {
            // pnpm sometimes suffixes the version with a peer-dep hash in parens.
            resolvedVersions[name] = entry.version.replace(/\(.*\)$/, "");
          }
        }
      }
    }
  }

  return resolvedVersions;
}

export class PnpmPackageManager implements PackageManager {
  readonly id = "pnpm" as const;
  private readonly registryClient: NpmRegistryClient;

  constructor(cache: CacheService, registryUrl?: string) {
    this.registryClient = new NpmRegistryClient(cache, registryUrl);
  }

  async readManifest(projectRoot: string): Promise<ProjectManifest> {
    const lockfile = this.readLockfile(projectRoot);
    const { dependencies, workspacePatterns, workspacePackagePaths } = readManifestDependencies(projectRoot, lockfile);

    // pnpm workspaces are declared in pnpm-workspace.yaml, not package.json's
    // "workspaces" field - fold that in too if present and package.json
    // itself didn't already declare workspace patterns.
    if (workspacePatterns.length === 0) {
      const extraPatterns = this.readPnpmWorkspaceYaml(projectRoot);
      if (extraPatterns.length > 0) {
        const extraPaths = expandWorkspacePatterns(projectRoot, extraPatterns);
        for (const workspacePath of extraPaths) {
          try {
            const memberManifest = readPackageJson(path.join(projectRoot, workspacePath, "package.json"));
            dependencies.push(...readDependenciesFromManifest(memberManifest, lockfile, workspacePath));
          } catch {
            // Skip malformed member manifests, same policy as the shared helper.
          }
        }
        return {
          dependencies: dependencies.sort((a, b) => a.name.localeCompare(b.name) || (a.workspacePackage ?? "").localeCompare(b.workspacePackage ?? "")),
          isWorkspaceRoot: true,
          workspacePatterns: extraPatterns,
          workspacePackagePaths: extraPaths,
          lockfile,
        };
      }
    }

    return {
      dependencies,
      isWorkspaceRoot: workspacePatterns.length > 0,
      workspacePatterns,
      workspacePackagePaths,
      lockfile,
    };
  }

  private readPnpmWorkspaceYaml(projectRoot: string): string[] {
    const wsPath = path.join(projectRoot, "pnpm-workspace.yaml");
    if (!fs.existsSync(wsPath)) return [];
    try {
      const doc = yaml.load(fs.readFileSync(wsPath, "utf8")) as { packages?: string[] };
      return Array.isArray(doc?.packages) ? doc.packages : [];
    } catch {
      return [];
    }
  }

  private readLockfile(projectRoot: string): LockfileInfo {
    const lockPath = path.join(projectRoot, "pnpm-lock.yaml");
    if (!fs.existsSync(lockPath)) {
      return { present: false, resolvedVersions: {} };
    }
    try {
      const content = fs.readFileSync(lockPath, "utf8");
      return { present: true, fileName: "pnpm-lock.yaml", resolvedVersions: parsePnpmLock(content) };
    } catch {
      return { present: true, fileName: "pnpm-lock.yaml", resolvedVersions: {} };
    }
  }

  async getVersionMetadata(packageName: string, version: string): Promise<PackageVersionMetadata | null> {
    return this.registryClient.getVersionMetadata(packageName, version);
  }

  async listVersions(packageName: string): Promise<{ versions: string[]; latest: string | null; latestMajor: string | null }> {
    return this.registryClient.listVersions(packageName);
  }
}
