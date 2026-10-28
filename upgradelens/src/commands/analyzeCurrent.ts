import * as vscode from "vscode";
import { DependencyAnalyzer } from "../analysis/DependencyAnalyzer";
import { PackageManagerFactory } from "../package/PackageManagerFactory";
import { SimulationService } from "../services/SimulationService";
import { ImpactPanel } from "../ui/ImpactPanel";
import { describeError } from "../utils/errorMessages";

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

/**
 * A lighter-weight entry point than "Simulate Upgrade": lists every
 * dependency with its current version and (when reachable) the latest
 * published version, so a developer can see at a glance which packages are
 * behind before drilling into a specific upgrade simulation.
 */
export function registerAnalyzeCurrentCommand(
  context: vscode.ExtensionContext,
  packageManagerFactory: PackageManagerFactory,
  dependencyAnalyzer: DependencyAnalyzer,
  simulationService: SimulationService
): vscode.Disposable {
  return vscode.commands.registerCommand("upgradelens.analyzeCurrent", async () => {
    const folder = await pickWorkspaceFolder();
    if (!folder) return;

    let dependencies;
    try {
      const result = await dependencyAnalyzer.analyze(folder.uri.fsPath);
      dependencies = result.dependencies;
    } catch (err) {
      vscode.window.showErrorMessage(describeError(err));
      return;
    }

    if (dependencies.length === 0) {
      vscode.window.showInformationMessage("No dependencies were found in this project's manifest.");
      return;
    }

    const packageManager = packageManagerFactory.detect(folder.uri.fsPath);

    const items = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "UpgradeLens: Checking for available upgrades..." },
      async () => {
        return Promise.all(
          dependencies.map(async (dep) => {
            const { latest } = await packageManager.listVersions(dep.name);
            const current = dep.currentVersion ?? dep.declaredRange;
            const isBehind = latest && dep.currentVersion && latest !== dep.currentVersion;
            return {
              label: `${isBehind ? "$(arrow-up)" : "$(check)"} ${dep.name}`,
              description: latest ? `${current} → ${latest}` : current,
              detail: dep.kind,
              dep,
              latest,
            };
          })
        );
      }
    );

    const picked = await vscode.window.showQuickPick(items, {
      title: "UpgradeLens: Current Dependencies",
      placeHolder: "Select a dependency to simulate its upgrade to the latest version",
      matchOnDescription: true,
    });
    if (!picked || !picked.latest) {
      if (picked && !picked.latest) {
        vscode.window.showWarningMessage(`Could not resolve the latest version of "${picked.dep.name}" - the registry may be unreachable.`);
      }
      return;
    }

    const fromVersion = picked.dep.currentVersion ?? picked.dep.declaredRange.replace(/^[\^~>=<\s]+/, "");

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `UpgradeLens: ${picked.dep.name} ${fromVersion} → ${picked.latest}`,
        cancellable: true,
      },
      async (progress, token) => {
        try {
          const config = vscode.workspace.getConfiguration("upgradeLens");
          const report = await simulationService.simulate(
            { workspaceFolder: folder, packageName: picked.dep.name, fromVersion, toVersion: picked.latest as string },
            {
              enableChangelogAnalysis: config.get<boolean>("enableChangelogAnalysis", true),
              enableTypeAnalysis: config.get<boolean>("enableTypeAnalysis", true),
              enableGitHubReleaseAnalysis: config.get<boolean>("enableGitHubReleaseAnalysis", true),
              maxFiles: config.get<number>("maxFiles", 5000),
            },
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
