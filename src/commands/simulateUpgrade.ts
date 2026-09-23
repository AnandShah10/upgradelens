import * as vscode from "vscode";
import { DependencyAnalyzer, ResolvedDependency } from "../analysis/DependencyAnalyzer";
import { isValidVersion, stripRangePrefix } from "../analysis/SemverUtil";
import { PackageManagerFactory } from "../package/PackageManagerFactory";
import { SimulationOptions, SimulationService } from "../services/SimulationService";
import { ImpactPanel } from "../ui/ImpactPanel";
import { describeError } from "../utils/errorMessages";

function readOptions(): SimulationOptions {
  const config = vscode.workspace.getConfiguration("upgradeLens");
  return {
    enableChangelogAnalysis: config.get<boolean>("enableChangelogAnalysis", true),
    enableTypeAnalysis: config.get<boolean>("enableTypeAnalysis", true),
    enableGitHubReleaseAnalysis: config.get<boolean>("enableGitHubReleaseAnalysis", true),
    maxFiles: config.get<number>("maxFiles", 5000),
  };
}

async function pickWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage(
      "Open a folder or workspace containing a package.json, requirements.txt, or pyproject.toml before running UpgradeLens."
    );
    return undefined;
  }
  if (folders.length === 1) return folders[0];
  return vscode.window.showWorkspaceFolderPick({ placeHolder: "Select the project to analyze" });
}

async function pickDependency(dependencies: ResolvedDependency[]): Promise<ResolvedDependency | undefined> {
  if (dependencies.length === 0) {
    vscode.window.showInformationMessage("No dependencies were found in this project's manifest.");
    return undefined;
  }

  const items = dependencies.map((dep) => ({
    label: dep.name,
    description: dep.currentVersion ?? dep.declaredRange,
    detail: dep.workspacePackage ? `${dep.kind} · ${dep.workspacePackage}` : dep.kind,
    dep,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title: "UpgradeLens: Select dependency",
    placeHolder: "Select a dependency to simulate an upgrade for",
    matchOnDescription: true,
  });
  return picked?.dep;
}

type TargetChoice = { label: string; description?: string; choiceKind: "latest" | "latest-major" | "specific"; value?: string };

async function pickTargetVersion(packageManagerFactory: PackageManagerFactory, projectRoot: string, dep: ResolvedDependency): Promise<string | undefined> {
  const packageManager = packageManagerFactory.detect(projectRoot);
  const { latest, latestMajor } = await packageManager.listVersions(dep.name);

  const items: TargetChoice[] = [];
  if (latest) items.push({ label: "Latest", description: latest, choiceKind: "latest", value: latest });
  if (latestMajor && latestMajor !== latest) {
    items.push({ label: "Latest major", description: latestMajor, choiceKind: "latest-major", value: latestMajor });
  }
  items.push({ label: "Specific version...", choiceKind: "specific" });

  if (items.length === 1) {
    // Registry was unreachable - go straight to manual input.
    return promptSpecificVersion(dep);
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: `UpgradeLens: Target version for ${dep.name}`,
    placeHolder: dep.currentVersion ? `Currently ${dep.currentVersion}` : "Select a target version",
  });
  if (!picked) return undefined;
  if (picked.choiceKind === "specific") return promptSpecificVersion(dep);
  return picked.value;
}

async function promptSpecificVersion(dep: ResolvedDependency): Promise<string | undefined> {
  const value = await vscode.window.showInputBox({
    title: `UpgradeLens: Enter target version for ${dep.name}`,
    placeHolder: "e.g. 5.0.0",
    validateInput: (v) => (isValidVersion(v) ? undefined : 'Enter a valid semantic version, e.g. "5.0.0".'),
  });
  return value ? stripRangePrefix(value) : undefined;
}

export function registerSimulateUpgradeCommand(
  context: vscode.ExtensionContext,
  packageManagerFactory: PackageManagerFactory,
  dependencyAnalyzer: DependencyAnalyzer,
  simulationService: SimulationService
): vscode.Disposable {
  return vscode.commands.registerCommand("upgradelens.simulateUpgrade", async () => {
    const folder = await pickWorkspaceFolder();
    if (!folder) return;

    let dependencies: ResolvedDependency[];
    try {
      const result = await dependencyAnalyzer.analyze(folder.uri.fsPath);
      dependencies = result.dependencies;
    } catch (err) {
      vscode.window.showErrorMessage(describeError(err));
      return;
    }

    const dep = await pickDependency(dependencies);
    if (!dep) return;

    if (!dep.currentVersion) {
      vscode.window.showWarningMessage(
        `Could not resolve a concrete current version for "${dep.name}" from the declared range "${dep.declaredRange}" or the lockfile. Analysis will proceed using the declared range where possible.`
      );
    }

    const targetVersion = await pickTargetVersion(packageManagerFactory, folder.uri.fsPath, dep);
    if (!targetVersion) return;

    const fromVersion = dep.currentVersion ?? stripRangePrefix(dep.declaredRange);

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `UpgradeLens: ${dep.name} ${fromVersion} → ${targetVersion}`,
        cancellable: true,
      },
      async (progress, token) => {
        try {
          const report = await simulationService.simulate(
            { workspaceFolder: folder, packageName: dep.name, fromVersion, toVersion: targetVersion },
            readOptions(),
            progress,
            token
          );
          ImpactPanel.show(context, folder, report);
        } catch (err) {
          if (token.isCancellationRequested) return;
          vscode.window.showErrorMessage(describeError(err));
        }
      }
    );
  });
}
