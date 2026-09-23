import { PackageChange } from "../models/PackageChange";
import { satisfiesRange } from "./SemverUtil";

export interface ProjectDependencyVersions {
  /** Package name -> best-known concrete version the project currently has (lockfile-resolved, or the declared range's base version). */
  get(name: string): string | undefined;
  has(name: string): boolean;
}

/**
 * Goes beyond "a peer dependency requirement changed" (which
 * `NpmRegistryChangeProvider` already detects from registry metadata alone)
 * to answer the question a developer actually cares about: does *my*
 * project's currently installed version of that peer actually satisfy the
 * new requirement?
 *
 * - Peer satisfied by what's already installed -> the finding is dropped
 *   entirely (nothing actionable to report).
 * - Peer present but its installed version conflicts with the new range ->
 *   kept, upgraded to a high-confidence "CONFLICT" finding.
 * - Peer not installed at all -> kept, flagged as newly required.
 * - Can't be determined (unparseable range/version) -> left as the
 *   original, lower-confidence "requirement changed" finding.
 */
export function enrichPeerDependencyChanges(changes: PackageChange[], projectDependencies: ProjectDependencyVersions): PackageChange[] {
  const result: PackageChange[] = [];

  for (const change of changes) {
    if (change.kind !== "peer-dependency-change" || !change.symbol || !change.requiredRange) {
      result.push(change);
      continue;
    }

    const peerName = change.symbol;
    const installedVersion = projectDependencies.get(peerName);

    if (!projectDependencies.has(peerName)) {
      result.push({
        ...change,
        confidence: 0.85,
        detail: `"${peerName}" is not currently listed among this project's dependencies.`,
        recommendation: `Install "${peerName}" satisfying "${change.requiredRange}" before upgrading, or confirm it's provided by another workspace package.`,
      });
      continue;
    }

    if (!installedVersion) {
      // Peer is declared but we couldn't resolve a concrete version (no lockfile entry, unparseable range) - keep as-is.
      result.push(change);
      continue;
    }

    const satisfied = satisfiesRange(installedVersion, change.requiredRange);

    if (satisfied === true) {
      // No actionable finding - the project already satisfies the new requirement.
      continue;
    }

    if (satisfied === false) {
      result.push({
        ...change,
        summary: `Peer dependency conflict: "${peerName}"@${installedVersion} does not satisfy the required range "${change.requiredRange}".`,
        detail: `${change.packageName}@${change.toVersion} requires "${peerName}" ${change.requiredRange}, but this project has ${peerName}@${installedVersion}.`,
        recommendation: `Upgrade "${peerName}" to satisfy "${change.requiredRange}" before installing this upgrade.`,
        confidence: 0.95,
      });
      continue;
    }

    // satisfied === null: range or installed version wasn't parseable - keep the original, more conservative finding.
    result.push(change);
  }

  return result;
}

export function projectDependencyVersionsFrom(
  dependencies: { name: string; installedVersion?: string; declaredRange: string }[]
): ProjectDependencyVersions {
  const map = new Map<string, string>();
  for (const dep of dependencies) {
    if (map.has(dep.name)) continue;
    const version = dep.installedVersion ?? dep.declaredRange.replace(/^[\^~>=<\s]+/, "");
    map.set(dep.name, version);
  }
  return {
    get: (name) => map.get(name),
    has: (name) => map.has(name),
  };
}
