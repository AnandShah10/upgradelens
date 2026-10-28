import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { ApiAnalyzer } from "../analysis/ApiAnalyzer";
import { DependencyAnalyzer } from "../analysis/DependencyAnalyzer";
import { enrichPeerDependencyChanges, projectDependencyVersionsFrom } from "../analysis/PeerDependencyAnalyzer";
import { ImpactEngine } from "../analysis/ImpactEngine";
import { PythonUsageAnalyzer } from "../analysis/PythonUsageAnalyzer";
import { PythonReExportResolver } from "../analysis/PythonReExportResolver";
import { SimpleUsageAnalyzer, SimpleLanguage } from "../analysis/SimpleUsageAnalyzer";
import { TreeSitterUsageAnalyzer } from "../analysis/TreeSitterUsageAnalyzer";
import { ReExportResolver } from "../analysis/ReExportResolver";
import { RiskScorer } from "../analysis/RiskScorer";
import { classifyChange } from "../analysis/SemverUtil";
import { TypeDeclarationDiffer } from "../analysis/TypeDeclarationDiffer";
import { UsageAnalyzer } from "../analysis/UsageAnalyzer";
import { DemoChangeProvider, DEMO_FROM_VERSION, DEMO_PACKAGE_NAME, DEMO_TO_VERSION } from "../changelog/DemoChangeProvider";
import { GitHubChangeProvider } from "../changelog/GitHubChangeProvider";
import { KnownChangesProvider } from "../changelog/KnownChangesProvider";
import { NpmRegistryChangeProvider } from "../changelog/NpmRegistryChangeProvider";
import { TypeDiffChangeProvider } from "../changelog/TypeDiffChangeProvider";
import { FileUsageSummary } from "../models/DependencyUsage";
import { ImpactReport } from "../models/ImpactFinding";
import { PackageChange } from "../models/PackageChange";
import { PackageManager } from "../package/PackageManager";
import { PackageManagerFactory } from "../package/PackageManagerFactory";
import { CacheService } from "./CacheService";
import { WorkspaceService } from "./WorkspaceService";

export interface SimulationOptions {
  enableChangelogAnalysis: boolean;
  enableTypeAnalysis: boolean;
  enableGitHubReleaseAnalysis: boolean;
  maxFiles: number;
}

export interface SimulationRequest {
  /** Required for real analysis; ignored (may be undefined) for demo mode. */
  workspaceFolder?: vscode.WorkspaceFolder;
  packageName: string;
  fromVersion: string;
  toVersion: string;
  demo?: boolean;
}

export class AnalysisCancelledError extends Error {
  constructor() {
    super("Analysis was cancelled.");
    this.name = "AnalysisCancelledError";
  }
}

/** Ecosystems whose type-declaration diffing (ApiAnalyzer/TypeDeclarationDiffer) applies - JS/TS-only concepts. */
const JS_FAMILY_ECOSYSTEMS = new Set(["npm", "yarn", "pnpm", "bun"]);

/**
 * Top-level orchestrator. Wires together the metadata layer, the usage
 * scanner, the impact engine, and the risk scorer into a single
 * READ-ONLY simulation pass. Never touches package.json / package-lock.json
 * (or requirements.txt / pyproject.toml for Python) - every value used
 * here is read, nothing is written back to the project.
 *
 * Ecosystem-aware: `packageManagerFactory.detect(projectRoot)` determines
 * whether this is an npm-family (JS/TS) or Python/PyPI project, and that
 * decision drives which usage analyzer runs, which source file glob is
 * scanned, and whether JS/TS-specific evidence sources (local/deep type
 * declaration diffing) are attempted at all. Evidence sources that are
 * genuinely ecosystem-agnostic in their own logic - registry metadata
 * diffing, GitHub release scanning, the known-changes database - run
 * unchanged for either ecosystem, using whichever `PackageManager` the
 * factory actually detected (not a hardcoded npm instance), so a Python
 * project's evidence comes from PyPI, not the npm registry.
 */
