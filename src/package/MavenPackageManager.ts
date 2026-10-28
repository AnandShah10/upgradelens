import * as fs from "fs";
import * as path from "path";
import { Dependency } from "../models/Dependency";
import { PackageVersionMetadata } from "../models/PackageChange";
import { CacheService } from "../services/CacheService";
import { PackageManager, ProjectManifest } from "./PackageManager";
import { getJson, urlExists } from "../utils/httpJson";
import { parseGradleBuildScript, parseVersionCatalog, resolveLibsReferences } from "./gradleParser";

/**
 * JVM package manager covering Maven (pom.xml) and Gradle (build.gradle /
 * build.gradle.kts). GroupId:artifactId is the package name. Registry
 * lookups use Maven Central. Usage scanning uses SimpleUsageAnalyzer (Java).
 */
export class MavenPackageManager implements PackageManager {
  readonly id = "maven" as const;

  constructor(private readonly cache: CacheService) {}

  async readManifest(projectRoot: string): Promise<ProjectManifest> {
    const dependencies: Dependency[] = [];
    const workspacePackagePaths: string[] = [];
    const rootPom = path.join(projectRoot, "pom.xml");
    const moduleDirs = fs.existsSync(rootPom)
      ? collectMavenModules(projectRoot, rootPom)
      : [projectRoot];
    const isWorkspaceRoot = moduleDirs.length > 1;

    for (const modDir of moduleDirs) {
      const pomPath = path.join(modDir, "pom.xml");
      const rel =
        modDir === projectRoot ? undefined : path.relative(projectRoot, modDir).split(path.sep).join("/");
      if (rel) workspacePackagePaths.push(rel);
      if (!fs.existsSync(pomPath)) continue;
      try {
        const text = fs.readFileSync(pomPath, "utf8");
        const depRe = /<dependency>([\s\S]*?)<\/dependency>/g;
        for (const m of text.matchAll(depRe)) {
          const block = m[1];
          const groupId = tag(block, "groupId");
          const artifactId = tag(block, "artifactId");
          const version = tag(block, "version") ?? "*";
          const scope = tag(block, "scope");
          if (!groupId || !artifactId) continue;
          const name = `${groupId}:${artifactId}`;
          if (dependencies.some((d) => d.name === name && d.workspacePackage === rel)) continue;
          dependencies.push({
            name,
            declaredRange: version,
            installedVersion: version !== "*" ? version : undefined,
            kind: scope === "test" || scope === "provided" ? "devDependencies" : "dependencies",
            workspacePackage: rel,
          });
        }
      } catch {
        // Malformed pom
      }
    }

    // Version catalog (Gradle 7+)
    let catalog = new Map<string, { name: string; version: string }>();
    for (const catalogPath of [
      path.join(projectRoot, "gradle", "libs.versions.toml"),
      path.join(projectRoot, "libs.versions.toml"),
    ]) {
      if (!fs.existsSync(catalogPath)) continue;
      try {
        catalog = parseVersionCatalog(fs.readFileSync(catalogPath, "utf8"));
      } catch {
        // ignore
      }
      break;
    }

    for (const gradleName of ["build.gradle", "build.gradle.kts"]) {
      const gradlePath = path.join(projectRoot, gradleName);
      if (!fs.existsSync(gradlePath)) continue;
      try {
        const src = fs.readFileSync(gradlePath, "utf8");
        for (const entry of parseGradleBuildScript(src)) {
          if (dependencies.some((d) => d.name === entry.name)) continue;
          dependencies.push({
            name: entry.name,
            declaredRange: entry.declaredRange,
            installedVersion: entry.declaredRange !== "*" ? entry.declaredRange : undefined,
            kind: entry.kind,
          });
        }
        if (catalog.size > 0) {
          for (const entry of resolveLibsReferences(src, catalog)) {
            if (dependencies.some((d) => d.name === entry.name)) continue;
            dependencies.push({
              name: entry.name,
              declaredRange: entry.declaredRange,
              installedVersion: entry.declaredRange !== "*" ? entry.declaredRange : undefined,
              kind: entry.kind,
            });
          }
        }
      } catch {
        // Malformed gradle script
      }
    }

    return {
      dependencies: dependencies.sort((a, b) => a.name.localeCompare(b.name)),
      isWorkspaceRoot,
      workspacePatterns: workspacePackagePaths.slice(),
      workspacePackagePaths,
      lockfile: { present: false, resolvedVersions: {} },
    };
  }

  async getVersionMetadata(packageName: string, version: string): Promise<PackageVersionMetadata | null> {
    const [groupId, artifactId] = packageName.split(":");
    if (!groupId || !artifactId) return null;
    const cacheKey = `maven:${packageName}@${version}`;
    const cached = this.cache.get<PackageVersionMetadata>(cacheKey);
    if (cached) return cached;
    try {
      const gPath = groupId.replace(/\./g, "/");
      const exists = await urlExists(
        `https://repo1.maven.org/maven2/${gPath}/${artifactId}/${version}/${artifactId}-${version}.pom`
      );
      if (!exists) return null;
      const meta: PackageVersionMetadata = { name: packageName, version, hasTypes: false };
      this.cache.set(cacheKey, meta);
      return meta;
    } catch {
      return null;
    }
  }

  async listVersions(packageName: string): Promise<{ versions: string[]; latest: string | null; latestMajor: string | null }> {
    const [groupId, artifactId] = packageName.split(":");
    if (!groupId || !artifactId) return { versions: [], latest: null, latestMajor: null };
    try {
      const q = encodeURIComponent(`g:"${groupId}" AND a:"${artifactId}"`);
      const data = await getJson<{ response?: { docs?: { latestVersion?: string; v?: string[] }[] } }>(
        `https://search.maven.org/solrsearch/select?q=${q}&rows=1&wt=json`
      );
      const doc = data.response?.docs?.[0];
      const latest = doc?.latestVersion ?? null;
      const versions = doc?.v?.slice().reverse() ?? (latest ? [latest] : []);
      return { versions, latest, latestMajor: latest };
    } catch {
      return { versions: [], latest: null, latestMajor: null };
    }
  }
}


function collectMavenModules(projectRoot: string, pomPath: string, seen: Set<string> = new Set()): string[] {
  const abs = path.resolve(pomPath);
  if (seen.has(abs)) return [];
  seen.add(abs);
  const out: string[] = [path.dirname(abs)];
  if (!fs.existsSync(pomPath)) return out;
  try {
    const text = fs.readFileSync(pomPath, "utf8");
    const modulesBlock = /<modules>([\s\S]*?)<\/modules>/i.exec(text);
    if (!modulesBlock) return out;
    for (const m of modulesBlock[1].matchAll(/<module>\s*([^<]+?)\s*<\/module>/gi)) {
      const mod = m[1].trim();
      const childPom = path.join(path.dirname(pomPath), mod, "pom.xml");
      out.push(...collectMavenModules(projectRoot, childPom, seen));
    }
  } catch {
    // ignore
  }
  return out;
}

function tag(block: string, name: string): string | null {
  const m = new RegExp(`<${name}>\\s*([^<]+?)\\s*</${name}>`).exec(block);
  return m ? m[1].trim() : null;
}
