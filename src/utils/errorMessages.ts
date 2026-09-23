import { InvalidVersionError } from "../analysis/SemverUtil";
import { AnalysisCancelledError } from "../services/SimulationService";
import { NoManifestError, PackageJsonParseError } from "../package/NpmPackageManager";

/**
 * Converts a thrown error into a short, actionable message suitable for
 * vscode.window.showErrorMessage - never a bare "Analysis failed."
 */
export function describeError(err: unknown): string {
  if (err instanceof NoManifestError) {
    return `No package.json was found in "${err.projectRoot}". Open a folder that contains a package.json and try again.`;
  }
  if (err instanceof PackageJsonParseError) {
    return `${err.filePath} could not be parsed as JSON. Fix the syntax error and try again.`;
  }
  if (err instanceof InvalidVersionError) {
    return `"${err.value}" is not a valid version (expected e.g. "1.2.3"). Enter a specific semantic version.`;
  }
  if (err instanceof AnalysisCancelledError) {
    return "Analysis was cancelled.";
  }
  if (err instanceof Error) {
    return `${err.message} You can retry the analysis, or disable "Enable Changelog Analysis" in settings to run a fully offline pass.`;
  }
  return "An unexpected error occurred while analyzing the upgrade. You can retry the analysis.";
}
