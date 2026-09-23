import { DependencyUsage, FileUsageSummary, SymbolReference } from "../models/DependencyUsage";
import { maskPythonCommentsAndStrings } from "./pythonCommentStringMasker";
import { candidateImportNames } from "./pythonImportNameMap";

/**
 * Usage detection for Python source files.
 *
 * Unlike `UsageAnalyzer` (JS/TS), this is NOT built on a real parser: there
 * is no lightweight, dependency-free Python parser available the way the
 * `typescript` package itself serves as one for JS/TS (a real Python
 * parser would mean a large, likely native-binding dependency - the exact
 * cost/risk tradeoff that was accepted for `typescript` but isn't
 * available equivalently here). Instead, this works over a
 * comment/string-masked version of the source (see
 * `maskPythonCommentsAndStrings`) using regex-based import detection and
 * word-boundary reference search - closer to `UsageAnalyzer`'s pre-AST
 * design than its current one.
 *
 * The concrete consequence: there is NO real scope/shadow analysis here.
 * `def f(requests): requests.get(...)` - a parameter that happens to
 * share a name with an imported package - would be (incorrectly) counted
 * as a usage, something the JS analyzer's real lexical scope tracking
 * correctly rules out. This is a deliberate, disclosed scope limitation,
 * not an oversight.
 *
 * What IS handled correctly:
 * - `import pkg`, `import pkg as alias`, `import pkg.submodule`
 *   (binding the first dotted component, matching real Python semantics),
 *   `from pkg import a, b as c`, `from pkg import (a, b, c)` (including
 *   the multi-line parenthesized form), and `from pkg import *`.
 * - Namespace-style member access (`import pkg; pkg.old_api()`) resolves
 *   to the specific member accessed, mirroring how `UsageAnalyzer` handles
 *   `import * as pkg from "pkg"; pkg.oldApi()` for JS.
 * - PyPI package names that don't match their Python import name (e.g.
 *   `Pillow` -> `PIL`) via `candidateImportNames`.
 * - Comments, string literals, and docstrings never register as usage;
 *   a real call inside an f-string interpolation (`f"{old_api()}"`) does.
 */

interface FromImportMatch {
  line: number;
  endLine: number;
  column: number;
  moduleText: string;
  namedImports: { localName: string; originalName: string }[];
  isStar: boolean;
}

interface BareImportMatch {
  line: number;
  endLine: number;
  column: number;
  moduleText: string;
  localName: string;
}

const FROM_IMPORT_RE = /^[ \t]*from\s+([\w.]+)\s+import\s+(\*|\([^)]*\)|[^\n]+)/gm;
const BARE_IMPORT_RE = /^[ \t]*import\s+([^\n]+)/gm;

function lineAndColumnAt(source: string, index: number): { line: number; column: number } {
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < index; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) {
      line++;
      lastNewline = i;
    }
  }
  return { line, column: index - lastNewline };
}

function isPackageSpecifier(moduleText: string, candidates: string[]): boolean {
  return candidates.some((c) => moduleText === c || moduleText.startsWith(`${c}.`));
}

function firstDottedComponent(moduleText: string): string {
  const dotIndex = moduleText.indexOf(".");
  return dotIndex === -1 ? moduleText : moduleText.slice(0, dotIndex);
}

function parseNamedClause(clauseText: string): { localName: string; originalName: string }[] {
  const cleaned = clauseText.replace(/[()]/g, " ").trim();
  if (!cleaned) return [];
  return cleaned
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const asMatch = /^([\w.]+)\s+as\s+(\w+)$/.exec(entry);
      if (asMatch) return { originalName: asMatch[1], localName: asMatch[2] };
      return { originalName: entry, localName: entry };
    });
}

function findFromImports(maskedSource: string, candidates: string[]): FromImportMatch[] {
  const out: FromImportMatch[] = [];
  for (const m of maskedSource.matchAll(FROM_IMPORT_RE)) {
    const moduleText = m[1];
    if (!isPackageSpecifier(moduleText, candidates)) continue;
    const clause = m[2].trim();
    const startIndex = m.index ?? 0;
    const { line, column } = lineAndColumnAt(maskedSource, startIndex);
    const endLine = lineAndColumnAt(maskedSource, startIndex + m[0].length - 1).line;
    if (clause === "*") {
      out.push({ line, endLine, column, moduleText, namedImports: [], isStar: true });
    } else {
      out.push({ line, endLine, column, moduleText, namedImports: parseNamedClause(clause), isStar: false });
    }
  }
  return out;
}

