/**
 * Lightweight Gradle dependency extraction from build.gradle,
 * build.gradle.kts, and version catalogs (gradle/libs.versions.toml).
 */

export interface GradleDependency {
  name: string;
  declaredRange: string;
  kind: "dependencies" | "devDependencies";
}

const STRING_COORD =
  /(implementation|api|compileOnly|runtimeOnly|annotationProcessor|kapt|testImplementation|testCompileOnly|testRuntimeOnly|androidTestImplementation|debugImplementation|releaseImplementation)\s*[+(]?\s*['"]([^'"]+)['"]/g;

const TEST_CONFIGS = new Set([
  "testImplementation",
  "testCompileOnly",
  "testRuntimeOnly",
  "androidTestImplementation",
]);

export function parseGradleBuildScript(source: string): GradleDependency[] {
  const out: GradleDependency[] = [];
  const seen = new Set<string>();
  const cleaned = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

  for (const m of cleaned.matchAll(STRING_COORD)) {
    const config = m[1];
    const coord = m[2].trim();
    if (!coord || coord.startsWith("project(") || coord.includes("$")) continue;
    const parts = coord.split(":");
    if (parts.length < 2) continue;
    const name = `${parts[0]}:${parts[1]}`;
    if (seen.has(name)) continue;
    seen.add(name);
    const kind = TEST_CONFIGS.has(config) ? "devDependencies" : "dependencies";
    out.push({
      name,
      declaredRange: parts.length >= 3 ? parts.slice(2).join(":") : "*",
      kind,
    });
  }

  const namedRe =
    /(implementation|api|testImplementation)\s*\(\s*group\s*=\s*["']([^"']+)["']\s*,\s*name\s*=\s*["']([^"']+)["']\s*(?:,\s*version\s*=\s*["']([^"']+)["'])?\s*\)/g;
  for (const m of cleaned.matchAll(namedRe)) {
    const config = m[1];
    const name = `${m[2]}:${m[3]}`;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      declaredRange: m[4] ?? "*",
      kind: TEST_CONFIGS.has(config) ? "devDependencies" : "dependencies",
    });
  }

  return out;
}

/** Parse gradle/libs.versions.toml into alias -> { name, version }. */
export function parseVersionCatalog(tomlText: string): Map<string, { name: string; version: string }> {
  const result = new Map<string, { name: string; version: string }>();
  const versions: Record<string, string> = {};
  let section = "";
  for (const raw of tomlText.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const sec = /^\[([^\]]+)\]$/.exec(line);
    if (sec) {
      section = sec[1];
      continue;
    }
    if (section === "versions") {
      const m = /^([\w.-]+)\s*=\s*"([^"]+)"/.exec(line);
      if (m) versions[m[1]] = m[2];
    } else if (section === "libraries") {
      const simple = /^([\w.-]+)\s*=\s*"([^"]+)"/.exec(line);
      if (simple) {
        const parts = simple[2].split(":");
        if (parts.length >= 2) {
          const entry = { name: `${parts[0]}:${parts[1]}`, version: parts[2] ?? "*" };
          result.set(simple[1], entry);
          result.set(simple[1].replace(/-/g, "."), entry);
        }
        continue;
      }
      const alias = /^([\w.-]+)\s*=\s*\{(.+)\}\s*$/.exec(line);
      if (alias) {
        const body = alias[2];
        const mod = /module\s*=\s*"([^"]+)"/.exec(body);
        const group = /group\s*=\s*"([^"]+)"/.exec(body);
        const nameF = /name\s*=\s*"([^"]+)"/.exec(body);
        const ver = /version\s*=\s*"([^"]+)"/.exec(body);
        const verRef = /version\.ref\s*=\s*"([^"]+)"/.exec(body);
        const coord = mod ? mod[1] : group && nameF ? `${group[1]}:${nameF[1]}` : null;
        if (!coord) continue;
        const parts = coord.split(":");
        const version = ver?.[1] ?? (verRef ? versions[verRef[1]] ?? "*" : "*");
        const name = parts.length >= 2 ? `${parts[0]}:${parts[1]}` : coord;
        const entry = { name, version };
        result.set(alias[1], entry);
        result.set(alias[1].replace(/-/g, "."), entry);
      }
    }
  }
  return result;
}

/** Resolve libs.xxx references in a Gradle script using a version catalog. */
export function resolveLibsReferences(
  source: string,
  catalog: Map<string, { name: string; version: string }>
): GradleDependency[] {
  const out: GradleDependency[] = [];
  const seen = new Set<string>();
  const cleaned = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  const re =
    /(implementation|api|testImplementation|compileOnly|runtimeOnly)\s*\(\s*libs\.([\w.]+)/g;
  for (const m of cleaned.matchAll(re)) {
    const config = m[1];
    const aliasPath = m[2];
    const candidates = [aliasPath, aliasPath.replace(/\./g, "-"), aliasPath.split(".").pop()!];
    let hit: { name: string; version: string } | undefined;
    for (const c of candidates) {
      hit = catalog.get(c);
      if (hit) break;
    }
    if (!hit || seen.has(hit.name)) continue;
    seen.add(hit.name);
    out.push({
      name: hit.name,
      declaredRange: hit.version,
      kind: TEST_CONFIGS.has(config) ? "devDependencies" : "dependencies",
    });
  }
  return out;
}
