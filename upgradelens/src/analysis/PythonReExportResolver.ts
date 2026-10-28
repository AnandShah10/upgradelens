/**
 * Cross-file re-export resolution for Python, analogous to `ReExportResolver`
 * for JS/TS.
 *
 * Python "barrel" packages commonly re-export third-party symbols from an
 * `__init__.py` (or any intermediate module):
 *
 *   # mypkg/__init__.py
 *   from requests import get, post as http_post
 *
 *   # app.py
 *   from mypkg import get
 *   get("https://example.com")
 *
 * Without following that chain, `app.py` would never be reported as using
 * `requests`. This resolver walks relative (`from .foo import x`) and same-
 * package absolute imports across already-scanned project files, with the
 * same depth/cycle bounds as the JS/TS resolver.
 *
 * Limits (honest):
 * - Only follows imports whose specifier resolves to a file already in the
 *   scanned set (no on-demand disk reads beyond the analysis pass).
 * - Does not execute Python or understand dynamic `__getattr__` re-exports.
 * - Star-imports (`from .mod import *`) pass through only when the target
 *   module itself re-exports a concrete name we are resolving.
 */

export interface PythonNamedReExport {
  kind: "named";
  moduleSpecifier: string;
  /** True when the specifier is package-relative (starts with `.`). */
  isRelative: boolean;
  exports: { exportedName: string; originalName: string }[];
}

export interface PythonStarReExport {
  kind: "star";
  moduleSpecifier: string;
  isRelative: boolean;
}

export type PythonReExportEntry = PythonNamedReExport | PythonStarReExport;

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
 * Extract re-export style imports from a Python source file.
 * Matches:
 *   from .mod import a, b as c
 *   from . import mod
 *   from pkg.sub import x   (absolute - only useful if pkg is in the project)
 *   from requests import get  (third-party - terminal for resolution)
 */
const FROM_IMPORT_RE =
  /^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(\*|\([^)]*\)|[^\n#]+)/gm;

function parseNamedClause(clauseText: string): { localName: string; originalName: string }[] {
  const cleaned = clauseText.replace(/[()]/g, " ").trim();
  if (!cleaned) return [];
  return cleaned
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const asMatch = /^([\w.]+)[ \t]+as[ \t]+(\w+)$/.exec(entry);
      if (asMatch) return { originalName: asMatch[1], localName: asMatch[2] };
      return { originalName: entry, localName: entry };
    });
}

export function findPythonReExports(source: string): PythonReExportEntry[] {
  const out: PythonReExportEntry[] = [];
  for (const m of source.matchAll(FROM_IMPORT_RE)) {
    const moduleSpecifier = m[1];
    const clause = m[2].trim();
    const isRelative = moduleSpecifier.startsWith(".");
    if (clause === "*") {
      out.push({ kind: "star", moduleSpecifier, isRelative });
    } else {
      const exports = parseNamedClause(clause).map((n) => ({
        exportedName: n.localName,
        originalName: n.originalName,
      }));
      if (exports.length > 0) {
        out.push({ kind: "named", moduleSpecifier, isRelative, exports });
      }
    }
  }
  return out;
}

function isPackageSpecifier(moduleText: string, candidates: string[]): boolean {
  return candidates.some((c) => moduleText === c || moduleText.startsWith(`${c}.`));
}

/**
 * Resolve a relative Python import specifier against the importing file's
 * directory, mapping to a workspace-relative path that exists in the scan set.
 *
 * Examples (from `mypkg/api.py`):
 *   `.utils`     -> mypkg/utils.py
 *   `..shared`   -> shared.py (sibling of mypkg)
 *   `.`          -> mypkg/__init__.py
 *   `.sub.mod`   -> mypkg/sub/mod.py
 */
function resolvePythonLocalPath(
  fromFile: string,
  specifier: string,
  fileTextByPath: Map<string, string>
): string | null {
  if (!specifier.startsWith(".")) return null;

  let dots = 0;
  while (dots < specifier.length && specifier[dots] === ".") dots++;
  const remainder = specifier.slice(dots).replace(/^\./, "");
  // dots=1 -> same package (dirname of fromFile)
  // dots=2 -> parent of dirname, etc.
  let base = posixDirname(fromFile);
  for (let i = 1; i < dots; i++) {
    base = posixDirname(base);
  }

  const candidates: string[] = [];
  if (!remainder) {
    // `from . import x` is handled at the export level; `from . import *` targets __init__
    candidates.push(`${base}/__init__.py`);
    if (base !== ".") candidates.push(`${base}.py`);
  } else {
    const joined = base === "." ? remainder.replace(/\./g, "/") : posixJoinAndNormalize(base, remainder.replace(/\./g, "/"));
    candidates.push(`${joined}.py`, `${joined}/__init__.py`);
  }

  for (const c of candidates) {
    if (fileTextByPath.has(c)) return c;
  }
  return null;
}

/**
 * Also try resolving a non-relative specifier as a project-local package path
 * (e.g. `from mypkg.utils import x` when `mypkg/utils.py` is in the scan set).
 */
