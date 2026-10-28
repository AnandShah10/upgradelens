import { DependencyKind } from "../models/Dependency";
import { parseRequirementString } from "./pythonRequirementParser";

export interface PyprojectDependencyEntry {
  name: string;
  declaredRange: string;
  kind: DependencyKind;
}

interface TomlTable {
  [key: string]: unknown;
}

function asTable(value: unknown): TomlTable | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as TomlTable) : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Extracts a version-range string from a Poetry-style dependency value: either a bare string ("^2.28") or an inline table ({version = "^2.28", extras = [...]}). */
function poetryDependencyRange(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const table = asTable(value);
  if (table && typeof table.version === "string") return table.version;
  return table ? "*" : undefined; // present but no explicit version constraint (e.g. path/git dependency)
}

function extractPep621Dependencies(project: TomlTable | undefined): PyprojectDependencyEntry[] {
  if (!project) return [];
  const entries: PyprojectDependencyEntry[] = [];

  for (const reqString of asStringArray(project.dependencies)) {
    const parsed = parseRequirementString(reqString);
    if (parsed) entries.push({ name: parsed.name, declaredRange: parsed.declaredRange, kind: "dependencies" });
  }

  const optionalGroups = asTable(project["optional-dependencies"]);
  if (optionalGroups) {
    for (const groupValue of Object.values(optionalGroups)) {
      for (const reqString of asStringArray(groupValue)) {
        const parsed = parseRequirementString(reqString);
        if (parsed) entries.push({ name: parsed.name, declaredRange: parsed.declaredRange, kind: "optionalDependencies" });
      }
    }
  }

  return entries;
}

function extractPoetryDependencyTable(table: TomlTable | undefined, kind: DependencyKind): PyprojectDependencyEntry[] {
  if (!table) return [];
  const entries: PyprojectDependencyEntry[] = [];
  for (const [name, value] of Object.entries(table)) {
    if (name.toLowerCase() === "python") continue; // Poetry lists the project's own Python version constraint here, not a real dependency.
    const declaredRange = poetryDependencyRange(value);
    if (declaredRange !== undefined) entries.push({ name, declaredRange, kind });
  }
  return entries;
}

function extractPoetryDependencies(poetry: TomlTable | undefined): PyprojectDependencyEntry[] {
  if (!poetry) return [];
  const entries: PyprojectDependencyEntry[] = [];

  entries.push(...extractPoetryDependencyTable(asTable(poetry.dependencies), "dependencies"));
  // Legacy Poetry (<1.2) dev-dependencies table.
  entries.push(...extractPoetryDependencyTable(asTable(poetry["dev-dependencies"]), "devDependencies"));

  // Modern Poetry (>=1.2) dependency groups: [tool.poetry.group.<name>.dependencies].
  const groups = asTable(poetry.group);
  if (groups) {
    for (const [groupName, groupValue] of Object.entries(groups)) {
      const groupTable = asTable(groupValue);
      const kind: DependencyKind = groupName === "dev" ? "devDependencies" : "optionalDependencies";
      entries.push(...extractPoetryDependencyTable(asTable(groupTable?.dependencies), kind));
    }
  }

  return entries;
}

/**
 * Parses a pyproject.toml document (already loaded into a plain object via
 * a TOML library) for dependencies, supporting both:
 * - PEP 621 native format: `[project] dependencies = ["requests>=2.28"]`
 *   and `[project.optional-dependencies]` groups.
 * - Poetry: `[tool.poetry.dependencies]` (a table, not an array - each
 *   entry is `name = "^2.28"` or `name = {version = "^2.28", extras=[...]}`),
 *   plus legacy `[tool.poetry.dev-dependencies]` and modern
 *   `[tool.poetry.group.<name>.dependencies]`.
 *
 * A project could in principle use both styles at once (unusual, but not
 * forbidden) - entries from both are simply combined.
 */
export function parsePyprojectDependencies(doc: unknown): PyprojectDependencyEntry[] {
  const root = asTable(doc);
  if (!root) return [];

  const fromPep621 = extractPep621Dependencies(asTable(root.project));
  const fromPoetry = extractPoetryDependencies(asTable(asTable(root.tool)?.poetry));

  return [...fromPep621, ...fromPoetry];
}
