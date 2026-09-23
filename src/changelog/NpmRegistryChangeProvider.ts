import { PackageManager } from "../package/PackageManager";
import { EvidenceSource, PackageChange } from "../models/PackageChange";

/**
 * Derives PackageChange entries purely from registry-published metadata -
 * no changelog parsing, no type declarations. This is real, high-confidence
 * evidence (peerDependencies/engines/deprecated are exact fields from the
 * published package.json for each version) rather than a heuristic.
 */
export class NpmRegistryChangeProvider {
  readonly source: EvidenceSource = "registry-metadata";

  constructor(private readonly packageManager: PackageManager) {}

  async getChanges(packageName: string, fromVersion: string, toVersion: string): Promise<PackageChange[]> {
    const [fromMeta, toMeta] = await Promise.all([
      this.packageManager.getVersionMetadata(packageName, fromVersion),
      this.packageManager.getVersionMetadata(packageName, toVersion),
    ]);
    if (!toMeta) return [];

    const changes: PackageChange[] = [];

    if (toMeta.deprecated) {
      changes.push({
        kind: "deprecated-export",
        packageName,
        fromVersion,
        toVersion,
        summary: `${packageName}@${toVersion} is published as deprecated.`,
        detail: toMeta.deprecated,
        recommendation: "Check the package's README for a recommended replacement before upgrading.",
        confidence: 1,
        source: this.source,
      });
    }

    if (fromMeta) {
      // Peer dependency changes: new/changed required peers are a common
      // source of "works on my machine" upgrade breakage.
      const fromPeers = fromMeta.peerDependencies ?? {};
      const toPeers = toMeta.peerDependencies ?? {};
      const peerNames = new Set([...Object.keys(fromPeers), ...Object.keys(toPeers)]);
      for (const peer of peerNames) {
        const before = fromPeers[peer];
        const after = toPeers[peer];
        if (before === after) continue;
        changes.push({
          kind: "peer-dependency-change",
          packageName,
          fromVersion,
          toVersion,
          symbol: peer,
          summary: after
            ? `Peer dependency "${peer}" requirement changed${before ? ` from "${before}"` : " (newly required)"} to "${after}".`
            : `Peer dependency "${peer}" (previously "${before}") is no longer required.`,
          recommendation: after
            ? `Ensure "${peer}" in your project satisfies "${after}" before upgrading.`
            : undefined,
          requiredRange: after,
          confidence: 1,
          source: this.source,
        });
      }

      // engines.node changes can silently break CI/deploy targets.
      const fromNode = fromMeta.engines?.node;
      const toNode = toMeta.engines?.node;
      if (toNode && toNode !== fromNode) {
        changes.push({
          kind: "engine-requirement-change",
          packageName,
          fromVersion,
          toVersion,
          summary: `Node.js engine requirement changed to "${toNode}"${fromNode ? ` (was "${fromNode}")` : ""}.`,
          recommendation: "Confirm your runtime/CI Node.js version satisfies the new requirement.",
          confidence: 1,
          source: this.source,
        });
      }

      // Export surface (subpath exports) shrinking is a strong breaking signal.
      if (fromMeta.exportPaths && toMeta.exportPaths) {
        const toSet = new Set(toMeta.exportPaths);
        for (const exportPath of fromMeta.exportPaths) {
          if (!toSet.has(exportPath) && exportPath !== packageName) {
            changes.push({
              kind: "removed-subpath-export",
              packageName,
              fromVersion,
              toVersion,
              symbol: exportPath,
              summary: `Subpath export "${exportPath}" was removed.`,
              recommendation: `Update imports of "${exportPath}" to an export path available in ${toVersion}.`,
              confidence: 0.9,
              source: this.source,
            });
          }
        }
      }
    }

    return changes;
  }
}
