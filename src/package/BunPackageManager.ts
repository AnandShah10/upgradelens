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
 * Binary `bun.lockb` is parsed via `@hyrious/bun.lockb` (full graph as
 * yarn.lock v1), with a string-pool heuristic fallback for unsupported
 * format versions. Prefer text `bun.lock` when present.
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


/**
 * Parse bun.lockb via @hyrious/bun.lockb (translated from Bun's Zig
 * serializer), which emits yarn.lock v1 text. Falls back to a string-pool
 * heuristic if the binary format version is unsupported.
 */
export function parseBunLockb(buffer: Buffer): Record<string, string> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const { parse } = require("@hyrious/bun.lockb") as { parse: (buf: Uint8Array | ArrayBuffer) => string };
    const yarnText = parse(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
    return parseYarnV1Lock(yarnText);
  } catch {
    return parseBunLockbHeuristic(buffer);
  }
}

function parseYarnV1Lock(text: string): Record<string, string> {
  const resolvedVersions: Record<string, string> = {};
  let currentNames: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().endsWith(":") && line.includes("@")) {
      currentNames = [];
      const nameRe = /"?((?:@[^@",\s]+\/)?[^@",\s]+)@/g;
      for (const m of line.matchAll(nameRe)) currentNames.push(m[1]);
      continue;
    }
    const ver = /^[ \t]+version\s+"([^"]+)"/.exec(line);
    if (ver && currentNames.length) {
      for (const name of currentNames) {
        if (!(name in resolvedVersions)) resolvedVersions[name] = ver[1];
      }
      currentNames = [];
    }
  }
  return resolvedVersions;
}

function parseBunLockbHeuristic(buffer: Buffer): Record<string, string> {
  const resolvedVersions: Record<string, string> = {};
  const text = buffer.toString("latin1");
  const tokenRe = /(?:@[a-zA-Z0-9][\w.-]*\/)?[a-zA-Z0-9][\w.-]*@\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g;
  for (const m of text.matchAll(tokenRe)) {
    const token = m[0];
    const at = token.lastIndexOf("@");
    if (at <= 0) continue;
    const name = token.slice(0, at);
    const version = token.slice(at + 1);
    if (!name || name.length < 2 || version.length < 3) continue;
    if (!(name in resolvedVersions)) resolvedVersions[name] = version;
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
      try {
        const buf = fs.readFileSync(binaryLockPath);
        const resolvedVersions = parseBunLockb(buf);
        return { present: true, fileName: "bun.lockb", resolvedVersions };
      } catch {
        return { present: true, fileName: "bun.lockb", resolvedVersions: {} };
      }
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
