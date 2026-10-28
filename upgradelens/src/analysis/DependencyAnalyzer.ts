import { Dependency } from "../models/Dependency";
import { PackageManagerFactory } from "../package/PackageManagerFactory";
import { ProjectManifest } from "../package/PackageManager";
import { stripRangePrefix, isValidVersion } from "./SemverUtil";

export interface ResolvedDependency extends Dependency {
  /** Best available concrete "current" version: lockfile resolution, else the declared range with operators stripped. */
  currentVersion: string | null;
}

export class DependencyAnalyzer {
  constructor(private readonly packageManagerFactory: PackageManagerFactory) {}

  async analyze(projectRoot: string): Promise<{ manifest: ProjectManifest; dependencies: ResolvedDependency[] }> {
    const packageManager = this.packageManagerFactory.detect(projectRoot);
    const manifest = await packageManager.readManifest(projectRoot);
    const dependencies: ResolvedDependency[] = manifest.dependencies.map((dep) => {
      const candidate = dep.installedVersion ?? stripRangePrefix(dep.declaredRange);
      return { ...dep, currentVersion: isValidVersion(candidate) ? candidate : null };
    });
    return { manifest, dependencies };
  }
}

