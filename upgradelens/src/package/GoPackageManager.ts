import * as fs from "fs";
import * as path from "path";
import { Dependency } from "../models/Dependency";
import { PackageVersionMetadata } from "../models/PackageChange";
import { CacheService } from "../services/CacheService";
import { LockfileInfo, PackageManager, ProjectManifest } from "./PackageManager";

/**
 * Go modules package manager: go.mod + go.sum, plus go.work multi-module
 * workspaces. Registry: proxy.golang.org.
 */
export class GoPackageManager implements PackageManager {
  readonly id = "go" as const;

  constructor(private readonly cache: CacheService) {}

  async readManifest(projectRoot: string): Promise<ProjectManifest> {
    const dependencies: Dependency[] = [];
    const lockfile = this.readLockfile(projectRoot);
    const workspacePackagePaths: string[] = [];
    let isWorkspaceRoot = false;
    const workspacePatterns: string[] = [];

    const modRoots = collectGoModuleRoots(projectRoot);
    if (modRoots.length > 1 || (modRoots.length === 1 && modRoots[0] !== projectRoot)) {
      isWorkspaceRoot = fs.existsSync(path.join(projectRoot, "go.work"));
    }

    for (const modRoot of modRoots) {
      const rel =
        modRoot === projectRoot ? undefined : path.relative(projectRoot, modRoot).split(path.sep).join("/");
      if (rel) {
        workspacePackagePaths.push(rel);
        workspacePatterns.push(rel);
      }
      const goMod = path.join(modRoot, "go.mod");
      if (!fs.existsSync(goMod)) continue;
      try {
        parseGoMod(fs.readFileSync(goMod, "utf8"), lockfile, dependencies, rel);
      } catch {
        // skip
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
    // Prefer root go.sum; also merge sums from workspace modules
    const resolvedVersions: Record<string, string> = {};
    let present = false;
    const sumFiles = [path.join(projectRoot, "go.sum")];
    for (const modRoot of collectGoModuleRoots(projectRoot)) {
      const s = path.join(modRoot, "go.sum");
      if (!sumFiles.includes(s)) sumFiles.push(s);
    }
    for (const sumPath of sumFiles) {
      if (!fs.existsSync(sumPath)) continue;
      present = true;
      try {
        for (const line of fs.readFileSync(sumPath, "utf8").split("\n")) {
          const parts = line.trim().split(/\s+/);
          if (parts.length < 2) continue;
          const mod = parts[0];
          const ver = parts[1].replace(/\/go\.mod$/, "");
          if (!(mod in resolvedVersions)) resolvedVersions[mod] = stripGoVersion(ver);
        }
      } catch {
        // skip
      }
    }
    return { present, fileName: present ? "go.sum" : undefined, resolvedVersions };
  }

  async getVersionMetadata(packageName: string, version: string): Promise<PackageVersionMetadata | null> {
    const cacheKey = `go:${packageName}@${version}`;
    const cached = this.cache.get<PackageVersionMetadata>(cacheKey);
    if (cached) return cached;
    try {
      const ver = version.startsWith("v") ? version : `v${version}`;
      const res = await fetch(`https://proxy.golang.org/${packageName}/@v/${ver}.info`);
      if (!res.ok) return null;
      const data = (await res.json()) as { Version?: string };
      const meta: PackageVersionMetadata = {
        name: packageName,
        version: data.Version ?? ver,
        hasTypes: false,
      };
      this.cache.set(cacheKey, meta);
      return meta;
    } catch {
      return null;
    }
  }

  async listVersions(packageName: string): Promise<{ versions: string[]; latest: string | null; latestMajor: string | null }> {
    try {
      const res = await fetch(`https://proxy.golang.org/${packageName}/@v/list`);
      if (!res.ok) return { versions: [], latest: null, latestMajor: null };
      const text = await res.text();
      const versions = text
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
        .reverse();
      const latest = versions[0] ?? null;
      return { versions, latest, latestMajor: latest };
    } catch {
      return { versions: [], latest: null, latestMajor: null };
    }
  }
}

function collectGoModuleRoots(projectRoot: string): string[] {
  const workPath = path.join(projectRoot, "go.work");
  if (fs.existsSync(workPath)) {
    const roots: string[] = [];
    try {
      const text = fs.readFileSync(workPath, "utf8");
      // use ( ./a  ./b ) or single use ./a
      const block = /use\s*\(\s*([\s\S]*?)\)/g;
      for (const m of text.matchAll(block)) {
        for (const line of m[1].split("\n")) {
          const p = line.trim();
          if (!p || p.startsWith("//")) continue;
          const dir = path.resolve(projectRoot, p);
          if (fs.existsSync(path.join(dir, "go.mod"))) roots.push(dir);
        }
      }
      for (const m of text.matchAll(/^use\s+(\S+)/gm)) {
        const dir = path.resolve(projectRoot, m[1]);
        if (fs.existsSync(path.join(dir, "go.mod")) && !roots.includes(dir)) roots.push(dir);
      }
    } catch {
      // fall through
    }
    if (roots.length) return roots;
  }
  if (fs.existsSync(path.join(projectRoot, "go.mod"))) return [projectRoot];
  return [projectRoot];
}

function parseGoMod(
  text: string,
  lockfile: LockfileInfo,
  dependencies: Dependency[],
  workspacePackage?: string
): void {
  const blockRe = /require\s*\(\s*([\s\S]*?)\)/g;
  const singleRe = /^require\s+(\S+)\s+(\S+)/gm;
  for (const m of text.matchAll(blockRe)) {
    for (const line of m[1].split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("//")) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length < 2) continue;
      const name = parts[0];
      if (dependencies.some((d) => d.name === name && d.workspacePackage === workspacePackage)) continue;
      dependencies.push({
        name,
        declaredRange: parts[1],
        installedVersion: lockfile.resolvedVersions[name] ?? stripGoVersion(parts[1]),
        kind: trimmed.includes("// indirect") ? "devDependencies" : "dependencies",
        workspacePackage,
      });
    }
  }
  for (const m of text.matchAll(singleRe)) {
    if (dependencies.some((d) => d.name === m[1] && d.workspacePackage === workspacePackage)) continue;
    dependencies.push({
      name: m[1],
      declaredRange: m[2],
      installedVersion: lockfile.resolvedVersions[m[1]] ?? stripGoVersion(m[2]),
      kind: "dependencies",
      workspacePackage,
    });
  }
}

function stripGoVersion(v: string): string {
  return v.replace(/^v/, "").replace(/\+incompatible$/, "");
}
