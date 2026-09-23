import * as vscode from "vscode";

const SOURCE_GLOBS: Record<string, string> = {
  npm: "**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}",
  yarn: "**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}",
  pnpm: "**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}",
  bun: "**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}",
  pypi: "**/*.py",
};
const DEFAULT_SOURCE_GLOB = SOURCE_GLOBS.npm;

const EXCLUDE_GLOB =
  "**/{node_modules,.git,dist,build,out,coverage,.next,.nuxt,.turbo,.cache," +
  "venv,.venv,env,__pycache__,*.egg-info,.tox,.mypy_cache,.pytest_cache,site-packages}/**";

export class WorkspaceService {
  /**
   * Finds candidate source files in the given workspace folder, respecting
   * a hard cap. `ecosystemId` (a `PackageManager.id`) picks the right file
   * extensions to scan - JS/TS-family ecosystems look for `.ts`/`.js`/etc.,
   * `pypi` looks for `.py`. Defaults to the JS/TS glob for backward
   * compatibility with call sites that don't yet pass an ecosystem.
   */
  async findSourceFiles(folder: vscode.WorkspaceFolder, maxFiles: number, ecosystemId?: string): Promise<vscode.Uri[]> {
    const glob = (ecosystemId && SOURCE_GLOBS[ecosystemId]) || DEFAULT_SOURCE_GLOB;
    const pattern = new vscode.RelativePattern(folder, glob);
    const uris = await vscode.workspace.findFiles(pattern, EXCLUDE_GLOB, maxFiles);
    return uris;
  }

  async readFileText(uri: vscode.Uri): Promise<string> {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString("utf8");
  }

  async openLocation(workspaceRoot: string, relativeFilePath: string, line: number, column: number): Promise<void> {
    const uri = vscode.Uri.joinPath(vscode.Uri.file(workspaceRoot), relativeFilePath);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const zeroBasedLine = Math.max(0, line - 1);
    const zeroBasedColumn = Math.max(0, column - 1);
    const position = new vscode.Position(zeroBasedLine, zeroBasedColumn);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
  }
}