export class SimulationService {
  private readonly usageAnalyzer = new UsageAnalyzer();
  private readonly pythonUsageAnalyzer = new PythonUsageAnalyzer();
  private readonly simpleUsageAnalyzer = new SimpleUsageAnalyzer();
  private readonly treeSitterUsageAnalyzer = new TreeSitterUsageAnalyzer();
  private readonly impactEngine = new ImpactEngine();
  private readonly riskScorer = new RiskScorer();
  private readonly apiAnalyzer = new ApiAnalyzer();
  private readonly knownChangesProvider = new KnownChangesProvider();
  private readonly demoChangeProvider = new DemoChangeProvider();
  private readonly dependencyAnalyzer: DependencyAnalyzer;
  private readonly packageManagerFactory: PackageManagerFactory;

  constructor(
    /** Used only for demo mode (which needs no registry access) and as the default factory's shared cache. */
    private readonly packageManager: PackageManager,
    private readonly workspaceService: WorkspaceService,
    private readonly extensionPath?: string,
    private readonly cache: CacheService = new CacheService(undefined),
    packageManagerFactory: PackageManagerFactory = new PackageManagerFactory(cache)
  ) {
    this.packageManagerFactory = packageManagerFactory;
    this.dependencyAnalyzer = new DependencyAnalyzer(packageManagerFactory);
  }

  async simulate(
    request: SimulationRequest,
    options: SimulationOptions,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token: vscode.CancellationToken
  ): Promise<ImpactReport> {
    if (!request.demo && !request.workspaceFolder) {
      throw new Error("A workspace folder is required for a non-demo simulation.");
    }

    const start = Date.now();
    const projectRoot = request.workspaceFolder?.uri.fsPath ?? "";
    const degradedReasons: string[] = [];
    let offline = false;

    const checkCancelled = () => {
      if (token.isCancellationRequested) throw new AnalysisCancelledError();
    };

    // Detect which ecosystem this project actually uses - never assume
    // npm just because that's the most common case. Demo mode always
    // uses the bundled JS/TS fixture, so ecosystem detection is skipped.
    const projectPackageManager = request.demo ? this.packageManager : this.packageManagerFactory.detect(projectRoot);
    const ecosystemId = projectPackageManager.id;
    const isJsFamily = JS_FAMILY_ECOSYSTEMS.has(ecosystemId);

    // --- Step 1: package metadata / target resolution ---------------------
    progress.report({ message: "Reading package metadata...", increment: 10 });
    checkCancelled();

    let changes: PackageChange[] = [];

    if (request.demo) {
      changes = await this.demoChangeProvider.getChanges(request.packageName, request.fromVersion, request.toVersion);
    } else {
      const registryProvider = new NpmRegistryChangeProvider(projectPackageManager);
      const gitHubProvider = new GitHubChangeProvider(projectPackageManager, this.cache);

      progress.report({ message: "Resolving target version...", increment: 10 });
      checkCancelled();

      const knownChanges = await this.knownChangesProvider.getChanges(request.packageName, request.fromVersion, request.toVersion);
      changes.push(...knownChanges);

      if (options.enableChangelogAnalysis) {
        try {
          const registryChanges = await registryProvider.getChanges(request.packageName, request.fromVersion, request.toVersion);
          changes.push(...registryChanges);
          if (registryChanges.length === 0) {
            const meta = await projectPackageManager.getVersionMetadata(request.packageName, request.toVersion);
            if (!meta) {
              offline = true;
              degradedReasons.push(
                `Live release metadata for ${request.packageName}@${request.toVersion} is unavailable; showing offline/local analysis only.`
              );
            }
          }
        } catch {
          offline = true;
          degradedReasons.push(`Could not reach the ${ecosystemId === "pypi" ? "PyPI" : "npm"} registry; showing offline/local analysis only.`);
        }
      } else {
        degradedReasons.push("Changelog/registry analysis is disabled in settings; only locally-known changes are shown.");
      }

      // --- GitHub release-notes scan (best-effort, additive) ---------------
      if (options.enableChangelogAnalysis && options.enableGitHubReleaseAnalysis && !offline) {
        try {
          const releaseChanges = await gitHubProvider.getChanges(request.packageName, request.fromVersion, request.toVersion);
          changes.push(...releaseChanges);
        } catch {
          // GitHub is a bonus evidence source - never let it degrade the overall run.
        }
      }

      checkCancelled();

      // --- Type-declaration evidence (JS/TS-family ecosystems only) --------
      // There is no equivalent of npm's bundled/published TypeScript
      // declaration files for Python, so this step is skipped entirely for
      // a Python project rather than attempted and silently finding nothing.
      if (options.enableTypeAnalysis && isJsFamily) {
        changes = this.adjustConfidenceWithLocalTypes(projectRoot, request.packageName, changes);

        if (!offline) {
          try {
            const typeDeclarationDiffer = new TypeDeclarationDiffer(projectPackageManager, this.cache);
            const typeDiffProvider = new TypeDiffChangeProvider(typeDeclarationDiffer);
            const typeDiffChanges = await typeDiffProvider.getChanges(request.packageName, request.fromVersion, request.toVersion);
            changes.push(...typeDiffChanges);
          } catch {
            // Deep type diffing is a corroborating bonus signal, never a hard requirement.
          }
        }
      }

      // --- Peer-dependency conflict enrichment ------------------------------
      try {
        const { dependencies } = await this.dependencyAnalyzer.analyze(projectRoot);
        const projectDependencyVersions = projectDependencyVersionsFrom(dependencies);
        changes = enrichPeerDependencyChanges(changes, projectDependencyVersions);
      } catch {
        // If the manifest can't be re-read here, leave the generic peer-dependency findings as-is.
      }
    }

    // --- Step 2: scan project usage ---------------------------------------
    progress.report({ message: "Scanning project usage...", increment: 30 });
    checkCancelled();

    const usageByFile = request.demo
      ? this.scanDemoFixture(request.packageName)
      : await this.scanUsage(request.workspaceFolder!, request.packageName, options.maxFiles, ecosystemId, token);

    // --- Step 3: compare API surface (folded into changes above) ----------
    progress.report({ message: "Comparing API surface...", increment: 20 });
    checkCancelled();

    // --- Step 4: calculate impact ------------------------------------------
    progress.report({ message: "Calculating impact...", increment: 20 });
    checkCancelled();

    const findings = this.impactEngine.correlate(changes, usageByFile);
    const affectedFiles = this.impactEngine.buildAffectedFiles(findings);
    const migrationChecklist = this.impactEngine.buildMigrationChecklist(findings);
    const versionChangeKind = classifyChange(request.fromVersion, request.toVersion);
    const risk = this.riskScorer.score(findings, affectedFiles, versionChangeKind);

    const summary = {
      affectedFileCount: affectedFiles.length,
      breakingChangeCount: findings.filter((f) => f.category === "removed-api" || f.category === "renamed-api" || f.category === "signature-change").length,
      deprecatedUsageCount: findings.filter((f) => f.category === "deprecated-api").length,
      peerDependencyIssueCount: findings.filter((f) => f.category === "peer-dependency").length,
    };

    progress.report({ message: "Analysis complete", increment: 5 });

    return {
      packageName: request.packageName,
      fromVersion: request.fromVersion,
      toVersion: request.toVersion,
      versionChangeKind,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - start,
      offline,
      degraded: degradedReasons.length > 0,
      degradedReasons,
      summary,
      risk,
      findings,
      affectedFiles,
      migrationChecklist,
    };
  }

