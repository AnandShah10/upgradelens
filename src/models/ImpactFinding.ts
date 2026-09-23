export type Severity = "critical" | "high" | "medium" | "low" | "info";

export type FindingCategory =
  | "removed-api"
  | "renamed-api"
  | "signature-change"
  | "type-change"
  | "deprecated-api"
  | "export-change"
  | "peer-dependency"
  | "engine-requirement"
  | "dependency-change"
  | "unknown";

/** How certain we are that this finding reflects reality, in plain language. */
export type Certainty = "confirmed" | "likely" | "potential" | "unknown";

export interface ImpactFinding {
  id: string;
  severity: Severity;
  category: FindingCategory;
  certainty: Certainty;

  packageName: string;
  filePath?: string;
  line?: number;
  column?: number;
  symbol?: string;

  title: string;
  description: string;
  recommendation?: string;
  /** Link to the originating evidence (e.g. a GitHub release page), when available. */
  sourceUrl?: string;

  /** 0-1. Combines evidence quality (was the API actually referenced?) and source confidence. */
  confidence: number;
}

export type RiskLevel = "critical" | "high" | "medium" | "low" | "safe";

export interface RiskReason {
  label: string;
  weight: number;
}

export interface RiskAssessment {
  level: RiskLevel;
  /** 0-100, purely for the progress-bar style visualization. */
  score: number;
  reasons: RiskReason[];
}

export interface AffectedFile {
  filePath: string;
  severity: Severity;
  findingIds: string[];
}

export interface ImpactSummary {
  affectedFileCount: number;
  breakingChangeCount: number;
  deprecatedUsageCount: number;
  peerDependencyIssueCount: number;
}

export interface ImpactReport {
  packageName: string;
  fromVersion: string;
  toVersion: string;
  versionChangeKind: "major" | "minor" | "patch" | "prerelease" | "unknown";

  generatedAt: string;
  durationMs: number;

  offline: boolean;
  degraded: boolean;
  degradedReasons: string[];

  summary: ImpactSummary;
  risk: RiskAssessment;
  findings: ImpactFinding[];
  affectedFiles: AffectedFile[];
  migrationChecklist: string[];
}
