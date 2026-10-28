import { EvidenceSource, PackageChange, PackageChangeProvider } from "../models/PackageChange";

export const DEMO_PACKAGE_NAME = "demo-package";
export const DEMO_FROM_VERSION = "1.4.0";
export const DEMO_TO_VERSION = "2.0.0";

/**
 * Fixed, deterministic change set for "demo-package" 1.4.0 -> 2.0.0. Used
 * by the "Run Demo Simulation" command and by tests, so both exercise the
 * exact same ImpactEngine/RiskScorer/Webview code paths as a real analysis -
 * only the data source differs.
 */
export class DemoChangeProvider implements PackageChangeProvider {
  readonly source: EvidenceSource = "demo-fixture";

  async getChanges(packageName: string, fromVersion: string, toVersion: string): Promise<PackageChange[]> {
    if (packageName !== DEMO_PACKAGE_NAME) return [];
    return [
      {
        kind: "removed-export",
        packageName,
        fromVersion,
        toVersion,
        symbol: "oldApi",
        summary: "`oldApi` was removed in demo-package 2.0.0.",
        detail: "oldApi(path: string) => Promise<Response> was the primary request helper in 1.x.",
        recommendation: "Replace oldApi() with the new request() API and review the migration guide.",
        confidence: 0.98,
        source: this.source,
      },
      {
        kind: "renamed-export",
        packageName,
        fromVersion,
        toVersion,
        symbol: "legacyClient",
        summary: "`legacyClient` was renamed to `client` in demo-package 2.0.0.",
        recommendation: "Update imports of legacyClient to client; the API shape is unchanged.",
        confidence: 0.95,
        source: this.source,
      },
      {
        kind: "type-change",
        packageName,
        fromVersion,
        toVersion,
        symbol: "Config",
        summary: "`Config.timeout` changed type from `number` (milliseconds) to `Duration`.",
        recommendation: "Wrap numeric timeouts with Duration.fromMillis(ms) before passing to Config.",
        confidence: 0.9,
        source: this.source,
      },
      {
        kind: "deprecated-export",
        packageName,
        fromVersion,
        toVersion,
        symbol: "createLegacyConfig",
        summary: "`createLegacyConfig` is deprecated in demo-package 2.0.0 and will be removed in 3.0.0.",
        recommendation: "Migrate to createConfig() ahead of the next major release.",
        confidence: 0.8,
        source: this.source,
      },
    ];
  }
}