  private adjustConfidenceWithLocalTypes(projectRoot: string, packageName: string, changes: PackageChange[]): PackageChange[] {
    const localSymbols = this.apiAnalyzer.findLocalExportedSymbols(projectRoot, packageName);
    if (!localSymbols) return changes; // Types unavailable locally - leave confidence as-is.

    return changes.map((change) => {
      if (!change.symbol) return change;
      const existsLocally = localSymbols.has(change.symbol);
      if (change.kind === "removed-export" && !existsLocally) {
        // The symbol claimed to exist in the "from" version isn't even
        // present in the locally installed types - treat the claim as
        // unverified rather than silently trusting it.
        return { ...change, confidence: Math.min(change.confidence, 0.4) };
      }
      if (change.kind === "removed-export" && existsLocally) {
        return { ...change, confidence: Math.min(1, change.confidence + 0.02) };
      }
      return change;
    });
  }

  private async scanUsage(
    folder: vscode.WorkspaceFolder,
    packageName: string,
    maxFiles: number,
    ecosystemId: string,
    token: vscode.CancellationToken
  ): Promise<FileUsageSummary[]> {
    const uris = await this.workspaceService.findSourceFiles(folder, maxFiles, ecosystemId);

    // Read every file's text up front, keyed by workspace-relative path.
    // For JS/TS, this is what lets ReExportResolver follow a "barrel file"
    // import (`import { x } from "./local"`) to another already-scanned
    // file without any extra disk I/O per hop.
    const fileTextByPath = new Map<string, string>();
    for (const uri of uris) {
      if (token.isCancellationRequested) throw new AnalysisCancelledError();
      try {
        const text = await this.workspaceService.readFileText(uri);
        const relativePath = vscode.workspace.asRelativePath(uri, false).split(path.sep).join("/");
        fileTextByPath.set(relativePath, text);
      } catch {
        // Unreadable file (permissions, binary mis-detected, etc.) - skip, don't fail the whole run.
      }
    }

    const summaries: FileUsageSummary[] = [];

    if (ecosystemId === "pypi") {
      // Follow __init__.py / intermediate-module re-exports the same way
      // JS/TS follows barrel files (bounded, cycle-safe).
      const pythonReExportResolver = new PythonReExportResolver(fileTextByPath);
      for (const [relativePath, text] of fileTextByPath) {
        if (token.isCancellationRequested) throw new AnalysisCancelledError();
        const summary = await this.pythonUsageAnalyzer.analyzeSource(
          text,
          relativePath,
          packageName,
          pythonReExportResolver
        );
        if (summary) summaries.push(summary);
      }
      return summaries;
    }

    const simpleLang: SimpleLanguage | null =
      ecosystemId === "cargo" ? "rust" : ecosystemId === "go" ? "go" : ecosystemId === "maven" ? "java" : null;
    if (simpleLang) {
      for (const [relativePath, text] of fileTextByPath) {
        if (token.isCancellationRequested) throw new AnalysisCancelledError();
        // Kotlin (.kt) shares Java import syntax; use java analyzer path.
        const lang: SimpleLanguage =
          simpleLang === "java" && relativePath.endsWith(".kt") ? "java" : simpleLang;
        // Prefer tree-sitter AST/scope analysis; fall back to regex scanner.
        // (Kotlin has no dedicated WASM grammar here — regex handles .kt imports.)
        let summary =
          relativePath.endsWith(".kt")
            ? this.simpleUsageAnalyzer.analyzeSource(text, relativePath, packageName, "java")
            : await this.treeSitterUsageAnalyzer.analyzeSource(text, relativePath, packageName, lang);
        if (!summary) {
          summary = this.simpleUsageAnalyzer.analyzeSource(text, relativePath, packageName, lang);
        }
        if (summary) summaries.push(summary);
      }
      return summaries;
    }

    const reExportResolver = new ReExportResolver(fileTextByPath);
    for (const [relativePath, text] of fileTextByPath) {
      if (token.isCancellationRequested) throw new AnalysisCancelledError();
      const summary = this.usageAnalyzer.analyzeSource(text, relativePath, packageName, reExportResolver);
      if (summary) summaries.push(summary);
    }
    return summaries;
  }

  /**
   * The demo command doesn't require (or touch) an open project - it reads
   * the small fixture bundled with the extension itself, using the exact
   * same UsageAnalyzer/ImpactEngine/RiskScorer/Webview pipeline as a real
   * analysis so it's a faithful preview, not a separate mock UI.
   */
  private scanDemoFixture(packageName: string): FileUsageSummary[] {
    if (!this.extensionPath) return [];
    const root = path.join(this.extensionPath, "resources", "demo-project");
    const files = [
      path.join("src", "api", "client.ts"),
      path.join("src", "services", "auth.ts"),
      path.join("src", "config.ts"),
      path.join("src", "components", "App.tsx"),
    ];
    const summaries: FileUsageSummary[] = [];
    for (const relativePath of files) {
      const fullPath = path.join(root, relativePath);
      if (!fs.existsSync(fullPath)) continue;
      const text = fs.readFileSync(fullPath, "utf8");
      const summary = this.usageAnalyzer.analyzeSource(text, relativePath.split(path.sep).join("/"), packageName);
      if (summary) summaries.push(summary);
    }
    return summaries;
  }
}

export { DEMO_FROM_VERSION, DEMO_PACKAGE_NAME, DEMO_TO_VERSION };
