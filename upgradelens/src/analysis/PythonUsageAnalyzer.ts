import * as fs from "fs";
import * as path from "path";
import { DependencyUsage, FileUsageSummary, SymbolReference } from "../models/DependencyUsage";
import { candidateImportNames } from "./pythonImportNameMap";
import { PythonReExportResolver } from "./PythonReExportResolver";

/**
 * Usage detection for Python source files, built on web-tree-sitter + the
 * official tree-sitter-python WASM grammar.
 *
 * This replaces the previous regex/text-based scanner. A real syntax tree
 * gives exact answers for import forms and — critically — real lexical scope
 * tracking, so a parameter or local that happens to share a name with an
 * imported binding is no longer miscounted as package usage:
 *
 *   def f(requests):          # parameter shadows the import
 *       requests.get(...)     # NOT counted as usage of the package
 *
 * Runtime cost: ~660KB of WASM (tree-sitter.wasm + tree-sitter-python.wasm)
 * shipped under resources/tree-sitter/. Parser init is lazy and shared across
 * all files in a single analysis pass. analyzeSource is async for that reason.
 *
 * What is handled correctly:
 * - import pkg / import pkg as alias / import pkg.submodule
 *   (binding the first dotted component, matching real Python semantics)
 * - from pkg import a, b as c (including multi-line parenthesized form)
 * - from pkg import *
 * - Namespace-style member access (import pkg; pkg.old_api()) resolves to
 *   the specific member accessed
 * - PyPI package names that don't match their Python import name
 *   (Pillow -> PIL, beautifulsoup4 -> bs4) via candidateImportNames
 * - Lexical shadowing: function/lambda parameters, for/with targets,
 *   class bodies, nested functions, except handlers, assignment targets,
 *   comprehensions, and match/case patterns
 *
 * Known remaining limits (disclosed):
 * - Python re-exports through __init__.py aren't traced across files
 * - Ambient-global edge cases without a local binding still can't be
 *   distinguished from the import (no type information)
 */

type TSNode = {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  startIndex: number;
  endIndex: number;
  childCount: number;
  namedChildCount: number;
  child(index: number): TSNode | null;
  namedChild(index: number): TSNode | null;
  children: TSNode[];
  namedChildren: TSNode[];
  childForFieldName(field: string): TSNode | null;
  descendantsOfType(types: string | string[]): TSNode[];
  parent: TSNode | null;
};

type TSTree = { rootNode: TSNode };
type TSParser = {
  setLanguage(lang: unknown): void;
  parse(input: string): TSTree;
};

interface FromImportMatch {
  line: number;
  column: number;
  moduleText: string;
  namedImports: { localName: string; originalName: string }[];
  isStar: boolean;
  startIndex: number;
  endIndex: number;
}

interface BareImportMatch {
  line: number;
  column: number;
  moduleText: string;
  localName: string;
  startIndex: number;
  endIndex: number;
}

let parserReady: Promise<TSParser> | null = null;
let languageLoaded = false;

function defaultWasmDir(): string {
  const fromOut = path.join(__dirname, "..", "..", "resources", "tree-sitter");
  if (fs.existsSync(path.join(fromOut, "tree-sitter-python.wasm"))) return fromOut;
  const fromRoot = path.join(process.cwd(), "resources", "tree-sitter");
  if (fs.existsSync(path.join(fromRoot, "tree-sitter-python.wasm"))) return fromRoot;
  return path.join(__dirname, "..", "..", "resources", "tree-sitter");
}

async function createParser(wasmDir?: string): Promise<TSParser> {
  // web-tree-sitter ships ESM + CJS; require the CJS build under CommonJS.
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const wts = require("web-tree-sitter") as {
    Parser: unknown;
    Language: { load(path: string | Uint8Array): Promise<unknown> };
  };
  const ParserCtor = wts.Parser as unknown as {
    new (): TSParser;
    init(options?: { locateFile?: (scriptName: string) => string }): Promise<void>;
  };
  const dir = wasmDir ?? defaultWasmDir();
  await ParserCtor.init({
    locateFile(scriptName: string) {
      return path.join(dir, scriptName);
    },
  });
  const language = await wts.Language.load(path.join(dir, "tree-sitter-python.wasm"));
  const parser = new ParserCtor();
  parser.setLanguage(language);
  languageLoaded = true;
  return parser;
}

