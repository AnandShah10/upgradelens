import * as ts from "typescript";
import { DependencyUsage, FileUsageSummary, SymbolReference, UsageType } from "../models/DependencyUsage";
import { inferScriptKind } from "./scriptKind";
import { ReExportResolver } from "./ReExportResolver";

/**
 * AST-based usage detection for JS/TS source files, built on the
 * TypeScript compiler's own parser (`ts.createSourceFile`).
 *
 * This deliberately uses only the *parser*, not a full `ts.Program` with
 * type-checking: creating a type-checked program requires resolving the
 * entire module graph (following every import, reading every file it
 * touches, cross-referencing `node_modules`), which is exactly the kind of
 * unbounded, potentially-slow-on-large-repos work the original spec
 * explicitly warns against ("must not freeze VS Code"). A single-file
 * parse has no such cost - it's pure syntax, no resolution - while still
 * giving real, exact answers to two questions regex scanning could only
 * approximate:
 *
 * 1. Import/require detection: parsing the actual grammar (rather than
 *    matching patterns against raw text) correctly handles awkward
 *    formatting, multi-line imports, `import type`, and similar cases a
 *    regex has to special-case or simply get wrong.
 * 2. Usage correlation: real *lexical scope* tracking (see `isShadowed`
 *    below) means a local variable that happens to share an imported
 *    name (`function f() { const oldApi = 1; oldApi(); }`) is correctly
 *    recognized as NOT a usage of the import - something no amount of
 *    comment/string masking on raw text could ever determine, since it
 *    requires understanding which declaration a reference actually binds
 *    to. This replaces the previous regex + comment/string-masking
 *    approach entirely.
 *
 * It remains a heuristic in a couple of narrow senses: without full type
 * information, an artificial same-named ambient global could still be
 * mistaken for the import; and cross-file resolution (see `reExportResolver`
 * below) only follows re-exports written as `export { x } from "./local"`
 * or `export * from "./local"` chains within the project, not files outside
 * the scanned set. Namespace-style access - both a direct namespace import
 * of the target package (`import * as ns from "pkg"; ns.oldApi()`) and a
 * namespace import of a local barrel that itself re-exports the package
 * (`import * as api from "./barrel"; api.oldApi()`) - is resolved to the
 * specific member accessed, the same way a named import would be. Real,
 * provable shadowing and both flavors of "barrel file" resolution - the
 * overwhelming majority of real false-positive/false-negative cases - are
 * all handled correctly.
 */

interface ImportMatch {
  importPath: string;
  line: number;
  column: number;
  usageType: UsageType;
  bindingKind: DependencyUsage["bindingKind"];
  /** Exported (package-side) names introduced by this import/require site. */
  importedSymbols: string[];
  /** Local binding names, parallel to `importedSymbols` (same index = same binding). */
  localNames: string[];
}

function isPackageSpecifier(importPath: string, packageName: string): boolean {
  return importPath === packageName || importPath.startsWith(`${packageName}/`);
}


function positionOf(sourceFile: ts.SourceFile, node: ts.Node): { line: number; column: number } {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: line + 1, column: character + 1 };
}

function bindingNameDeclares(name: ts.BindingName, target: string): boolean {
  if (ts.isIdentifier(name)) return name.text === target;
  for (const el of name.elements) {
    if (ts.isOmittedExpression(el)) continue;
    if (bindingNameDeclares(el.name, target)) return true;
  }
  return false;
}

function processImportDeclaration(node: ts.ImportDeclaration, sourceFile: ts.SourceFile, packageName: string, out: ImportMatch[]): void {
  if (!ts.isStringLiteralLike(node.moduleSpecifier)) return;
  const importPath = node.moduleSpecifier.text;
  if (!isPackageSpecifier(importPath, packageName)) return;

  const importedSymbols: string[] = [];
  const localNames: string[] = [];
  let bindingKind: DependencyUsage["bindingKind"] = "side-effect";

  const clause = node.importClause;
  if (clause) {
    if (clause.name) {
      // import Foo from "pkg";
      importedSymbols.push(clause.name.text);
      localNames.push(clause.name.text);
      bindingKind = "default";
    }
    if (clause.namedBindings) {
      if (ts.isNamespaceImport(clause.namedBindings)) {
        // import * as ns from "pkg";
        importedSymbols.push(clause.namedBindings.name.text);
        localNames.push(clause.namedBindings.name.text);
        bindingKind = "namespace";
      } else {
        // import { a, b as c } from "pkg"; (possibly alongside a default import above)
        for (const spec of clause.namedBindings.elements) {
          const localName = spec.name.text;
          const exportedName = spec.propertyName ? spec.propertyName.text : localName;
          importedSymbols.push(exportedName);
          localNames.push(localName);
        }
        bindingKind = "named";
      }
    }
  }

  const { line, column } = positionOf(sourceFile, node);
  out.push({ importPath, line, column, usageType: "import", bindingKind, importedSymbols, localNames });
}