function findBareImports(maskedSource: string, candidates: string[]): BareImportMatch[] {
  const out: BareImportMatch[] = [];
  for (const m of maskedSource.matchAll(BARE_IMPORT_RE)) {
    const clause = m[1].trim();
    const startIndex = m.index ?? 0;
    const { line, column } = lineAndColumnAt(maskedSource, startIndex);
    const endLine = lineAndColumnAt(maskedSource, startIndex + m[0].length - 1).line;
    for (const rawEntry of clause.split(",")) {
      const entry = rawEntry.trim();
      if (!entry) continue;
      const asMatch = /^([\w.]+)\s+as\s+(\w+)$/.exec(entry);
      const moduleText = asMatch ? asMatch[1] : entry;
      if (!isPackageSpecifier(moduleText, candidates)) continue;
      const localName = asMatch ? asMatch[2] : firstDottedComponent(moduleText);
      out.push({ line, endLine, column, moduleText, localName });
    }
  }
  return out;
}

export class PythonUsageAnalyzer {
  analyzeSource(source: string, filePath: string, packageName: string): FileUsageSummary | null {
    const candidates = candidateImportNames(packageName);
    const maskedSource = maskPythonCommentsAndStrings(source);

    const fromImports = findFromImports(maskedSource, candidates);
    const bareImports = findBareImports(maskedSource, candidates);
    if (fromImports.length === 0 && bareImports.length === 0) return null;

    const usages: DependencyUsage[] = [];
    const importedSymbols = new Set<string>();
    const localNameToExported = new Map<string, string>();
    const namespaceBindings = new Map<string, { line: number; column: number; moduleText: string }>();
    const importLines = new Set<number>();

    for (const fi of fromImports) {
      for (let l = fi.line; l <= fi.endLine; l++) importLines.add(l);
      if (fi.isStar) {
        usages.push({
          packageName,
          filePath,
          line: fi.line,
          column: fi.column,
          importPath: fi.moduleText,
          importedSymbols: [],
          bindingKind: "unknown",
          usageType: "import",
        });
        continue;
      }
      usages.push({
        packageName,
        filePath,
        line: fi.line,
        column: fi.column,
        importPath: fi.moduleText,
        importedSymbols: fi.namedImports.map((n) => n.originalName),
        bindingKind: "named",
        usageType: "import",
      });
      for (const { localName, originalName } of fi.namedImports) {
        importedSymbols.add(originalName);
        localNameToExported.set(localName, originalName);
      }
    }

    for (const bi of bareImports) {
      for (let l = bi.line; l <= bi.endLine; l++) importLines.add(l);
      importedSymbols.add(bi.localName);
      localNameToExported.set(bi.localName, bi.localName);
      namespaceBindings.set(bi.localName, { line: bi.line, column: bi.column, moduleText: bi.moduleText });
      usages.push({
        packageName,
        filePath,
        line: bi.line,
        column: bi.column,
        importPath: bi.moduleText,
        importedSymbols: [bi.localName],
        bindingKind: "namespace",
        usageType: "import",
      });
    }

    const symbolReferences: SymbolReference[] = [];
    const usedSymbols = new Set<string>();

    for (const [localName, exportedName] of localNameToExported) {
      const re = new RegExp(`\\b${localName}\\b`, "g");
      for (const m of maskedSource.matchAll(re)) {
        const { line, column } = lineAndColumnAt(maskedSource, m.index ?? 0);
        if (importLines.has(line)) continue; // skip the import statement's own line
        symbolReferences.push({ symbol: exportedName, filePath, line, column });
        usedSymbols.add(exportedName);
      }
    }

    const addedNamespaceMemberUsages = new Set<string>();
    for (const [localName, info] of namespaceBindings) {
      const memberRe = new RegExp(`\\b${localName}\\.(\\w+)`, "g");
      for (const m of maskedSource.matchAll(memberRe)) {
        const { line, column } = lineAndColumnAt(maskedSource, m.index ?? 0);
        if (importLines.has(line)) continue;
        const member = m[1];
        importedSymbols.add(member);
        usedSymbols.add(member);
        symbolReferences.push({ symbol: member, filePath, line, column });

        const dedupeKey = `${localName}.${member}`;
        if (!addedNamespaceMemberUsages.has(dedupeKey)) {
          addedNamespaceMemberUsages.add(dedupeKey);
          usages.push({
            packageName,
            filePath,
            line: info.line,
            column: info.column,
            importPath: info.moduleText,
            importedSymbols: [member],
            bindingKind: "namespace",
            usageType: "import",
          });
        }
      }
    }

    return { filePath, usages, symbolReferences, importedSymbols, usedSymbols };
  }
}