function ensureParser(wasmDir?: string): Promise<TSParser> {
  if (!parserReady) {
    parserReady = createParser(wasmDir).catch((err) => {
      parserReady = null;
      throw err;
    });
  }
  return parserReady;
}

function isPackageSpecifier(moduleText: string, candidates: string[]): boolean {
  return candidates.some((c) => moduleText === c || moduleText.startsWith(`${c}.`));
}

function firstDottedComponent(moduleText: string): string {
  const dotIndex = moduleText.indexOf(".");
  return dotIndex === -1 ? moduleText : moduleText.slice(0, dotIndex);
}

function nodeText(node: TSNode): string {
  return node.text;
}

function collectDottedName(node: TSNode | null): string {
  if (!node) return "";
  if (node.type === "identifier") return nodeText(node);
  if (node.type === "dotted_name") {
    return node.namedChildren.map((c) => nodeText(c)).join(".");
  }
  if (node.type === "relative_import") {
    return nodeText(node).replace(/\s+/g, "");
  }
  const inner = node.childForFieldName("name") ?? node.namedChild(0);
  return collectDottedName(inner);
}

const SCOPE_TYPES = new Set([
  "function_definition",
  "lambda",
  "class_definition",
  "for_statement",
  "with_statement",
  "except_clause",
  "comprehension",
  "generator_expression",
  "list_comprehension",
  "set_comprehension",
  "dictionary_comprehension",
  "match_statement",
  "case_clause",
]);

function collectBoundNames(node: TSNode | null, out: Set<string>): void {
  if (!node) return;
  switch (node.type) {
    case "identifier":
      out.add(nodeText(node));
      return;
    case "list_pattern":
    case "tuple_pattern":
    case "pattern_list":
    case "list":
    case "tuple":
    case "expression_list":
      for (const child of node.namedChildren) collectBoundNames(child, out);
      return;
    case "list_splat_pattern":
    case "dictionary_splat_pattern":
    case "list_splat":
    case "dictionary_splat": {
      const name = node.namedChild(0);
      if (name) collectBoundNames(name, out);
      return;
    }
    case "as_pattern": {
      const alias = node.childForFieldName("alias") ?? node.namedChild(node.namedChildCount - 1);
      collectBoundNames(alias, out);
      return;
    }
    case "pattern":
    case "as_pattern_target":
      for (const child of node.namedChildren) collectBoundNames(child, out);
      return;
    case "parameters":
      for (const child of node.namedChildren) collectBoundNames(child, out);
      return;
    case "default_parameter":
    case "typed_parameter":
    case "typed_default_parameter": {
      const name = node.childForFieldName("name") ?? node.namedChild(0);
      collectBoundNames(name, out);
      return;
    }
    case "keyword_separator":
    case "positional_separator":
      return;
    default:
      if (node.type === "attribute") return;
      for (const child of node.namedChildren) collectBoundNames(child, out);
  }
}

function collectAssignmentTargets(stmt: TSNode, bound: Set<string>): void {
  if (stmt.type === "expression_statement") {
    const expr = stmt.namedChild(0);
    if (expr && (expr.type === "assignment" || expr.type === "augmented_assignment")) {
      collectBoundNames(expr.childForFieldName("left"), bound);
    }
  } else if (stmt.type === "for_statement") {
    collectBoundNames(stmt.childForFieldName("left"), bound);
  } else if (stmt.type === "with_statement") {
    for (const child of stmt.namedChildren) {
      if (child.type === "with_item") {
        const value = child.childForFieldName("value") ?? child.namedChild(0);
        if (value && value.type === "as_pattern") collectBoundNames(value, bound);
      }
    }
  } else if (stmt.type === "function_definition" || stmt.type === "class_definition") {
    const nameNode = stmt.childForFieldName("name");
    if (nameNode) bound.add(nodeText(nameNode));
  }
}

