import * as vscode from "vscode";
import { DEMO_FROM_VERSION, DEMO_PACKAGE_NAME, DEMO_TO_VERSION, SimulationService } from "../services/SimulationService";
import { ImpactPanel } from "../ui/ImpactPanel";
import { describeError } from "../utils/errorMessages";

export function registerRunDemoCommand(context: vscode.ExtensionContext, simulationService: SimulationService): vscode.Disposable {
  return vscode.commands.registerCommand("upgradelens.simulateUpgradeDemo", async () => {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `UpgradeLens Demo: ${DEMO_PACKAGE_NAME} ${DEMO_FROM_VERSION} → ${DEMO_TO_VERSION}`,
        cancellable: true,
      },
      async (progress, token) => {
        try {
          const report = await simulationService.simulate(
            { packageName: DEMO_PACKAGE_NAME, fromVersion: DEMO_FROM_VERSION, toVersion: DEMO_TO_VERSION, demo: true },
            { enableChangelogAnalysis: false, enableTypeAnalysis: false, enableGitHubReleaseAnalysis: false, maxFiles: 100 },
            progress,
            token
          );
          ImpactPanel.show(context, undefined, report);
        } catch (err) {
          if (token.isCancellationRequested) return;
          vscode.window.showErrorMessage(describeError(err));
        }
      }
    );
  });
}
