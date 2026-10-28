import * as vscode from "vscode";
import { DependencyAnalyzer } from "./analysis/DependencyAnalyzer";
import { registerAnalyzeCurrentCommand } from "./commands/analyzeCurrent";
import { registerRefreshCommand } from "./commands/refresh";
import { registerRunDemoCommand } from "./commands/runDemo";
import { registerSimulateUpgradeCommand } from "./commands/simulateUpgrade";
import { NpmPackageManager } from "./package/NpmPackageManager";
import { PackageManagerFactory } from "./package/PackageManagerFactory";
import { CacheService } from "./services/CacheService";
import { SimulationService } from "./services/SimulationService";
import { WorkspaceService } from "./services/WorkspaceService";

export function activate(context: vscode.ExtensionContext): void {
  const config = vscode.workspace.getConfiguration("upgradeLens");
  const registryUrl = config.get<string>("registryUrl", "https://registry.npmjs.org");

  const cacheService = new CacheService(context.globalStorageUri?.fsPath);
  // Used only as SimulationService's demo-mode ecosystem marker (the demo
  // command always analyzes the bundled JS/TS fixture, which needs no real
  // registry access) - every other operation goes through the factory below,
  // which detects the correct ecosystem/registry per actual project.
  const packageManager = new NpmPackageManager(cacheService, registryUrl);
  // Used wherever a project's actual manifest/lockfile needs reading, or a
  // registry lookup needs to happen for a specific project - detects
  // npm/yarn/pnpm/bun/pypi per-project from manifest/lockfile presence.
  const packageManagerFactory = new PackageManagerFactory(cacheService, registryUrl);
  const dependencyAnalyzer = new DependencyAnalyzer(packageManagerFactory);
  const workspaceService = new WorkspaceService();
  const simulationService = new SimulationService(packageManager, workspaceService, context.extensionPath, cacheService, packageManagerFactory);

  context.subscriptions.push(
    registerSimulateUpgradeCommand(context, packageManagerFactory, dependencyAnalyzer, simulationService),
    registerAnalyzeCurrentCommand(context, packageManagerFactory, dependencyAnalyzer, simulationService),
    registerRefreshCommand(context, simulationService),
    registerRunDemoCommand(context, simulationService)
  );
}

export function deactivate(): void {
  // No background timers, watchers, or servers are kept alive by this
  // extension - command registrations and the webview panel are disposed
  // automatically via context.subscriptions.
}

