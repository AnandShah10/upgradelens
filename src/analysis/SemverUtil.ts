/**
 * A small, dependency-free semver helper. Deliberately narrow in scope:
 * it supports exactly what the rest of the extension needs (parsing
 * concrete versions, classifying the delta between two versions, and
 * stripping common range prefixes) rather than pulling in the full
 * `semver` package for an MVP.
 */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
  raw: string;
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/;

export class InvalidVersionError extends Error {
  constructor(public readonly value: string) {
    super(`"${value}" is not a valid semantic version (expected e.g. "1.2.3").`);
    this.name = "InvalidVersionError";
  }
}

/** Strips leading range operators like ^, ~, >=, etc. and whitespace. */
export function stripRangePrefix(range: string): string {
  return range.trim().replace(/^[\^~>=<\s]+/, "");
}

export function parseVersion(version: string): ParsedVersion {
  const cleaned = stripRangePrefix(version);
  const match = VERSION_RE.exec(cleaned);
  if (!match) {
    throw new InvalidVersionError(version);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
    raw: cleaned,
  };
}

export function tryParseVersion(version: string): ParsedVersion | null {
  try {
    return parseVersion(version);
  } catch {
    return null;
  }
}

export type VersionChangeKind = "major" | "minor" | "patch" | "prerelease" | "unknown";

export function classifyChange(from: string, to: string): VersionChangeKind {
  const a = tryParseVersion(from);
  const b = tryParseVersion(to);
  if (!a || !b) {
    return "unknown";
  }
  if (a.major !== b.major) return "major";
  if (a.minor !== b.minor) return "minor";
  if (a.patch !== b.patch) return "patch";
  if (a.prerelease !== b.prerelease) return "prerelease";
  return "unknown";
}

/** -1 if a < b, 0 if equal, 1 if a > b. Prerelease versions sort before their release. */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

export function isValidVersion(version: string): boolean {
  return tryParseVersion(version) !== null;
}

interface Comparator {
  op: ">=" | "<=" | ">" | "<" | "=";
  version: ParsedVersion;
}

function parseComparator(token: string): Comparator | null {
  const trimmed = token.trim();
  if (!trimmed || trimmed === "*" || trimmed === "x" || trimmed === "X") return null;

  const opMatch = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(trimmed);
  if (!opMatch) return null;
  const op = (opMatch[1] as Comparator["op"] | undefined) ?? "=";
  const versionText = opMatch[2];

  // "18.x" / "18.*" / "18" -> treat the missing parts as wildcards, which
  // for a bare comparator means "anywhere in that major (.minor)".
  const wildcardMatch = /^(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/.exec(versionText);
  if (wildcardMatch && op === "=") {
    const major = Number(wildcardMatch[1]);
    const minorRaw = wildcardMatch[2];
    if (minorRaw === undefined || /[xX*]/.test(minorRaw)) {
      // Bare major, or "18.x": matches the whole major range - represented
      // as a caret-like AND of two comparators handled by the caller.
      return { op: "=", version: { major, minor: 0, patch: 0, prerelease: null, raw: versionText } };
    }
  }

  const parsed = tryParseVersion(versionText);
  if (!parsed) return null;
  return { op, version: parsed };
}

function compareOp(a: ParsedVersion, op: Comparator["op"], b: ParsedVersion): boolean {
  const cmp = compareVersions(a, b);
  switch (op) {
    case ">=":
      return cmp >= 0;
    case "<=":
      return cmp <= 0;
    case ">":
      return cmp > 0;
    case "<":
      return cmp < 0;
    case "=":
      return cmp === 0;
  }
}

/** Expands a single range clause (no "||") into a list of ANDed comparators. */
function expandClause(clause: string): Comparator[] | null {
  const trimmed = clause.trim();
  if (!trimmed || trimmed === "*") return [];

  if (trimmed.startsWith("^")) {
    const base = tryParseVersion(trimmed);
    if (!base) return null;
    // npm caret semantics: locks the leftmost non-zero component.
    let upper: ParsedVersion;
    if (base.major > 0) {
      upper = { major: base.major + 1, minor: 0, patch: 0, prerelease: null, raw: "" };
    } else if (base.minor > 0) {
      upper = { major: 0, minor: base.minor + 1, patch: 0, prerelease: null, raw: "" };
    } else {
      upper = { major: 0, minor: 0, patch: base.patch + 1, prerelease: null, raw: "" };
    }
    return [
      { op: ">=", version: base },
      { op: "<", version: upper },
    ];
  }

  if (trimmed.startsWith("~")) {
    const base = tryParseVersion(trimmed);
    if (!base) return null;
    const upper: ParsedVersion = { major: base.major, minor: base.minor + 1, patch: 0, prerelease: null, raw: "" };
    return [
      { op: ">=", version: base },
      { op: "<", version: upper },
    ];
  }

  // "18.x" / "18" (bare major, optionally with wildcard minor) -> whole major range.
  const wildcardMajor = /^(\d+)(?:\.[xX*])?$/.exec(trimmed);
  if (wildcardMajor) {
    const major = Number(wildcardMajor[1]);
    return [
      { op: ">=", version: { major, minor: 0, patch: 0, prerelease: null, raw: "" } },
      { op: "<", version: { major: major + 1, minor: 0, patch: 0, prerelease: null, raw: "" } },
    ];
  }

  // Space-separated AND comparators, e.g. ">=16.8.0 <19.0.0".
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const comparators: Comparator[] = [];
  for (const token of tokens) {
    const c = parseComparator(token);
    if (c) comparators.push(c);
  }
  return comparators.length > 0 ? comparators : null;
}

/**
 * Checks whether a concrete version satisfies an npm-style range: caret
 * (^), tilde (~), plain comparators (>=, <=, >, <), bare/wildcard versions
 * (18, 18.x), space-separated AND clauses, and "||" OR clauses. This
 * intentionally covers the common real-world subset rather than the full
 * node-semver grammar (build metadata, complex pre-release precedence,
 * hyphen ranges), which keeps the extension dependency-free.
 */
export function satisfiesRange(version: string, range: string): boolean | null {
  const target = tryParseVersion(version);
  if (!target) return null;
  const clauses = range.split("||");
  let sawParseable = false;

  for (const clause of clauses) {
    const comparators = expandClause(clause);
    if (comparators === null) continue;
    sawParseable = true;
    if (comparators.length === 0) return true; // "*" or empty clause
    if (comparators.every((c) => compareOp(target, c.op, c.version))) return true;
  }

  return sawParseable ? false : null;
}
