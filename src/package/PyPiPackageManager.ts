import * as fs from "fs";
import * as path from "path";
import * as toml from "smol-toml";
import { Dependency } from "../models/Dependency";
import { PackageVersionMetadata } from "../models/PackageChange";
import { CacheService } from "../services/CacheService";
import { parsePoetryLock } from "./poetryLockParser";
import { LockfileInfo, PackageManager, ProjectManifest } from "./PackageManager";
import { PyPiRegistryClient } from "./PyPiRegistryClient";
import { parsePyprojectDependencies } from "./pyprojectTomlParser";
import { parseRequirementsTxt } from "./requirementsTxtParser";

/**
 * The Python-ecosystem `PackageManager`. Detected by `PackageManagerFactory`
 * when a project has `requirements.txt`, `pyproject.toml`, or `poetry.lock`
 * and no npm-family lockfile. Supports two manifest styles that commonly
 * coexist or stand alone:
 *
 * - `requirements.txt`: one requirement per line. An exact `==x.y.z` pin
 *   is treated as an already-resolved version (Python projects very
 *   commonly use `pip freeze`-style pinned requirements files as their de
 *   facto lockfile, since there's no single standard Python lockfile the
 *   way `package-lock.json` is for npm).
 * - `pyproject.toml`: both PEP 621 native (`[project] dependencies = [...]`)
 *   and Poetry (`[tool.poetry.dependencies]` and friends) styles, with
 *   `poetry.lock` supplying resolved versions when present.
 *
 * Not supported: Pipfile/Pipfile.lock (a less common, declining format)
 * and PEP 665/pylock.toml (still an emerging standard as of this writing).
 * A project using only those will still have its dependencies partially
 * visible if it also has a requirements.txt or pyproject.toml, but neither
 * is read directly.
 */
export class PyPiPackageManager implements PackageManager {
  readonly id = "pypi" as const;
  private readonly registryClient: PyPiRegistryClient;

  constructor(cache: CacheService, indexUrl?: string) {
    this.registryClient = new PyPiRegistryClient(cache, indexUrl);
  }

  async readManifest(projectRoot: string): Promise<ProjectManifest> {
    const lockfile = this.readLockfile(projectRoot);
    const dependencies: Dependency[] = [];

    const requirementsPath = path.join(projectRoot, "requirements.txt");
    if (fs.existsSync(requirementsPath)) {
      try {
        const entries = parseRequirementsTxt(fs.readFileSync(requirementsPath, "utf8"));
        for (const entry of entries) {
          dependencies.push({
            name: entry.name,
            declaredRange: entry.declaredRange,
            installedVersion: entry.exactVersion ?? lockfile.resolvedVersions[entry.name],
            kind: "dependencies",
          });
        }
      } catch {
        // A malformed requirements.txt shouldn't block analysis of pyproject.toml, if present.
      }
    }

    const pyprojectPath = path.join(projectRoot, "pyproject.toml");
    if (fs.existsSync(pyprojectPath)) {
      try {
        const doc = toml.parse(fs.readFileSync(pyprojectPath, "utf8"));
        for (const entry of parsePyprojectDependencies(doc)) {
          // Skip if requirements.txt already declared this exact dependency, to avoid double-listing
          // in the common case where a project keeps both in sync for different tooling.
          if (dependencies.some((d) => d.name === entry.name && d.kind === entry.kind)) continue;
          dependencies.push({
            name: entry.name,
            declaredRange: entry.declaredRange,
            installedVersion: lockfile.resolvedVersions[entry.name],
            kind: entry.kind,
          });
        }
      } catch {
        // A malformed pyproject.toml shouldn't block analysis of requirements.txt, if present.
      }
    }

    return {
      dependencies: dependencies.sort((a, b) => a.name.localeCompare(b.name)),
      isWorkspaceRoot: false,
      workspacePatterns: [],
      workspacePackagePaths: [],
      lockfile,
    };
  }

  private readLockfile(projectRoot: string): LockfileInfo {
    const lockPath = path.join(projectRoot, "poetry.lock");
    if (!fs.existsSync(lockPath)) {
      return { present: false, resolvedVersions: {} };
    }
    try {
      const doc = toml.parse(fs.readFileSync(lockPath, "utf8"));
      return { present: true, fileName: "poetry.lock", resolvedVersions: parsePoetryLock(doc) };
    } catch {
      return { present: true, fileName: "poetry.lock", resolvedVersions: {} };
    }
  }

  async getVersionMetadata(packageName: string, version: string): Promise<PackageVersionMetadata | null> {
    return this.registryClient.getVersionMetadata(packageName, version);
  }

  async listVersions(packageName: string): Promise<{ versions: string[]; latest: string | null; latestMajor: string | null }> {
    return this.registryClient.listVersions(packageName);
  }
}
