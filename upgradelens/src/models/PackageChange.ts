export type PackageChangeKind =
  | "removed-export"
  | "renamed-export"
  | "added-export"
  | "signature-change"
  | "type-change"
  | "deprecated-export"
  | "removed-subpath-export"
  | "peer-dependency-change"
  | "engine-requirement-change"
  | "dependency-change";

export type EvidenceSource =
  | "registry-metadata"
  | "type-declarations"
  | "known-changes-db"
  | "demo-fixture"
  | "release-notes";

/**
 * A single documented or detected change between two versions of a package,
 * independent of whether the current project actually uses the affected API.
 * The ImpactEngine is responsible for correlating these against real usage.
 */
export interface PackageChange {
  kind: PackageChangeKind;
  packageName: string;
  fromVersion: string;
  toVersion: string;
  /** The exported symbol or field this change concerns, if applicable. */
  symbol?: string;
  summary: string;
  detail?: string;
  recommendation?: string;
  /** How confident we are that this change is real and correctly described, 0-1. */
  confidence: number;
  source: EvidenceSource;
  /**
   * For "peer-dependency-change" / "engine-requirement-change": the exact
   * version range now required, so downstream enrichment (e.g. checking it
   * against what the project actually has installed) doesn't have to
   * re-parse the human-readable `summary` text.
   */
  requiredRange?: string;
  /** Direct link to the evidence (a GitHub release page, etc.), if available. */
  sourceUrl?: string;
}

export interface PackageVersionMetadata {
  name: string;
  version: string;
  peerDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
  engines?: Record<string, string>;
  deprecated?: string;
  hasTypes: boolean;
  /** Top-level and subpath export identifiers this version exposes, if known. */
  exportPaths?: string[];
  /** dist.tarball URL for this exact version, used for optional deep type-declaration diffing. */
  tarballUrl?: string;
  /** Repository URL declared in this version's package.json, used to locate GitHub releases. */
  repositoryUrl?: string;
}

/**
 * Pluggable source of package-level change information between two versions.
 * Implementations may consult the npm registry, GitHub releases, a static
 * known-changes database, or (for tests/demo mode) fixed fixtures. The
 * ImpactEngine treats all providers identically.
 */
export interface PackageChangeProvider {
  readonly source: EvidenceSource;
  getChanges(packageName: string, fromVersion: string, toVersion: string): Promise<PackageChange[]>;
}
