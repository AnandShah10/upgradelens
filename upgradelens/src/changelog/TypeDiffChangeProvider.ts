import { TypeDeclarationDiffer } from "../analysis/TypeDeclarationDiffer";
import { EvidenceSource, PackageChange, PackageChangeProvider } from "../models/PackageChange";

/**
 * Turns a real two-version TypeScript declaration diff into PackageChange
 * entries. Confidence is set lower than the known-changes-db (0.7 vs.
 * 0.85+) because a symbol disappearing from a regex-extracted export list
 * can also mean it moved to a different declaration file this scan didn't
 * find - it's real, corroborating evidence, not a certainty.
 */
export class TypeDiffChangeProvider implements PackageChangeProvider {
  readonly source: EvidenceSource = "type-declarations";

  constructor(private readonly differ: TypeDeclarationDiffer) {}

  async getChanges(packageName: string, fromVersion: string, toVersion: string): Promise<PackageChange[]> {
    const diff = await this.differ.diffVersions(packageName, fromVersion, toVersion);
    if (!diff) return [];

    return diff.removedSymbols.map((symbol) => ({
      kind: "removed-export" as const,
      packageName,
      fromVersion,
      toVersion,
      symbol,
      summary: `\`${symbol}\` no longer appears in ${packageName}@${toVersion}'s published type declarations.`,
      detail: `Present in ${packageName}@${fromVersion}'s types but not found in ${toVersion}'s.`,
      recommendation: `Confirm whether "${symbol}" was removed, renamed, or moved to a different export path in ${toVersion}.`,
      confidence: 0.7,
      source: this.source,
    }));
  }
}
