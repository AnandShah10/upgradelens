import * as vscode from "vscode";
import { SimulationService } from "../services/SimulationService";
import { ImpactPanel } from "../ui/ImpactPanel";
import { describeError } from "../utils/errorMessages";

export function registerRefreshCommand(context: vscode.ExtensionContext, simulationService: SimulationService): vscode.Disposable {
  const runRefresh = async (folder: vscode.WorkspaceFolder | undefined, previousReport: { packageName: string; fromVersion: string; toVersion: string }) => {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `UpgradeLens: Refreshing ${previousReport.packageName} analysis...`,
        cancellable: true,
      },
      async (progress, token) => {
        try {
          const config = vscode.workspace.getConfiguration("upgradeLens");
          const report = await simulationService.simulate(
            {
              workspaceFolder: folder,
              packageName: previousReport.packageName,
              fromVersion: previousReport.fromVersion,
              toVersion: previousReport.toVersion,
              demo: !folder,
            },
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
  };

  // Wired so the webview's own "Refresh analysis" button re-runs through the same path.
  ImpactPanel.requestRefreshHandler = (folder, report) => {
    void runRefresh(folder, report);
  };

  return vscode.commands.registerCommand("upgradelens.refresh", async () => {
    const last = ImpactPanel.getLastReport();
    if (!last) {
      vscode.window.showInformationMessage('No previous analysis to refresh. Run "UpgradeLens: Simulate Upgrade" first.');
      return;
    }
    await runRefresh(last.folder, last.report);
  });
}