function processRequireCall(node: ts.CallExpression, sourceFile: ts.SourceFile, packageName: string, out: ImportMatch[]): void {
  if (!ts.isIdentifier(node.expression) || node.expression.text !== "require") return;
  if (node.arguments.length !== 1 || !ts.isStringLiteralLike(node.arguments[0])) return;
  const importPath = (node.arguments[0] as ts.StringLiteralLike).text;
  if (!isPackageSpecifier(importPath, packageName)) return;

  const importedSymbols: string[] = [];
  const localNames: string[] = [];
  let bindingKind: DependencyUsage["bindingKind"] = "unknown";

  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isObjectBindingPattern(parent.name)) {
    // const { a, b: c } = require("pkg");
    bindingKind = "named";
    for (const element of parent.name.elements) {
      if (!ts.isIdentifier(element.name)) continue; // skip nested destructuring patterns (rare)
      const localName = element.name.text;
      const exportedName = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : localName;
      importedSymbols.push(exportedName);
      localNames.push(localName);
    }
  }

  const { line, column } = positionOf(sourceFile, node);
  out.push({ importPath, line, column, usageType: "require", bindingKind, importedSymbols, localNames });
}

function processDynamicImport(node: ts.CallExpression, sourceFile: ts.SourceFile, packageName: string, out: ImportMatch[]): void {
  if (node.expression.kind !== ts.SyntaxKind.ImportKeyword) return;
  if (node.arguments.length < 1 || !ts.isStringLiteralLike(node.arguments[0])) return;
  const importPath = (node.arguments[0] as ts.StringLiteralLike).text;
  if (!isPackageSpecifier(importPath, packageName)) return;

  const { line, column } = positionOf(sourceFile, node);
  out.push({ importPath, line, column, usageType: "dynamic-import", bindingKind: "unknown", importedSymbols: [], localNames: [] });
}

function collectImportsAndRequires(sourceFile: ts.SourceFile, packageName: string): ImportMatch[] {
  const out: ImportMatch[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      processImportDeclaration(node, sourceFile, packageName, out);
      return; // nothing usage-relevant lives inside an import declaration's own subtree
    }
    if (ts.isCallExpression(node)) {
      processRequireCall(node, sourceFile, packageName, out);
      processDynamicImport(node, sourceFile, packageName, out);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return out.sort((a, b) => a.line - b.line || a.column - b.column);
}

interface LocalImportCandidate {
  specifier: string;
  line: number;
  column: number;
  /** Named-import (localName, originalName-as-requested-from-the-local-module) pairs. */
  namedImports: { localName: string; originalName: string }[];
}

/**
 * Finds every `import { a, b as c } from "./relative/path"` statement -
 * regardless of package name, since the whole point is to check whether a
 * *local* file re-exports our target package. See
 * `collectLocalNamespaceImports` for the `import * as ns from "./local"`
 * counterpart.
 */
function collectLocalImportCandidates(sourceFile: ts.SourceFile): LocalImportCandidate[] {
  const out: LocalImportCandidate[] = [];
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteralLike(stmt.moduleSpecifier)) continue;
    const specifier = stmt.moduleSpecifier.text;
    if (!specifier.startsWith(".")) continue; // only local files can be "barrels" we can read and follow

    const clause = stmt.importClause;
    if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue;

    const namedImports = clause.namedBindings.elements.map((spec) => ({
      localName: spec.name.text,
      originalName: spec.propertyName ? spec.propertyName.text : spec.name.text,
    }));
    if (namedImports.length === 0) continue;

    const { line, column } = positionOf(sourceFile, stmt);
    out.push({ specifier, line, column, namedImports });
  }
  return out;
}

interface LocalNamespaceImportCandidate {
  specifier: string;
  localName: string;
  line: number;
  column: number;
}