function scopeBindsName(scope: TSNode, name: string): boolean {
  const bound = new Set<string>();

  if (scope.type === "function_definition" || scope.type === "lambda") {
    const params = scope.childForFieldName("parameters");
    collectBoundNames(params, bound);
  } else if (scope.type === "class_definition") {
    const body = scope.childForFieldName("body");
    if (body) {
      for (const stmt of body.namedChildren) {
        if (stmt.type === "expression_statement") {
          const expr = stmt.namedChild(0);
          if (expr && expr.type === "assignment") {
            collectBoundNames(expr.childForFieldName("left"), bound);
          }
        } else if (stmt.type === "function_definition" || stmt.type === "class_definition") {
          const n = stmt.childForFieldName("name");
          if (n) bound.add(nodeText(n));
        }
      }
    }
  } else if (scope.type === "for_statement") {
    collectBoundNames(scope.childForFieldName("left"), bound);
  } else if (scope.type === "with_statement") {
    for (const child of scope.namedChildren) {
      if (child.type === "with_item") {
        const value = child.childForFieldName("value") ?? child.namedChild(0);
        if (value && value.type === "as_pattern") collectBoundNames(value, bound);
      }
    }
  } else if (scope.type === "except_clause") {
    for (const child of scope.namedChildren) {
      if (child.type === "as_pattern") collectBoundNames(child, bound);
      else if (child.type === "identifier") bound.add(nodeText(child));
    }
  } else if (
    scope.type === "list_comprehension" ||
    scope.type === "set_comprehension" ||
    scope.type === "dictionary_comprehension" ||
    scope.type === "generator_expression" ||
    scope.type === "comprehension"
  ) {
    for (const child of scope.namedChildren) {
      if (child.type === "for_in_clause") {
        collectBoundNames(child.childForFieldName("left") ?? child.namedChild(0), bound);
      }
    }
  } else if (scope.type === "case_clause") {
    const pattern = scope.childForFieldName("pattern") ?? scope.namedChild(0);
    collectBoundNames(pattern, bound);
  }

  if (scope.type === "function_definition") {
    const body = scope.childForFieldName("body");
    if (body) {
      for (const stmt of body.namedChildren) {
        collectAssignmentTargets(stmt, bound);
      }
    }
  }

  return bound.has(name);
}

function isShadowed(identifier: TSNode, name: string): boolean {
  let current: TSNode | null = identifier.parent;
  while (current) {
    if (SCOPE_TYPES.has(current.type)) {
      if (scopeBindsName(current, name)) return true;
    }
    current = current.parent;
  }
  return false;
}

function findFromImports(root: TSNode, candidates: string[]): FromImportMatch[] {
  const out: FromImportMatch[] = [];
  const imports = root.descendantsOfType("import_from_statement");
  for (const node of imports) {
    let moduleNode = node.childForFieldName("module_name");
    if (!moduleNode) {
      for (const child of node.namedChildren) {
        if (child.type === "dotted_name" || child.type === "relative_import") {
          moduleNode = child;
          break;
        }
      }
    }
    const moduleText = collectDottedName(moduleNode);
    if (!moduleText || !isPackageSpecifier(moduleText, candidates)) continue;

    const namedImports: { localName: string; originalName: string }[] = [];
    let isStar = false;

    for (const child of node.namedChildren) {
      if (child.type === "wildcard_import") {
        isStar = true;
      } else if (child.type === "dotted_name" && child !== moduleNode) {
        const name = nodeText(child);
        namedImports.push({ localName: name, originalName: name });
      } else if (child.type === "aliased_import") {
        const nameNode = child.childForFieldName("name") ?? child.namedChild(0);
        const aliasNode = child.childForFieldName("alias") ?? child.namedChild(1);
        const original = collectDottedName(nameNode);
        const local = aliasNode ? nodeText(aliasNode) : original;
        namedImports.push({ localName: local, originalName: original });
      } else if (child.type === "identifier" && child !== moduleNode) {
        const name = nodeText(child);
        namedImports.push({ localName: name, originalName: name });
      }
    }

    out.push({
      line: node.startPosition.row + 1,
      column: node.startPosition.column + 1,
      moduleText,
      namedImports,
      isStar,
      startIndex: node.startIndex,
      endIndex: node.endIndex,
    });
  }
  return out;
}

