import { FileUsageSummary } from "../models/DependencyUsage";
import { AffectedFile, Certainty, FindingCategory, ImpactFinding, Severity } from "../models/ImpactFinding";
import { PackageChange, PackageChangeKind } from "../models/PackageChange";

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

const CATEGORY_BY_KIND: Record<PackageChangeKind, FindingCategory> = {
  "removed-export": "removed-api",
  "renamed-export": "renamed-api",
  "added-export": "unknown",
  "signature-change": "signature-change",
  "type-change": "type-change",
  "deprecated-export": "deprecated-api",
  "removed-subpath-export": "export-change",
  "peer-dependency-change": "peer-dependency",
  "engine-requirement-change": "engine-requirement",
  "dependency-change": "dependency-change",
};

/** Base severity when a change's symbol is NOT found in project usage at all (still surfaced, but quieter). */
const UNUSED_SEVERITY: Partial<Record<PackageChangeKind, Severity>> = {
  "peer-dependency-change": "medium",
  "engine-requirement-change": "medium",
  "deprecated-export": "info",
};

/** Severity when the symbol IS imported and referenced in project code. */
const USED_SEVERITY: Record<PackageChangeKind, Severity> = {
  "removed-export": "critical",
  "renamed-export": "high",
  "added-export": "info",
  "signature-change": "high",
  "type-change": "medium",
  "deprecated-export": "low",
  "removed-subpath-export": "high",
  "peer-dependency-change": "medium",
  "engine-requirement-change": "medium",
  "dependency-change": "low",
};

interface SymbolSite {
  filePath: string;
  line: number;
  column: number;
  /** Whether the file only imports the symbol, or actually references it afterward. */
  referenced: boolean;
}

function findSitesForSymbol(usageByFile: FileUsageSummary[], symbol: string): SymbolSite[] {
  const sites: SymbolSite[] = [];
  for (const file of usageByFile) {
    if (!file.importedSymbols.has(symbol)) continue;
    const usage = file.usages.find((u) => u.importedSymbols.includes(symbol));
    const referenced = file.usedSymbols.has(symbol);
    if (usage) {
      sites.push({ filePath: file.filePath, line: usage.line, column: usage.column, referenced });
    }
  }
  return sites;
}

function certaintyFor(confidence: number, referenced: boolean): Certainty {
  if (referenced && confidence >= 0.85) return "confirmed";
  if (referenced && confidence >= 0.6) return "likely";
  if (confidence >= 0.6) return "potential";
  return "unknown";
}

