import * as ts from "typescript";
import { inferScriptKind } from "./scriptKind";

export interface NamedReExport {
  kind: "named";
  moduleSpecifier: string;
  exports: { exportedName: string; originalName: string }[];
}

export interface StarReExport {
  kind: "star";
  moduleSpecifier: string;
}

export type ReExportEntry = NamedReExport | StarReExport;

/**
 * Extracts every `export ... from "specifier"` re-export declaration from
 * an already-parsed source file. Re-export syntax is only valid at module
 * top level, so this only needs to look at `sourceFile.statements`
 * directly - no recursive tree walk required.
 *
 * `export * as ns from "specifier"` (a namespace re-export) is
 * intentionally not treated as a pass-through here: it creates a single
 * namespace object (`ns.someExport`), not individual named bindings a
 * `{ someExport }` import elsewhere could destructure directly - so it
 * genuinely doesn't participate in the same kind of chain this resolver
 * follows.
 */
export function findReExports(sourceFile: ts.SourceFile): ReExportEntry[] {
  const out: ReExportEntry[] = [];
  for (const stmt of sourceFile.statements) {
    if (!ts.isExportDeclaration(stmt)) continue;
    if (!stmt.moduleSpecifier || !ts.isStringLiteralLike(stmt.moduleSpecifier)) continue;
    const moduleSpecifier = stmt.moduleSpecifier.text;

    if (!stmt.exportClause) {
      // export * from "specifier";
      out.push({ kind: "star", moduleSpecifier });
    } else if (ts.isNamedExports(stmt.exportClause)) {
      // export { a, b as c } from "specifier";
      const exports = stmt.exportClause.elements.map((el) => ({
        exportedName: el.name.text,
        originalName: el.propertyName ? el.propertyName.text : el.name.text,
      }));
      out.push({ kind: "named", moduleSpecifier, exports });
    }
  }
  return out;
}

const RESOLVABLE_EXTENSIONS = [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mjs", ".cjs"];
const MAX_CHAIN_DEPTH = 6;

function posixDirname(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? "." : p.slice(0, idx);
}

function posixJoinAndNormalize(base: string, specifier: string): string {
  const combined = base === "." ? specifier : `${base}/${specifier}`;
  const segments = combined.split("/");
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

/**
 * Given a project's already-read file contents (keyed by workspace-relative
 * path, forward-slash separated), determines whether a name imported from a
 * *local* module specifier ultimately traces back - through zero or more
 * "barrel file" re-export hops - to a given target package, and if so, what
 * that package's own export name is.
 *
 * Bounded and cycle-safe by construction: depth is capped at
 * `MAX_CHAIN_DEPTH` hops, and each recursive call carries the set of files
 * already visited in the current chain so a circular re-export
 * (A re-exports from B, B re-exports from A) terminates instead of looping
 * forever - both essential given this walks across files a user might have
 * arranged in any shape, unlike single-file analysis where no such cycle is
 * possible.
 *
 * Scope note: `resolveToPackage` follows named re-exports (`export { x }
 * from`) and star re-exports (`export * from`); `export * as ns from`
 * (a namespace re-export) is not followed, since it creates a single
 * namespace object on the far side rather than individual pass-through
 * bindings. On the CONSUMING side, though, a namespace import of a local
 * barrel (`import * as api from "./barrel"; api.oldApi()`) IS resolved:
 * `UsageAnalyzer` calls `resolveToPackage` per `.member` access it
 * discovers, the same way it does for a named barrel import - this class
 * doesn't need to know about that consumer-side member-access detection,
 * it just answers "does this specifier + name trace back to the package".
 */
export class ReExportResolver {
  private readonly reExportCache = new Map<string, ReExportEntry[]>();

  constructor(private readonly fileTextByPath: Map<string, string>) {}

  private getReExports(relativePath: string): ReExportEntry[] {
    const cached = this.reExportCache.get(relativePath);
    if (cached) return cached;

    const text = this.fileTextByPath.get(relativePath);
    if (text === undefined) return [];

    let entries: ReExportEntry[];
    try {
      const sourceFile = ts.createSourceFile(relativePath, text, ts.ScriptTarget.Latest, true, inferScriptKind(relativePath));
      entries = findReExports(sourceFile);
    } catch {
      entries = [];
    }

    this.reExportCache.set(relativePath, entries);
    return entries;
  }

  private resolveLocalPath(fromFile: string, specifier: string): string | null {
    const joined = posixJoinAndNormalize(posixDirname(fromFile), specifier);
    const candidates = [
      joined,
      ...RESOLVABLE_EXTENSIONS.map((ext) => `${joined}${ext}`),
      ...RESOLVABLE_EXTENSIONS.map((ext) => `${joined}/index${ext}`),
    ];
    for (const candidate of candidates) {
      if (this.fileTextByPath.has(candidate)) return candidate;
    }
    return null;
  }

  /**
   * @param fromFile Workspace-relative path of the file containing the import/re-export being resolved.
   * @param specifier The module specifier written in that import/re-export (e.g. "./api-client" or "some-package").
   * @param requestedName The name being imported/re-exported at this hop.
   * @param packageName The target package we're ultimately checking against.
   * @returns The package's own export name if this chain resolves to it, otherwise null.
   */
  resolveToPackage(
    fromFile: string,
    specifier: string,
    requestedName: string,
    packageName: string,
    depth = 0,
    visited: ReadonlySet<string> = new Set()
  ): string | null {
    if (depth > MAX_CHAIN_DEPTH) return null;

    if (specifier === packageName || specifier.startsWith(`${packageName}/`)) {
      return requestedName;
    }

    if (!specifier.startsWith(".")) return null; // some other bare package - not our target, and not a local file to follow

    const resolved = this.resolveLocalPath(fromFile, specifier);
    if (!resolved || visited.has(resolved)) return null;

    const nextVisited = new Set(visited);
    nextVisited.add(resolved);

    for (const entry of this.getReExports(resolved)) {
      if (entry.kind === "named") {
        const match = entry.exports.find((e) => e.exportedName === requestedName);
        if (!match) continue;
        const result = this.resolveToPackage(resolved, entry.moduleSpecifier, match.originalName, packageName, depth + 1, nextVisited);
        if (result) return result;
      } else {
        // Star re-export: the requested name passes through unchanged if the next hop provides it.
        const result = this.resolveToPackage(resolved, entry.moduleSpecifier, requestedName, packageName, depth + 1, nextVisited);
        if (result) return result;
      }
    }

    return null;
  }
}
