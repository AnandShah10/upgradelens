import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { ImpactReport } from "../models/ImpactFinding";
import { WorkspaceService } from "../services/WorkspaceService";
import { isWebviewMessage } from "./webviewProtocol";

function nonce(): string {
  return crypto.randomBytes(16).toString("hex");
}

/**
 * Manages the single "Dependency Impact Simulator" webview panel. Only one
 * report is shown at a time (re-running Simulate Upgrade replaces the
 * content of the existing panel rather than spawning a new tab), which
 * keeps "Refresh analysis" well-defined.
 */
export class ImpactPanel {
  private static current: ImpactPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly workspaceService = new WorkspaceService();
  private disposed = false;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private folder: vscode.WorkspaceFolder | undefined,
    private report: ImpactReport,
    private readonly onRefreshRequested: (folder: vscode.WorkspaceFolder | undefined, report: ImpactReport) => void
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "upgradelens.impactReport",
      `UpgradeLens: ${report.packageName}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "out", "ui", "webview")],
      }
    );

    this.panel.webview.html = this.renderHtml();
    this.panel.onDidDispose(() => this.dispose(), null, context.subscriptions);
    this.panel.webview.onDidReceiveMessage((raw) => this.handleMessage(raw), null, context.subscriptions);
  }

  static show(context: vscode.ExtensionContext, folder: vscode.WorkspaceFolder | undefined, report: ImpactReport): void {
    if (ImpactPanel.current) {
      ImpactPanel.current.update(folder, report);
      ImpactPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    ImpactPanel.current = new ImpactPanel(context, folder, report, (f, r) => ImpactPanel.requestRefreshHandler?.(f, r));
  }

  /** Set by extension.ts so "Refresh analysis" (and the Refresh command) can re-run the same simulation. */
  static requestRefreshHandler: ((folder: vscode.WorkspaceFolder | undefined, report: ImpactReport) => void) | undefined;

  static getLastReport(): { folder: vscode.WorkspaceFolder | undefined; report: ImpactReport } | undefined {
    if (!ImpactPanel.current) return undefined;
    return { folder: ImpactPanel.current.folder, report: ImpactPanel.current.report };
  }

  private update(folder: vscode.WorkspaceFolder | undefined, report: ImpactReport): void {
    this.folder = folder;
    this.report = report;
    this.panel.title = `UpgradeLens: ${report.packageName}`;
    this.panel.webview.html = this.renderHtml();
  }

  private dispose(): void {
    this.disposed = true;
    if (ImpactPanel.current === this) ImpactPanel.current = undefined;
  }

  private renderHtml(): string {
    const webview = this.panel.webview;
    const assetsDir = vscode.Uri.joinPath(this.context.extensionUri, "out", "ui", "webview");
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(assetsDir, "styles.css"));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(assetsDir, "app.js"));
    const templatePath = path.join(this.context.extensionPath, "out", "ui", "webview", "index.html");

    let template: string;
    try {
      template = fs.readFileSync(templatePath, "utf8");
    } catch {
      return `<html><body>UpgradeLens could not load its webview template. Try reinstalling the extension.</body></html>`;
    }

    const n = nonce();
    return template
      .replace(/\{\{cspSource\}\}/g, webview.cspSource)
      .replace(/\{\{nonce\}\}/g, n)
      .replace(/\{\{styleUri\}\}/g, styleUri.toString())
      .replace(/\{\{scriptUri\}\}/g, scriptUri.toString())
      .replace(/\{\{reportJson\}\}/g, JSON.stringify(this.report).replace(/</g, "\\u003c"));
  }

  private async handleMessage(raw: unknown): Promise<void> {
    if (this.disposed) return;
    if (!isWebviewMessage(raw)) {
      // Never trust the webview boundary - a malformed/unexpected message is
      // dropped silently rather than acted on.
      return;
    }

    switch (raw.type) {
      case "open-file": {
        if (!this.folder) {
          vscode.window.showInformationMessage("This report was generated in demo mode; there is no project file to open.");
          return;
        }
        try {
          await this.workspaceService.openLocation(this.folder.uri.fsPath, raw.filePath, raw.line, raw.column);
        } catch {
          vscode.window.showWarningMessage(`Could not open ${raw.filePath} - it may have moved or been deleted since the analysis ran.`);
        }
        return;
      }
      case "copy-checklist": {
        await vscode.env.clipboard.writeText(raw.text);
        vscode.window.showInformationMessage("Migration checklist copied to clipboard.");
        return;
      }
      case "refresh":
      case "export-report": {
        if (raw.type === "export-report") {
          await vscode.env.clipboard.writeText(JSON.stringify(this.report, null, 2));
          vscode.window.showInformationMessage("Impact report JSON copied to clipboard.");
          return;
        }
        this.onRefreshRequested(this.folder, this.report);
        return;
      }
    }
  }
}
