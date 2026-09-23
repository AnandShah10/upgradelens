import { AffectedFile, ImpactFinding, RiskAssessment, RiskLevel, RiskReason } from "../models/ImpactFinding";
import { VersionChangeKind } from "./SemverUtil";

const SEVERITY_WEIGHT: Record<ImpactFinding["severity"], number> = {
  critical: 45,
  high: 25,
  medium: 12,
  low: 5,
  info: 1,
};

function levelForScore(score: number): RiskLevel {
  if (score >= 70) return "critical";
  if (score >= 45) return "high";
  if (score >= 20) return "medium";
  if (score > 0) return "low";
  return "safe";
}

/**
 * Turns a set of findings into a single, explainable risk level.
 *
 * The algorithm is intentionally simple and additive rather than a black
 * box: every reason listed in the assessment corresponds directly to a
 * point contribution, so "why is this HIGH risk" always has a concrete
 * answer instead of a hidden formula.
 */
export class RiskScorer {
  score(findings: ImpactFinding[], affectedFiles: AffectedFile[], versionChangeKind: VersionChangeKind): RiskAssessment {
    const reasons: RiskReason[] = [];
    let score = 0;

    if (versionChangeKind === "major") {
      reasons.push({ label: "Major version upgrade", weight: 10 });
      score += 10;
    }

    const bySeverityCount: Record<ImpactFinding["severity"], number> = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 0,
    };
    for (const f of findings) {
      bySeverityCount[f.severity] += 1;
      // Confidence discounts each finding's contribution - a 40%-confidence
      // "potential" finding should move the needle less than a confirmed one.
      const contribution = SEVERITY_WEIGHT[f.severity] * Math.max(0.3, f.confidence);
      score += contribution;
    }

    for (const severity of ["critical", "high", "medium", "low"] as const) {
      const count = bySeverityCount[severity];
      if (count > 0) {
        reasons.push({
          label: `${count} ${severity}-severity finding${count === 1 ? "" : "s"}`,
          weight: Math.round(SEVERITY_WEIGHT[severity] * count),
        });
      }
    }

    if (affectedFiles.length > 0) {
      const fileBonus = Math.min(20, affectedFiles.length * 2);
      score += fileBonus;
      reasons.push({ label: `${affectedFiles.length} file${affectedFiles.length === 1 ? "" : "s"} likely affected`, weight: fileBonus });
    }

    const clamped = Math.max(0, Math.min(100, Math.round(score)));
    const level = levelForScore(clamped);

    if (findings.length === 0) {
      reasons.push({ label: "No evidence of breaking usage detected in this project", weight: 0 });
    }

    return {
      level,
      score: clamped,
      reasons: reasons.sort((a, b) => b.weight - a.weight),
    };
  }
}
