import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { PackageVersionMetadata } from "../models/PackageChange";
import { CacheService } from "../services/CacheService";
import { readManifestDependencies } from "./manifestUtils";
import { NpmRegistryClient } from "./NpmRegistryClient";
import { LockfileInfo, PackageManager, ProjectManifest } from "./PackageManager";

/**
 * Splits a yarn.lock "descriptor list" header line into individual
 * requests, handling scoped package names (which themselves contain "@").
 *
 * yarn.lock headers look like:
 *   "lodash@^4.17.0, lodash@^4.17.21:"
 *   "@babel/core@^7.0.0:"
 *   lodash@^4.17.0:            (single, unquoted, no comma)
 */
function parseDescriptors(headerLine: string): { name: string; range: string }[] {
  const withoutColon = headerLine.replace(/:$/, "");
  const parts = withoutColon.split(",").map((p) => p.trim().replace(/^"|"$/g, ""));
  const descriptors: { name: string; range: string }[] = [];
  for (const part of parts) {
    // Find the LAST "@" that isn't part of a leading scope ("@scope/name@range").
    const atIndex = part.startsWith("@") ? part.indexOf("@", 1) : part.indexOf("@");
    if (atIndex === -1) continue;
    descriptors.push({ name: part.slice(0, atIndex), range: part.slice(atIndex + 1) });
  }
  return descriptors;
}

/**
 * Parses a classic (yarn v1) `yarn.lock` file - the simple, widely-used
 * text format consisting of blocks like:
 *
 *   lodash@^4.17.0, lodash@^4.17.21:
 *     version "4.17.21"
 *     resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.21.tgz#..."
 *     integrity sha512-...
 *
 * See `parseYarnBerryLock` below for the newer Yarn Berry (v2+) format.
 */
export function parseYarnLock(content: string): Record<string, string> {
  const resolvedVersions: Record<string, string> = {};
  const lines = content.split("\n");

  let currentDescriptors: { name: string; range: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.startsWith("#")) continue;

    // A block header is unindented and ends with ":".
    if (!/^\s/.test(line) && line.trim().endsWith(":")) {
      currentDescriptors = parseDescriptors(line.trim());
      continue;
    }

    const versionMatch = /^\s+version\s+"?([^"\s]+)"?/.exec(line);
    if (versionMatch && currentDescriptors.length > 0) {
      const version = versionMatch[1];
      for (const { name } of currentDescriptors) {
        // First descriptor block wins if (unusually) a name appears more than once.
        if (!(name in resolvedVersions)) resolvedVersions[name] = version;
      }
    }
  }

  return resolvedVersions;
}

interface YarnBerryEntry {
  version?: string;
}

/** Splits from a scoped name like "@babel/core@npm:^7.20.0" into { name: "@babel/core", protocol: "npm" }. */
function parseBerryDescriptor(descriptor: string): { name: string; protocol: string } | null {
  const trimmed = descriptor.trim();
  const atIndex = trimmed.startsWith("@") ? trimmed.indexOf("@", 1) : trimmed.indexOf("@");
  if (atIndex === -1) return null;
  const name = trimmed.slice(0, atIndex);
  const rest = trimmed.slice(atIndex + 1); // e.g. "npm:^4.17.21" or "workspace:packages/core"
  const colonIndex = rest.indexOf(":");
  const protocol = colonIndex === -1 ? rest : rest.slice(0, colonIndex);
  return { name, protocol };
}

/**
 * Parses a Yarn Berry (v2+) `yarn.lock` file - real YAML, identifiable by
 * its `__metadata:` top-level key. Entries are keyed by one or more
 * comma-separated descriptors like `"lodash@npm:^4.17.0, lodash@npm:^4.17.21"`,
 * each mapping to a block containing (among other fields) the resolved
 * `version`. Only `npm:`-protocol descriptors are resolved here -
 * `workspace:`/`patch:`/`portal:` protocol entries point at local paths or
 * patched variants rather than a plain published registry version, and
 * aren't meaningful for this extension's registry-based version comparison
 * anyway.
 */
export function parseYarnBerryLock(content: string): Record<string, string> {
  const resolvedVersions: Record<string, string> = {};
  let doc: Record<string, YarnBerryEntry> | undefined;
  try {
    doc = yaml.load(content) as Record<string, YarnBerryEntry>;
  } catch {
    return resolvedVersions;
  }
  if (!doc || typeof doc !== "object") return resolvedVersions;

  for (const [key, entry] of Object.entries(doc)) {
    if (key === "__metadata" || !entry?.version) continue;
    for (const descriptor of key.split(",")) {
      const parsed = parseBerryDescriptor(descriptor);
      if (!parsed || parsed.protocol !== "npm") continue;
      if (!(parsed.name in resolvedVersions)) resolvedVersions[parsed.name] = entry.version;
    }
  }

  return resolvedVersions;
}

export class YarnPackageManager implements PackageManager {
  readonly id = "yarn" as const;
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
    const lockPath = path.join(projectRoot, "yarn.lock");
    if (!fs.existsSync(lockPath)) {
      return { present: false, resolvedVersions: {} };
    }
    try {
      const content = fs.readFileSync(lockPath, "utf8");
      if (content.includes("__metadata:")) {
        return { present: true, fileName: "yarn.lock", resolvedVersions: parseYarnBerryLock(content) };
      }
      return { present: true, fileName: "yarn.lock", resolvedVersions: parseYarnLock(content) };
    } catch {
      return { present: true, fileName: "yarn.lock", resolvedVersions: {} };
    }
  }

  async getVersionMetadata(packageName: string, version: string): Promise<PackageVersionMetadata | null> {
    return this.registryClient.getVersionMetadata(packageName, version);
  }

  async listVersions(packageName: string): Promise<{ versions: string[]; latest: string | null; latestMajor: string | null }> {
    return this.registryClient.listVersions(packageName);
  }
}
