import * as fs from "fs";
import * as path from "path";
import { Dependency, DependencyKind } from "../models/Dependency";
import { LockfileInfo } from "./PackageManager";

export const DEPENDENCY_FIELDS: DependencyKind[] = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

export interface PackageJsonShape {
  workspaces?: string[] | { packages?: string[] };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

export class PackageJsonParseError extends Error {
  constructor(public readonly filePath: string, cause: unknown) {
    super(`Could not parse ${filePath} as JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "PackageJsonParseError";
  }
}

export class NoManifestError extends Error {
  constructor(public readonly projectRoot: string) {
    super(`No package.json was found in ${projectRoot}.`);
    this.name = "NoManifestError";
  }
}

export function readPackageJson(manifestPath: string): PackageJsonShape {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (err) {
    throw new PackageJsonParseError(manifestPath, err);
  }
}

export function readDependenciesFromManifest(
  manifest: PackageJsonShape,
  lockfile: LockfileInfo,
  workspacePackage: string | undefined
): Dependency[] {
  const dependencies: Dependency[] = [];
  for (const kind of DEPENDENCY_FIELDS) {
    const bucket = manifest[kind];
    if (!bucket) continue;
    for (const [name, declaredRange] of Object.entries(bucket)) {
      dependencies.push({
        name,
        declaredRange,
        installedVersion: lockfile.resolvedVersions[name],
        kind,
        workspacePackage,
      });
    }
  }
  return dependencies;
}

export function getWorkspacePatterns(manifest: PackageJsonShape): string[] {
  return Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages ?? [];
}

/**
 * Expands workspace glob patterns ("packages/*", "apps/**", or an exact
 * path) into workspace-relative directories that actually contain a
 * package.json. Supports the common single-level "*" and shallow "**"
 * suffixes; negation patterns ("!packages/excluded") are recognized and
 * subtracted from the result, but arbitrary mid-pattern globs are not -
 * this covers the overwhelming majority of real-world workspace configs
 * (identical syntax across npm, yarn, and pnpm's `packages:` field) without
 * pulling in a full glob library.
 */
export function expandWorkspacePatterns(projectRoot: string, patterns: string[]): string[] {
  const includes = patterns.filter((p) => !p.startsWith("!"));
  const excludes = new Set(patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1).replace(/\/?\*+$/, "")));

  const hasPackageJson = (relDir: string) => fs.existsSync(path.join(projectRoot, relDir, "package.json"));

  const results = new Set<string>();

  for (const pattern of includes) {
    if (pattern.endsWith("/**")) {
      const base = pattern.slice(0, -3);
      collectRecursively(projectRoot, base, results, 4);
    } else if (pattern.endsWith("/*")) {
      const base = pattern.slice(0, -2);
      const baseAbs = path.join(projectRoot, base);
      if (!fs.existsSync(baseAbs)) continue;
      for (const entry of fs.readdirSync(baseAbs, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const rel = path.join(base, entry.name);
        if (hasPackageJson(rel)) results.add(rel.split(path.sep).join("/"));
      }
    } else if (hasPackageJson(pattern)) {
      results.add(pattern);
    }
  }

  return Array.from(results)
    .filter((p) => !excludes.has(p))
    .sort();
}

function collectRecursively(projectRoot: string, relBase: string, out: Set<string>, depthRemaining: number): void {
  const absBase = path.join(projectRoot, relBase);
  if (!fs.existsSync(absBase) || depthRemaining <= 0) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absBase, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "node_modules") continue;
    const rel = path.join(relBase, entry.name);
    if (fs.existsSync(path.join(projectRoot, rel, "package.json"))) {
      out.add(rel.split(path.sep).join("/"));
    }
    collectRecursively(projectRoot, rel, out, depthRemaining - 1);
  }
}

/**
 * Reads the root package.json, expands its workspace patterns, and reads
 * every member's package.json too - the part of `readManifest` that's
 * identical regardless of which lockfile format the package manager uses.
 */
export function readManifestDependencies(
  projectRoot: string,
  lockfile: LockfileInfo
): { dependencies: Dependency[]; workspacePatterns: string[]; workspacePackagePaths: string[] } {
  const manifestPath = path.join(projectRoot, "package.json");
  if (!fs.existsSync(manifestPath)) {
    throw new NoManifestError(projectRoot);
  }
  const manifest = readPackageJson(manifestPath);
  const dependencies = readDependenciesFromManifest(manifest, lockfile, undefined);
  const workspacePatterns = getWorkspacePatterns(manifest);
  const workspacePackagePaths = workspacePatterns.length > 0 ? expandWorkspacePatterns(projectRoot, workspacePatterns) : [];

  for (const workspacePath of workspacePackagePaths) {
    const memberManifestPath = path.join(projectRoot, workspacePath, "package.json");
    try {
      const memberManifest = readPackageJson(memberManifestPath);
      dependencies.push(...readDependenciesFromManifest(memberManifest, lockfile, workspacePath));
    } catch {
      // A malformed member package.json shouldn't break the whole workspace analysis.
    }
  }

  dependencies.sort((a, b) => a.name.localeCompare(b.name) || (a.workspacePackage ?? "").localeCompare(b.workspacePackage ?? ""));
  return { dependencies, workspacePatterns, workspacePackagePaths };
}
