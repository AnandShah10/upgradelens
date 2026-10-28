import * as fs from "fs";
import * as path from "path";
import { CacheService } from "../services/CacheService";
import { BunPackageManager } from "./BunPackageManager";
import { NpmPackageManager } from "./NpmPackageManager";
import { PackageManager } from "./PackageManager";
import { CargoPackageManager } from "./CargoPackageManager";
import { GoPackageManager } from "./GoPackageManager";
import { MavenPackageManager } from "./MavenPackageManager";
import { PnpmPackageManager } from "./PnpmPackageManager";
import { PyPiPackageManager } from "./PyPiPackageManager";
import { YarnPackageManager } from "./YarnPackageManager";

/**
 * Detects which package manager/ecosystem a project actually uses, purely
 * from manifest/lockfile presence - no network, no invoking a CLI. Every
 * npm-family implementation (npm/yarn/pnpm/bun) shares the same
 * npm-registry-facing behavior via `NpmRegistryClient`; only
 * manifest/lockfile parsing differs, so detection just needs to route to
 * the right one for that part. Python/PyPI is a separate ecosystem
 * entirely (different registry, different manifest formats), detected
 * only when there's no npm-family evidence in the project root.
 *
 * Precedence: bun > pnpm > yarn > npm (npm-family, in order of how
 * distinctive/unlikely-to-appear-by-accident each lockfile is) > Python
 * (poetry.lock > pyproject.toml > requirements.txt) > npm as the final,
 * arbitrary fallback for an unrecognized project root.
 */
export class PackageManagerFactory {
  constructor(private readonly cache: CacheService, private readonly registryUrl?: string, private readonly pypiIndexUrl?: string) {}

  detect(projectRoot: string): PackageManager {
    const has = (fileName: string) => fs.existsSync(path.join(projectRoot, fileName));

    if (has("bun.lock") || has("bun.lockb")) return new BunPackageManager(this.cache, this.registryUrl);
    if (has("pnpm-lock.yaml")) return new PnpmPackageManager(this.cache, this.registryUrl);
    if (has("yarn.lock")) return new YarnPackageManager(this.cache, this.registryUrl);
    if (has("package.json") || has("package-lock.json")) return new NpmPackageManager(this.cache, this.registryUrl);

    if (has("poetry.lock") || has("pyproject.toml") || has("requirements.txt") || has("Pipfile") || has("Pipfile.lock")) {
      return new PyPiPackageManager(this.cache, this.pypiIndexUrl);
    }

    if (has("Cargo.toml") || has("Cargo.lock")) {
      return new CargoPackageManager(this.cache);
    }
    if (has("go.mod")) {
      return new GoPackageManager(this.cache);
    }
    if (has("pom.xml") || has("build.gradle") || has("build.gradle.kts")) {
      return new MavenPackageManager(this.cache);
    }

    // No recognizable manifest of any kind - default to npm, whose error
    // messages ("no package.json found in ...") remain the most likely
    // useful guidance for an unrecognized or empty project root.
    return new NpmPackageManager(this.cache, this.registryUrl);
  }
}