function findBareImports(root: TSNode, candidates: string[]): BareImportMatch[] {
  const out: BareImportMatch[] = [];
  const imports = root.descendantsOfType("import_statement");
  for (const node of imports) {
    for (const child of node.namedChildren) {
      let moduleText = "";
      let localName = "";
      if (child.type === "dotted_name") {
        moduleText = collectDottedName(child);
        localName = firstDottedComponent(moduleText);
      } else if (child.type === "aliased_import") {
        const nameNode = child.childForFieldName("name") ?? child.namedChild(0);
        const aliasNode = child.childForFieldName("alias") ?? child.namedChild(1);
        moduleText = collectDottedName(nameNode);
        localName = aliasNode ? nodeText(aliasNode) : firstDottedComponent(moduleText);
      } else if (child.type === "identifier") {
        moduleText = nodeText(child);
        localName = moduleText;
      } else {
        continue;
      }
      if (!isPackageSpecifier(moduleText, candidates)) continue;
      out.push({
        line: node.startPosition.row + 1,
        column: node.startPosition.column + 1,
        moduleText,
        localName,
        startIndex: node.startIndex,
        endIndex: node.endIndex,
      });
    }
  }
  return out;
}

function isInsideImportRange(
  index: number,
  fromImports: FromImportMatch[],
  bareImports: BareImportMatch[]
): boolean {
  for (const fi of fromImports) {
    if (index >= fi.startIndex && index < fi.endIndex) return true;
  }
  for (const bi of bareImports) {
    if (index >= bi.startIndex && index < bi.endIndex) return true;
  }
  return false;
}


interface LocalFromImport {
  line: number;
  column: number;
  moduleText: string;
  namedImports: { localName: string; originalName: string }[];
  startIndex: number;
  endIndex: number;
}

function findLocalFromImports(root: TSNode): LocalFromImport[] {
  const out: LocalFromImport[] = [];
  const imports = root.descendantsOfType("import_from_statement");
  for (const node of imports) {
    let moduleNode = node.childForFieldName("module_name");
    if (!moduleNode) {
      for (const child of node.namedChildren) {
        if (child.type === "dotted_name" || child.type === "relative_import") {
          moduleNode = child;
          break;
        }
      }
    }
    let spec = collectDottedName(moduleNode);
    if (moduleNode && moduleNode.type === "relative_import") {
      spec = nodeText(moduleNode).replace(/\s+/g, "");
    }
    if (!spec) continue;

    const namedImports: { localName: string; originalName: string }[] = [];
    for (const child of node.namedChildren) {
      if (child.type === "wildcard_import") {
        continue;
      } else if (child.type === "aliased_import") {
        const nameNode = child.childForFieldName("name") ?? child.namedChild(0);
        const aliasNode = child.childForFieldName("alias") ?? child.namedChild(1);
        const original = collectDottedName(nameNode);
        const local = aliasNode ? nodeText(aliasNode) : original;
        namedImports.push({ localName: local, originalName: original });
      } else if (child.type === "dotted_name" && child !== moduleNode) {
        const name = nodeText(child);
        namedImports.push({ localName: name, originalName: name });
      } else if (child.type === "identifier" && child !== moduleNode) {
        const name = nodeText(child);
        namedImports.push({ localName: name, originalName: name });
      }
    }
    if (namedImports.length === 0) continue;
    out.push({
      line: node.startPosition.row + 1,
      column: node.startPosition.column + 1,
      moduleText: spec,
      namedImports,
      startIndex: node.startIndex,
      endIndex: node.endIndex,
    });
  }
  return out;
}

export class PythonUsageAnalyzer {
  private readonly wasmDir: string | undefined;

  constructor(wasmDir?: string) {
    this.wasmDir = wasmDir;
  }

