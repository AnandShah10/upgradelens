interface PoetryLockPackage {
  name?: string;
  version?: string;
}

interface PoetryLockDoc {
  package?: PoetryLockPackage[];
}

/**
 * Parses a `poetry.lock` file into a package-name -> resolved-version map.
 * The format is a flat array of `[[package]]` TOML tables, each with at
 * least `name` and `version` fields - much simpler than npm's or pnpm's
 * lockfile structures, since Poetry doesn't need to represent multiple
 * hoisting layouts.
 */
export function parsePoetryLock(doc: unknown): Record<string, string> {
  const resolvedVersions: Record<string, string> = {};
  const packages = (doc as PoetryLockDoc | undefined)?.package;
  if (!Array.isArray(packages)) return resolvedVersions;

  for (const pkg of packages) {
    if (pkg?.name && pkg.version && !(pkg.name in resolvedVersions)) {
      resolvedVersions[pkg.name] = pkg.version;
    }
  }

  return resolvedVersions;
}