/**
 * Finds every `import * as ns from "./relative/path"` statement - a
 * namespace import of a LOCAL file, which might itself be a barrel that
 * re-exports our target package. Whether a given `ns.member` access
 * actually traces back to the package is resolved later, at the point
 * each access is discovered (see `analyzeSource`), the same way a named
 * barrel import's `reExportResolver.resolveToPackage` call works - the
 * member name isn't known until we see how `ns` is actually used.
 */
function collectLocalNamespaceImports(sourceFile: ts.SourceFile): LocalNamespaceImportCandidate[] {
  const out: LocalNamespaceImportCandidate[] = [];
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteralLike(stmt.moduleSpecifier)) continue;
    const specifier = stmt.moduleSpecifier.text;
    if (!specifier.startsWith(".")) continue;

    const clause = stmt.importClause;
    if (!clause?.namedBindings || !ts.isNamespaceImport(clause.namedBindings)) continue;

    const { line, column } = positionOf(sourceFile, stmt);
    out.push({ specifier, localName: clause.namedBindings.name.text, line, column });
  }
  return out;
}

/** True if `node` sits in a position where it names a declaration/property/label rather than referencing a value. */
function isDeclarationOrNonReferencePosition(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;

  if (
    ((ts.isVariableDeclaration(parent) && !ts.isObjectBindingPattern(parent.name) && !ts.isArrayBindingPattern(parent.name)) ||
      ts.isParameter(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isEnumMember(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isModuleDeclaration(parent)) &&
    "name" in parent &&
    parent.name === node
  ) {
    return true;
  }

  if (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node)) return true;
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return true;
  if (ts.isExportSpecifier(parent)) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (ts.isQualifiedName(parent) && parent.right === node) return true;
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent)) &&
    parent.name === node
  ) {
    return true;
  }
  if (ts.isLabeledStatement(parent) && parent.label === node) return true;
  if ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === node) return true;
  if (ts.isJsxAttribute(parent) && parent.name === node) return true;

  return false;
}

function isScopeBoundary(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isBlock(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isCatchClause(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node) ||
    ts.isSourceFile(node)
  );
}

function blockDeclaresDirectly(block: ts.Block, name: string): boolean {
  for (const stmt of block.statements) {
    if (ts.isVariableStatement(stmt) && stmt.declarationList.declarations.some((d) => bindingNameDeclares(d.name, name))) {
      return true;
    }
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name) return true;
    if (ts.isClassDeclaration(stmt) && stmt.name?.text === name) return true;
    // Interfaces/type aliases/enums are block-scoped declarations too, and
    // a nested one shadows an imported type of the same name just as a
    // nested `const`/`class` would shadow an imported value.
    if (ts.isInterfaceDeclaration(stmt) && stmt.name.text === name) return true;
    if (ts.isTypeAliasDeclaration(stmt) && stmt.name.text === name) return true;
    if (ts.isEnumDeclaration(stmt) && stmt.name.text === name) return true;
  }
  return false;
}

function loopDeclares(initializer: ts.ForInitializer | undefined, name: string): boolean {
  return !!initializer && ts.isVariableDeclarationList(initializer) && initializer.declarations.some((d) => bindingNameDeclares(d.name, name));
}

/** Does this scope-boundary node itself declare a binding named `name`? (SourceFile is handled by the caller.) */
function declaresName(scope: ts.Node, name: string): boolean {
  if (ts.isClassDeclaration(scope) || ts.isClassExpression(scope)) {
    return scope.name?.text === name;
  }
  if (ts.isCatchClause(scope)) {
    return !!scope.variableDeclaration && bindingNameDeclares(scope.variableDeclaration.name, name);
  }
  if (ts.isForInStatement(scope) || ts.isForOfStatement(scope)) {
    return loopDeclares(scope.initializer, name);
  }
  if (ts.isForStatement(scope)) {
    return loopDeclares(scope.initializer, name);
  }
  if (
    ts.isFunctionDeclaration(scope) ||
    ts.isFunctionExpression(scope) ||
    ts.isArrowFunction(scope) ||
    ts.isMethodDeclaration(scope) ||
    ts.isConstructorDeclaration(scope) ||
    ts.isGetAccessorDeclaration(scope) ||
    ts.isSetAccessorDeclaration(scope)
  ) {
    if (scope.parameters.some((p) => bindingNameDeclares(p.name, name))) return true;
    if ("name" in scope && scope.name && ts.isIdentifier(scope.name) && scope.name.text === name) return true;
    return !!scope.body && ts.isBlock(scope.body) && blockDeclaresDirectly(scope.body, name);
  }
  if (ts.isBlock(scope)) {
    return blockDeclaresDirectly(scope, name);
  }
  return false;
}