function resolveProjectAbsolutePath(
  specifier: string,
  fileTextByPath: Map<string, string>
): string | null {
  if (specifier.startsWith(".")) return null;
  const joined = specifier.replace(/\./g, "/");
  const candidates = [`${joined}.py`, `${joined}/__init__.py`];
  for (const c of candidates) {
    if (fileTextByPath.has(c)) return c;
  }
  return null;
}

export class PythonReExportResolver {
  private readonly reExportCache = new Map<string, PythonReExportEntry[]>();

  constructor(private readonly fileTextByPath: Map<string, string>) {}

  private getReExports(relativePath: string): PythonReExportEntry[] {
    const cached = this.reExportCache.get(relativePath);
    if (cached) return cached;
    const text = this.fileTextByPath.get(relativePath);
    const entries = text === undefined ? [] : findPythonReExports(text);
    this.reExportCache.set(relativePath, entries);
    return entries;
  }

  /**
   * @param fromFile Workspace-relative path of the importing file.
   * @param specifier Module specifier from a `from X import Y` in that file.
   * @param importedName The name being imported (local binding's original name).
   * @param packageName Target dependency package name (PyPI name).
   * @param importNameCandidates PyPI→import name candidates (e.g. Pillow→PIL).
   * @returns The package's export name if the chain resolves to the package, else null.
   */
  resolveToPackage(
    fromFile: string,
    specifier: string,
    importedName: string,
    packageName: string,
    importNameCandidates: string[],
    depth = 0,
    visited: Set<string> = new Set()
  ): string | null {
    if (depth > MAX_CHAIN_DEPTH) return null;

    // Terminal: the specifier is the target package itself.
    if (isPackageSpecifier(specifier, importNameCandidates)) {
      return importedName;
    }

    const localPath =
      resolvePythonLocalPath(fromFile, specifier, this.fileTextByPath) ??
      resolveProjectAbsolutePath(specifier, this.fileTextByPath);
    if (!localPath) return null;
    if (visited.has(localPath)) return null;
    visited.add(localPath);

    const entries = this.getReExports(localPath);
    for (const entry of entries) {
      if (entry.kind === "named") {
        for (const exp of entry.exports) {
          if (exp.exportedName !== importedName) continue;
          // This file re-exports `importedName` from `entry.moduleSpecifier`
          // under the original name `exp.originalName`.
          if (isPackageSpecifier(entry.moduleSpecifier, importNameCandidates)) {
            return exp.originalName;
          }
          const deeper = this.resolveToPackage(
            localPath,
            entry.moduleSpecifier,
            exp.originalName,
            packageName,
            importNameCandidates,
            depth + 1,
            visited
          );
          if (deeper) return deeper;
        }
      } else if (entry.kind === "star") {
        // `from .mod import *` — try resolving the same name through that module.
        if (isPackageSpecifier(entry.moduleSpecifier, importNameCandidates)) {
          return importedName;
        }
        const deeper = this.resolveToPackage(
          localPath,
          entry.moduleSpecifier,
          importedName,
          packageName,
          importNameCandidates,
          depth + 1,
          visited
        );
        if (deeper) return deeper;
      }
    }

    // PEP 562 __getattr__ dynamic re-exports (static pattern match only)
    const text = this.fileTextByPath.get(localPath);
    if (text) {
      const dyn = findDynamicGetattrPackages(text);
      for (const mod of dyn) {
        if (isPackageSpecifier(mod, importNameCandidates)) {
          return importedName;
        }
      }
    }

    return null;
  }
}



/**
 * Static detection of PEP 562 module-level `__getattr__` that forwards to a
 * third-party package. We do not execute Python — only match common patterns:
 *
 *   def __getattr__(name):
 *       import requests
 *       return getattr(requests, name)
 *
 *   def __getattr__(name):
 *       from requests import get
 *       ...
 *
 * Returns package import names that the module appears to re-export dynamically.
 */
export function findDynamicGetattrPackages(source: string): string[] {
  const out: string[] = [];
  // Find def __getattr__ ... blocks (indented body until dedent approx)
  const defRe = /^def\s+__getattr__\s*\([^)]*\)\s*:\s*$/gm;
  for (const m of source.matchAll(defRe)) {
    const start = (m.index ?? 0) + m[0].length;
    // Take following indented lines (rough)
    const rest = source.slice(start);
    const bodyLines: string[] = [];
    for (const line of rest.split("\n")) {
      if (line.trim() === "") {
        bodyLines.push(line);
        continue;
      }
      if (/^[ \t]/.test(line)) bodyLines.push(line);
      else break;
    }
    const body = bodyLines.join("\n");
    // import pkg / from pkg import
    for (const im of body.matchAll(/^[ \t]*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm)) {
      const mod = im[1] || im[2];
      if (mod && !mod.startsWith(".")) out.push(mod.split(".")[0]);
    }
    // getattr(pkg, name)
    for (const g of body.matchAll(/getattr\s*\(\s*(\w+)\s*,/g)) {
      out.push(g[1]);
    }
  }
  return [...new Set(out)];
}
