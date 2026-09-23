import * as fs from "fs";
import * as path from "path";
import { PackageVersionMetadata } from "../models/PackageChange";
import { CacheService } from "../services/CacheService";
import { readManifestDependencies } from "./manifestUtils";
import { NpmRegistryClient } from "./NpmRegistryClient";
import { LockfileInfo, PackageManager, ProjectManifest } from "./PackageManager";

/** Strips `//` and `/* *‍/` comments from JSONC so it can go through JSON.parse. */
function stripJsonComments(text: string): string {
  let result = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        result += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      result += ch;
      if (ch === "\\") {
        result += next;
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      result += ch;
    } else if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
    } else if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
    } else {
      result += ch;
    }
  }
  return result;
}

interface BunLockDoc {
  packages?: Record<string, unknown[] | { version?: string }>;
}

/**
 * Parses the newer, text-based `bun.lock` format (JSONC, the default since
 * Bun 1.1) into a package-name -> resolved-version map. Each entry in
 * `packages` is keyed by name and its value's first array element is a
 * "name@version" resolution string (Bun's own documented layout) or, in
 * some layouts, an object with a `version` field - both are handled.
 *
 * The older binary `bun.lockb` format is intentionally NOT parsed here:
 * reverse-engineering an undocumented binary format without a reference
 * implementation to validate against risks silently producing wrong
 * version numbers, which is worse than not resolving a version at all.
 * When only `bun.lockb` is present, dependencies are still fully detected
 * from package.json - they just fall back to the declared range instead of
 * a lockfile-exact version (see `DependencyAnalyzer`, which already treats
 * a missing lockfile resolution this way for any package manager).
 */
export function parseBunLock(content: string): Record<string, string> {
  const resolvedVersions: Record<string, string> = {};
  let doc: BunLockDoc;
  try {
    doc = JSON.parse(stripJsonComments(content));
  } catch {
    return resolvedVersions;
  }
  if (!doc.packages) return resolvedVersions;

  for (const [name, value] of Object.entries(doc.packages)) {
    let resolution: string | undefined;
    if (Array.isArray(value) && typeof value[0] === "string") {
      resolution = value[0];
    } else if (value && typeof value === "object" && "version" in value) {
      resolution = (value as { version?: string }).version;
    }
    if (!resolution) continue;

    // Resolution strings look like "name@1.2.3" or "@scope/name@1.2.3".
    const atIndex = resolution.startsWith("@") ? resolution.indexOf("@", 1) : resolution.indexOf("@");
    const version = atIndex === -1 ? resolution : resolution.slice(atIndex + 1);
    if (!(name in resolvedVersions) && version) resolvedVersions[name] = version;
  }

  return resolvedVersions;
}

export class BunPackageManager implements PackageManager {
  readonly id = "bun" as const;
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
    const textLockPath = path.join(projectRoot, "bun.lock");
    if (fs.existsSync(textLockPath)) {
      try {
        const content = fs.readFileSync(textLockPath, "utf8");
        return { present: true, fileName: "bun.lock", resolvedVersions: parseBunLock(content) };
      } catch {
        return { present: true, fileName: "bun.lock", resolvedVersions: {} };
      }
    }

    const binaryLockPath = path.join(projectRoot, "bun.lockb");
    if (fs.existsSync(binaryLockPath)) {
      // Binary format - not parsed (see module doc comment). Still report
      // it as present so the UI/report can note that resolution fell back
      // to declared ranges rather than silently looking like no lockfile
      // exists at all.
      return { present: true, fileName: "bun.lockb", resolvedVersions: {} };
    }

    return { present: false, resolvedVersions: {} };
  }

  async getVersionMetadata(packageName: string, version: string): Promise<PackageVersionMetadata | null> {
    return this.registryClient.getVersionMetadata(packageName, version);
  }

  async listVersions(packageName: string): Promise<{ versions: string[]; latest: string | null; latestMajor: string | null }> {
    return this.registryClient.listVersions(packageName);
  }
}