/**
 * Walks up from an identifier reference through enclosing scopes, looking
 * for a nearer declaration of the same name. If one exists between the
 * reference and the module's top level, the reference refers to that local
 * shadow, not to our top-level import - the core of real (if lexical-only,
 * non-type-checked) scope analysis.
 */
function isShadowed(identifier: ts.Identifier, name: string): boolean {
  let current: ts.Node | undefined = identifier.parent;
  while (current) {
    if (isScopeBoundary(current)) {
      if (ts.isSourceFile(current)) return false; // reached module top level - refers to the import, not a shadow
      if (declaresName(current, name)) return true;
    }
    current = current.parent;
  }
  return false;
}

interface NamespaceBindingInfo {
  importPath: string;
  line: number;
  column: number;
  /**
   * True when this namespace import is of the target package itself
   * (`import * as ns from "some-package"`), so any `.member` access is
   * trivially the package's own export of that name. False when it's a
   * namespace import of a LOCAL file (`import * as ns from "./barrel"`)
   * that might itself be a re-export barrel - resolving a `.member`
   * access in that case requires following `reExportResolver`, the same
   * way a named barrel import does.
   */
  direct: boolean;
}

function collectReferences(
  sourceFile: ts.SourceFile,
  localNameToExported: Map<string, string>,
  namespaceBindings: Map<string, NamespaceBindingInfo>,
  filePath: string
): {
  symbolReferences: SymbolReference[];
  usedSymbols: Set<string>;
  namespaceMemberAccesses: { member: string; line: number; column: number; namespaceInfo: NamespaceBindingInfo }[];
} {
  const symbolReferences: SymbolReference[] = [];
  const usedSymbols = new Set<string>();
  const namespaceMemberAccesses: { member: string; line: number; column: number; namespaceInfo: NamespaceBindingInfo }[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) return; // don't count anything inside the import statement itself

    if (
      ts.isIdentifier(node) &&
      !isDeclarationOrNonReferencePosition(node) &&
      (localNameToExported.has(node.text) || namespaceBindings.has(node.text))
    ) {
      if (!isShadowed(node, node.text)) {
        if (localNameToExported.has(node.text)) {
          const exported = localNameToExported.get(node.text)!;
          const { line, column } = positionOf(sourceFile, node);
          symbolReferences.push({ symbol: exported, filePath, line, column });
          usedSymbols.add(exported);
        }

        // If this reference is to a namespace binding AND it's being
        // dotted into (`ns.someExport`), attribute the access to the
        // SPECIFIC member accessed rather than only the opaque namespace
        // name - this is what lets `import * as ns from "pkg"; ns.oldApi()`
        // (or the local-barrel equivalent) correlate against a
        // breaking-change symbol ("oldApi") the same way a named import
        // would, instead of the member disappearing into an unresolvable
        // namespace reference. Note this check must NOT be nested inside
        // the `localNameToExported.has(...)` branch above: a local-barrel
        // namespace import is registered only in `namespaceBindings`, not
        // `localNameToExported` (there's no package export to attribute a
        // bare reference to it), so it would never reach this check if it
        // were.
        const namespaceInfo = namespaceBindings.get(node.text);
        if (namespaceInfo && node.parent && ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node) {
          const memberPos = positionOf(sourceFile, node.parent.name);
          namespaceMemberAccesses.push({ member: node.parent.name.text, line: memberPos.line, column: memberPos.column, namespaceInfo });
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);
  return { symbolReferences, usedSymbols, namespaceMemberAccesses };
}

export class UsageAnalyzer {
  /**
   * Parses a single file's source text and finds usages of `packageName`:
   * every import/require/dynamic-import site, plus - via real lexical
   * scope tracking - which of the imported symbols are genuinely
   * referenced (not shadowed by a same-named local) later in the file.
   *
   * When `reExportResolver` is provided, this also detects usage through
   * "barrel file" re-exports: `import { oldApi } from "./api-client"` is
   * recognized as a real usage of `packageName` if `./api-client` (or a
   * chain of local files it points to) re-exports `oldApi` from
   * `packageName`, even though this file's own import statement never
   * names the package directly.
   */
  analyzeSource(source: string, filePath: string, packageName: string, reExportResolver?: ReExportResolver): FileUsageSummary | null {
    let sourceFile: ts.SourceFile;
    try {
      sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, inferScriptKind(filePath));
    } catch {
      // The TypeScript parser is designed to never throw (even on invalid
      // syntax it produces a best-effort tree), but this guards against any
      // unexpected environment issue rather than taking down the whole scan.
      return null;
    }

    const importMatches = collectImportsAndRequires(sourceFile, packageName);

    const usages: DependencyUsage[] = importMatches.map((m) => ({
      packageName,
      filePath,
      line: m.line,
      column: m.column,
      importPath: m.importPath,
      importedSymbols: m.importedSymbols,
      bindingKind: m.bindingKind,
      usageType: m.usageType,
    }));

    const importedSymbols = new Set<string>();
    const localNameToExported = new Map<string, string>();
    const namespaceBindings = new Map<string, NamespaceBindingInfo>();
    for (const m of importMatches) {
      for (let i = 0; i < m.importedSymbols.length; i++) {
        importedSymbols.add(m.importedSymbols[i]);
        localNameToExported.set(m.localNames[i], m.importedSymbols[i]);
      }
      if (m.bindingKind === "namespace") {
        for (const localName of m.localNames) {
          namespaceBindings.set(localName, { importPath: m.importPath, line: m.line, column: m.column, direct: true });
        }
      }
    }

    if (reExportResolver) {
      for (const candidate of collectLocalImportCandidates(sourceFile)) {
        for (const { localName, originalName } of candidate.namedImports) {
          const resolvedExportedName = reExportResolver.resolveToPackage(filePath, candidate.specifier, originalName, packageName);
          if (!resolvedExportedName) continue;

          importedSymbols.add(resolvedExportedName);
          localNameToExported.set(localName, resolvedExportedName);
          usages.push({
            packageName,
            filePath,
            line: candidate.line,
            column: candidate.column,
            importPath: candidate.specifier,
            importedSymbols: [resolvedExportedName],
            bindingKind: "named",
            usageType: "import",
          });
        }
      }

      // A namespace import of a local file (`import * as api from
      // "./barrel"`) might ALSO be a re-export barrel - unlike the named
      // case above, we don't know which member(s) will be accessed until
      // we see `api.someMember` later in the file, so this only records
      // the binding here; resolution happens per-access below, uniformly
      // with direct namespace imports of the package itself.
      for (const candidate of collectLocalNamespaceImports(sourceFile)) {
        if (!namespaceBindings.has(candidate.localName)) {
          namespaceBindings.set(candidate.localName, {
            importPath: candidate.specifier,
            line: candidate.line,
            column: candidate.column,
            direct: false,
          });
        }
      }
    }

    if (usages.length === 0 && namespaceBindings.size === 0) return null;

    const { symbolReferences, usedSymbols, namespaceMemberAccesses } = collectReferences(sourceFile, localNameToExported, namespaceBindings, filePath);

    const addedNamespaceMemberUsages = new Set<string>();
    for (const access of namespaceMemberAccesses) {
      const exportedName = access.namespaceInfo.direct
        ? access.member
        : reExportResolver?.resolveToPackage(filePath, access.namespaceInfo.importPath, access.member, packageName) ?? null;
      if (!exportedName) continue;

      importedSymbols.add(exportedName);
      usedSymbols.add(exportedName);
      symbolReferences.push({ symbol: exportedName, filePath, line: access.line, column: access.column });

      // One DependencyUsage entry per distinct resolved member is enough to
      // let ImpactEngine locate "where this dependency entered the file" -
      // repeated accesses to the same member all add symbolReferences
      // (real usage sites) above, but don't need repeated import-site entries.
      if (!addedNamespaceMemberUsages.has(exportedName)) {
        addedNamespaceMemberUsages.add(exportedName);
        usages.push({
          packageName,
          filePath,
          line: access.namespaceInfo.line,
          column: access.namespaceInfo.column,
          importPath: access.namespaceInfo.importPath,
          importedSymbols: [exportedName],
          bindingKind: "namespace",
          usageType: "import",
        });
      }
    }

    if (usages.length === 0) return null;

    return { filePath, usages, symbolReferences, importedSymbols, usedSymbols };
  }
}