  async analyzeSource(
    source: string,
    filePath: string,
    packageName: string,
    reExportResolver?: PythonReExportResolver
  ): Promise<FileUsageSummary | null> {
    const candidates = candidateImportNames(packageName);
    let root: TSNode;
    try {
      const parser = await ensureParser(this.wasmDir);
      const tree = parser.parse(source);
      root = tree.rootNode;
    } catch {
      // web-tree-sitter missing or WASM failed to load — no usage signal
      return null;
    }

    const fromImports = findFromImports(root, candidates);
    const bareImports = findBareImports(root, candidates);
    if (fromImports.length === 0 && bareImports.length === 0) return null;

    const usages: DependencyUsage[] = [];
    const importedSymbols = new Set<string>();
    const localNameToExported = new Map<string, string>();
    const namespaceBindings = new Map<string, { line: number; column: number; moduleText: string }>();

    for (const fi of fromImports) {
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
      importedSymbols.add(bi.localName);
      localNameToExported.set(bi.localName, bi.localName);
      namespaceBindings.set(bi.localName, {
        line: bi.line,
        column: bi.column,
        moduleText: bi.moduleText,
      });
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

    // Follow local/relative imports that re-export the target package
    // (Python barrel files / __init__.py pass-throughs).
    if (reExportResolver) {
      const localFromImports = findLocalFromImports(root);
      for (const li of localFromImports) {
        for (const { localName, originalName } of li.namedImports) {
          const resolved = reExportResolver.resolveToPackage(
            filePath,
            li.moduleText,
            originalName,
            packageName,
            candidates
          );
          if (!resolved) continue;
          importedSymbols.add(resolved);
          localNameToExported.set(localName, resolved);
          usages.push({
            packageName,
            filePath,
            line: li.line,
            column: li.column,
            importPath: li.moduleText,
            importedSymbols: [resolved],
            bindingKind: "named",
            usageType: "import",
          });
        }
      }
    }

    const symbolReferences: SymbolReference[] = [];
    const usedSymbols = new Set<string>();
    const identifiers = root.descendantsOfType("identifier");

    for (const id of identifiers) {
      const name = nodeText(id);
      const exported = localNameToExported.get(name);
      if (!exported) continue;
      if (isInsideImportRange(id.startIndex, fromImports, bareImports)) continue;
      if (isShadowed(id, name)) continue;

      const parent = id.parent;
      if (parent && parent.type === "attribute") {
        const objectNode = parent.childForFieldName("object") ?? parent.namedChild(0);
        if (objectNode && objectNode.startIndex === id.startIndex) {
          const attrNode = parent.childForFieldName("attribute") ?? parent.namedChild(1);
          if (attrNode && attrNode.type === "identifier") {
            const member = nodeText(attrNode);
            importedSymbols.add(member);
            usedSymbols.add(member);
            symbolReferences.push({
              symbol: member,
              filePath,
              line: id.startPosition.row + 1,
              column: id.startPosition.column + 1,
            });
            usedSymbols.add(exported);
            continue;
          }
        }
      }

      symbolReferences.push({
        symbol: exported,
        filePath,
        line: id.startPosition.row + 1,
        column: id.startPosition.column + 1,
      });
      usedSymbols.add(exported);
    }

    const addedNamespaceMemberUsages = new Set<string>();
    for (const [localName, info] of namespaceBindings) {
      for (const id of identifiers) {
        if (nodeText(id) !== localName) continue;
        if (isInsideImportRange(id.startIndex, fromImports, bareImports)) continue;
        if (isShadowed(id, localName)) continue;
        const parent = id.parent;
        if (!parent || parent.type !== "attribute") continue;
        const objectNode = parent.childForFieldName("object") ?? parent.namedChild(0);
        if (!objectNode || objectNode.startIndex !== id.startIndex) continue;
        const attrNode = parent.childForFieldName("attribute") ?? parent.namedChild(1);
        if (!attrNode || attrNode.type !== "identifier") continue;
        const member = nodeText(attrNode);
        const dedupeKey = `${localName}.${member}`;
        if (addedNamespaceMemberUsages.has(dedupeKey)) continue;
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

    return { filePath, usages, symbolReferences, importedSymbols, usedSymbols };
  }

  static isParserReady(): boolean {
    return languageLoaded;
  }

  static resetParserForTests(): void {
    parserReady = null;
    languageLoaded = false;
  }
}
