export type UsageType = "import" | "require" | "dynamic-import" | "unknown";

/**
 * A single location in the project where a dependency is referenced,
 * plus (best-effort) the symbols pulled in at that location.
 */
export interface DependencyUsage {
  packageName: string;
  /** Workspace-relative file path. */
  filePath: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column number. */
  column: number;
  /** The exact module specifier used, e.g. "some-package/submodule". */
  importPath: string;
  /** Named symbols imported/required at this site, if statically determinable. */
  importedSymbols: string[];
  /** Whether the import brought in a default export, a namespace, or is a bare side-effect import. */
  bindingKind: "default" | "named" | "namespace" | "side-effect" | "unknown";
  usageType: UsageType;
}

/**
 * A single call/reference of a specific imported symbol found later in the
 * same file - this is what lets the engine say "imported AND used" rather
 * than just "imported".
 */
export interface SymbolReference {
  symbol: string;
  filePath: string;
  line: number;
  column: number;
}

export interface FileUsageSummary {
  filePath: string;
  usages: DependencyUsage[];
  symbolReferences: SymbolReference[];
  /** Union of every symbol imported from the target package in this file. */
  importedSymbols: Set<string>;
  /** Symbols imported from the target package that are also referenced/called in this file. */
  usedSymbols: Set<string>;
}