export class ImpactEngine {
  /**
   * Correlates raw package changes with real project usage. Project-wide
   * changes (peer deps, engine requirements, whole-package deprecation)
   * are surfaced once even if no file is directly implicated; symbol-level
   * changes are only surfaced when the project actually imports (and,
   * ideally, calls) the affected symbol - this is what keeps the report
   * from becoming "the package changed 40 things" noise.
   */
  correlate(changes: PackageChange[], usageByFile: FileUsageSummary[]): ImpactFinding[] {
    const findings: ImpactFinding[] = [];

    for (const change of changes) {
      const category = CATEGORY_BY_KIND[change.kind];

      if (!change.symbol) {
        // Project-wide change with no specific symbol to correlate against.
        const severity = UNUSED_SEVERITY[change.kind] ?? "medium";
        findings.push({
          id: nextId("finding"),
          severity,
          category,
          certainty: change.confidence >= 0.85 ? "confirmed" : "likely",
          packageName: change.packageName,
          title: change.summary,
          description: change.detail ?? change.summary,
          recommendation: change.recommendation,
          confidence: change.confidence,
          sourceUrl: change.sourceUrl,
        });
        continue;
      }

      const sites = findSitesForSymbol(usageByFile, change.symbol);

      if (sites.length === 0) {
        // The project doesn't (visibly) import this symbol. Still worth a
        // quiet, low-severity mention for project-wide-relevant kinds
        // (e.g. deprecations), but skip entirely for narrowly-scoped API
        // changes to avoid "the package changed 40 things" noise.
        if (change.kind === "deprecated-export" || change.kind === "peer-dependency-change" || change.kind === "engine-requirement-change") {
          findings.push({
            id: nextId("finding"),
            severity: UNUSED_SEVERITY[change.kind] ?? "info",
            category,
            certainty: "unknown",
            packageName: change.packageName,
            symbol: change.symbol,
            title: change.summary,
            description: `${change.detail ?? change.summary} No usage of "${change.symbol}" was found in this project, so this may not apply.`,
            recommendation: change.recommendation,
            confidence: Math.min(change.confidence, 0.5),
            sourceUrl: change.sourceUrl,
          });
        }
        continue;
      }

      for (const site of sites) {
        const severity = site.referenced ? USED_SEVERITY[change.kind] : downgrade(USED_SEVERITY[change.kind]);
        const confidence = site.referenced ? change.confidence : change.confidence * 0.7;
        findings.push({
          id: nextId("finding"),
          severity,
          category,
          certainty: certaintyFor(confidence, site.referenced),
          packageName: change.packageName,
          filePath: site.filePath,
          line: site.line,
          column: site.column,
          symbol: change.symbol,
          title: change.summary,
          description: site.referenced
            ? `This API is used directly by the project. ${change.detail ?? ""}`.trim()
            : `"${change.symbol}" is imported here but no direct call/reference was detected in this file. ${change.detail ?? ""}`.trim(),
          recommendation: change.recommendation,
          confidence,
          sourceUrl: change.sourceUrl,
        });
      }
    }

    return findings;
  }

  buildAffectedFiles(findings: ImpactFinding[]): AffectedFile[] {
    const bySeverityRank: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
    const byFile = new Map<string, { severity: Severity; findingIds: string[] }>();

    for (const f of findings) {
      if (!f.filePath) continue;
      const existing = byFile.get(f.filePath);
      if (!existing) {
        byFile.set(f.filePath, { severity: f.severity, findingIds: [f.id] });
      } else {
        existing.findingIds.push(f.id);
        if (bySeverityRank[f.severity] > bySeverityRank[existing.severity]) {
          existing.severity = f.severity;
        }
      }
    }

    return Array.from(byFile.entries())
      .map(([filePath, v]) => ({ filePath, severity: v.severity, findingIds: v.findingIds }))
      .sort((a, b) => bySeverityRank[b.severity] - bySeverityRank[a.severity] || a.filePath.localeCompare(b.filePath));
  }

  buildMigrationChecklist(findings: ImpactFinding[]): string[] {
    const items: string[] = [];
    const seen = new Set<string>();

    const actionable = findings
      .filter((f) => f.recommendation && (f.severity === "critical" || f.severity === "high" || f.severity === "medium"))
      .sort((a, b) => (a.filePath ?? "").localeCompare(b.filePath ?? ""));

    for (const f of actionable) {
      const line = f.filePath ? `${f.recommendation} (${f.filePath}${f.line ? `:${f.line}` : ""})` : f.recommendation!;
      if (seen.has(line)) continue;
      seen.add(line);
      items.push(line);
    }

    const hasPeerIssue = findings.some((f) => f.category === "peer-dependency");
    if (hasPeerIssue) items.push("Resolve peer dependency conflicts before installing the upgrade.");
    const hasEngineIssue = findings.some((f) => f.category === "engine-requirement");
    if (hasEngineIssue) items.push("Confirm your Node.js/runtime version meets the package's updated engine requirement.");

    items.push("Run the test suite after upgrading to catch anything this static analysis could not.");
    return items;
  }
}

function downgrade(severity: Severity): Severity {
  const order: Severity[] = ["critical", "high", "medium", "low", "info"];
  const idx = order.indexOf(severity);
  return order[Math.min(order.length - 1, idx + 1)];
}
