export type DependencyKind =
  | "dependencies"
  | "devDependencies"
  | "peerDependencies"
  | "optionalDependencies";

/**
 * A dependency as declared in the project's package.json, before any
 * upgrade simulation is applied.
 */
export interface Dependency {
  name: string;
  /** The raw semver range as written in package.json, e.g. "^4.2.1". */
  declaredRange: string;
  /** The concrete version resolved from the lockfile, when available. */
  installedVersion?: string;
  kind: DependencyKind;
  /**
   * Workspace-relative path to the package.json that declared this
   * dependency, when it comes from a workspace member rather than the
   * project root (e.g. "packages/api"). Undefined for root dependencies.
   */
  workspacePackage?: string;
}

/**
 * The user's chosen upgrade target for a simulation. Never written back
 * to the project - purely an in-memory description of a hypothetical.
 */
export interface UpgradeTarget {
  packageName: string;
  fromVersion: string;
  toVersion: string;
}
