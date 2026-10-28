import * as fs from "fs";
import * as path from "path";
import { DependencyUsage, FileUsageSummary, SymbolReference } from "../models/DependencyUsage";
import { SimpleLanguage } from "./SimpleUsageAnalyzer";

/**
 * AST + lexical-scope usage detection for Rust, Go, and Java via
 * web-tree-sitter WASM grammars (same runtime as PythonUsageAnalyzer).
 *
 * Falls back gracefully if WASM files are missing — callers should use
 * SimpleUsageAnalyzer as a secondary path.
 */

type TSNode = {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  startIndex: number;
  endIndex: number;
  namedChildCount: number;
  namedChildren: TSNode[];
  namedChild(i: number): TSNode | null;
  childForFieldName(f: string): TSNode | null;
  descendantsOfType(t: string | string[]): TSNode[];
  parent: TSNode | null;
};

type TSParser = { setLanguage(lang: unknown): void; parse(input: string): { rootNode: TSNode } };

const parsers: Partial<Record<SimpleLanguage, Promise<TSParser>>> = {};

function wasmDir(): string {
  const fromOut = path.join(__dirname, "..", "..", "resources", "tree-sitter");
  if (fs.existsSync(fromOut)) return fromOut;
  return path.join(process.cwd(), "resources", "tree-sitter");
}

const WASM_FILES: Record<SimpleLanguage, string> = {
  rust: "tree-sitter-rust.wasm",
  go: "tree-sitter-go.wasm",
  java: "tree-sitter-java.wasm",
};

async function getParser(lang: SimpleLanguage): Promise<TSParser> {
  if (!parsers[lang]) {
    parsers[lang] = (async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
      const wts = require("web-tree-sitter") as {
        Parser: { new (): TSParser; init(opts?: { locateFile?: (s: string) => string }): Promise<void> };
        Language: { load(p: string): Promise<unknown> };
      };
      const dir = wasmDir();
      await wts.Parser.init({ locateFile: (s) => path.join(dir, s) });
      const language = await wts.Language.load(path.join(dir, WASM_FILES[lang]));
      const parser = new wts.Parser();
      parser.setLanguage(language);
      return parser;
    })();
  }
  return parsers[lang]!;
}

function nodeText(n: TSNode): string {
  return n.text;
}

export class TreeSitterUsageAnalyzer {
  async analyzeSource(
    source: string,
    filePath: string,
    packageName: string,
    language: SimpleLanguage
  ): Promise<FileUsageSummary | null> {
    try {
      const parser = await getParser(language);
      const root = parser.parse(source).rootNode;
      switch (language) {
        case "rust":
          return analyzeRustTree(root, filePath, packageName);
        case "go":
          return analyzeGoTree(root, filePath, packageName);
        case "java":
          return analyzeJavaTree(root, filePath, packageName);
        default:
          return null;
      }
    } catch {
      return null; // WASM missing or parse failure — caller falls back
    }
  }
}

function analyzeRustTree(root: TSNode, filePath: string, packageName: string): FileUsageSummary | null {
  const rustName = packageName.replace(/-/g, "_");
  const usages: DependencyUsage[] = [];
  const importedSymbols = new Set<string>();
  const usedSymbols = new Set<string>();
  const symbolReferences: SymbolReference[] = [];
  const localToExported = new Map<string, string>();
  const importRanges: { start: number; end: number }[] = [];

  for (const node of root.descendantsOfType(["use_declaration", "extern_crate_declaration"])) {
    const text = nodeText(node);
    if (!text.includes(rustName)) continue;
    const line = node.startPosition.row + 1;
    importRanges.push({ start: node.startIndex, end: node.endIndex });

    // Collect identifiers introduced
    for (const id of node.descendantsOfType("identifier")) {
      const name = nodeText(id);
      // Skip the crate path segment that equals rustName itself when it's the path root
      importedSymbols.add(name);
      localToExported.set(name, name);
    }
    usages.push({
      packageName,
      filePath,
      line,
      column: node.startPosition.column + 1,
      importPath: rustName,
      importedSymbols: [...importedSymbols],
      bindingKind: "named",
      usageType: "import",
    });
  }
  if (usages.length === 0) return null;

  // Scope: function params / let bindings shadow
  for (const id of root.descendantsOfType("identifier")) {
    const name = nodeText(id);
    const exported = localToExported.get(name);
    if (!exported) continue;
    if (importRanges.some((r) => id.startIndex >= r.start && id.startIndex < r.end)) continue;
    if (isRustShadowed(id, name)) continue;
    usedSymbols.add(exported);
    symbolReferences.push({
      symbol: exported,
      filePath,
      line: id.startPosition.row + 1,
      column: id.startPosition.column + 1,
    });
  }

  return { filePath, usages, symbolReferences, importedSymbols, usedSymbols };
}

function isRustShadowed(id: TSNode, name: string): boolean {
  let cur: TSNode | null = id.parent;
  while (cur) {
    if (cur.type === "function_item" || cur.type === "closure_expression" || cur.type === "block") {
      // parameters
      const params = cur.childForFieldName("parameters");
      if (params) {
        for (const p of params.descendantsOfType("identifier")) {
          if (nodeText(p) === name && p.startIndex !== id.startIndex) return true;
        }
      }
      // let_declaration in block
      for (const letDecl of cur.namedChildren.filter((c) => c.type === "let_declaration")) {
        for (const p of letDecl.descendantsOfType("identifier")) {
          if (nodeText(p) === name && p.startIndex < id.startIndex) return true;
        }
      }
    }
    cur = cur.parent;
  }
  return false;
}

function analyzeGoTree(root: TSNode, filePath: string, packageName: string): FileUsageSummary | null {
  const usages: DependencyUsage[] = [];
  const importedSymbols = new Set<string>();
  const usedSymbols = new Set<string>();
  const symbolReferences: SymbolReference[] = [];
  const localToExported = new Map<string, string>();
  const importRanges: { start: number; end: number }[] = [];

  for (const node of root.descendantsOfType("import_declaration")) {
    for (const spec of node.descendantsOfType("import_spec")) {
      const pathNode = spec.childForFieldName("path") ?? spec.namedChildren.find((c) => c.type === "interpreted_string_literal");
      if (!pathNode) continue;
      const importPath = nodeText(pathNode).replace(/"/g, "");
      if (!(importPath === packageName || importPath.startsWith(packageName + "/"))) continue;
      const nameNode = spec.childForFieldName("name");
      const alias = nameNode ? nodeText(nameNode) : null;
      if (alias === "_") continue;
      const leaf = alias && alias !== "." ? alias : importPath.split("/").pop() || importPath;
      importRanges.push({ start: node.startIndex, end: node.endIndex });
      importedSymbols.add(leaf);
      localToExported.set(leaf, leaf);
      usages.push({
        packageName,
        filePath,
        line: node.startPosition.row + 1,
        column: node.startPosition.column + 1,
        importPath,
        importedSymbols: [leaf],
        bindingKind: alias ? "namespace" : "named",
        usageType: "import",
      });
    }
  }
  if (usages.length === 0) return null;

  for (const id of root.descendantsOfType("identifier")) {
    const name = nodeText(id);
    if (!localToExported.has(name)) continue;
    if (importRanges.some((r) => id.startIndex >= r.start && id.startIndex < r.end)) continue;
    if (isGoShadowed(id, name)) continue;
    usedSymbols.add(name);
    symbolReferences.push({
      symbol: name,
      filePath,
      line: id.startPosition.row + 1,
      column: id.startPosition.column + 1,
    });
  }

  return { filePath, usages, symbolReferences, importedSymbols, usedSymbols };
}

function isGoShadowed(id: TSNode, name: string): boolean {
  let cur: TSNode | null = id.parent;
  while (cur) {
    if (cur.type === "function_declaration" || cur.type === "method_declaration" || cur.type === "func_literal" || cur.type === "block") {
      for (const p of cur.descendantsOfType("parameter_declaration")) {
        for (const ident of p.descendantsOfType("identifier")) {
          if (nodeText(ident) === name && ident.startIndex !== id.startIndex) return true;
        }
      }
      for (const short of cur.namedChildren.filter((c) => c.type === "short_var_declaration")) {
        for (const ident of short.descendantsOfType("identifier")) {
          if (nodeText(ident) === name && ident.startIndex < id.startIndex) return true;
        }
      }
    }
    cur = cur.parent;
  }
  return false;
}

function analyzeJavaTree(root: TSNode, filePath: string, packageName: string): FileUsageSummary | null {
  const artifactId = packageName.includes(":") ? packageName.split(":")[1] : packageName;
  const groupId = packageName.includes(":") ? packageName.split(":")[0] : "";
  const hints = [artifactId.replace(/-/g, ".").toLowerCase(), groupId.toLowerCase()].filter(Boolean);

  const usages: DependencyUsage[] = [];
  const importedSymbols = new Set<string>();
  const usedSymbols = new Set<string>();
  const symbolReferences: SymbolReference[] = [];
  const localToExported = new Map<string, string>();
  const importRanges: { start: number; end: number }[] = [];

  for (const node of root.descendantsOfType("import_declaration")) {
    const text = nodeText(node);
    const lower = text.toLowerCase();
    if (!hints.some((h) => h && lower.includes(h))) continue;
    // import [static] a.b.C;
    const ids = node.descendantsOfType("identifier");
    const leaf = ids.length ? nodeText(ids[ids.length - 1]) : text;
    importRanges.push({ start: node.startIndex, end: node.endIndex });
    importedSymbols.add(leaf);
    localToExported.set(leaf, leaf);
    usages.push({
      packageName,
      filePath,
      line: node.startPosition.row + 1,
      column: node.startPosition.column + 1,
      importPath: text.replace(/^import\s+(static\s+)?/, "").replace(/;$/, "").trim(),
      importedSymbols: [leaf],
      bindingKind: text.includes(".*") ? "namespace" : "named",
      usageType: "import",
    });
  }
  if (usages.length === 0) return null;

  for (const id of root.descendantsOfType("identifier")) {
    const name = nodeText(id);
    if (!localToExported.has(name)) continue;
    if (importRanges.some((r) => id.startIndex >= r.start && id.startIndex < r.end)) continue;
    if (isJavaShadowed(id, name)) continue;
    usedSymbols.add(name);
    symbolReferences.push({
      symbol: name,
      filePath,
      line: id.startPosition.row + 1,
      column: id.startPosition.column + 1,
    });
  }

  return { filePath, usages, symbolReferences, importedSymbols, usedSymbols };
}

function isJavaShadowed(id: TSNode, name: string): boolean {
  let cur: TSNode | null = id.parent;
  while (cur) {
    if (
      cur.type === "method_declaration" ||
      cur.type === "constructor_declaration" ||
      cur.type === "lambda_expression" ||
      cur.type === "block"
    ) {
      for (const p of cur.descendantsOfType("formal_parameter")) {
        for (const ident of p.descendantsOfType("identifier")) {
          if (nodeText(ident) === name && ident.startIndex !== id.startIndex) return true;
        }
      }
      for (const local of cur.namedChildren.filter((c) => c.type === "local_variable_declaration")) {
        for (const ident of local.descendantsOfType("identifier")) {
          if (nodeText(ident) === name && ident.startIndex < id.startIndex) return true;
        }
      }
    }
    cur = cur.parent;
  }
  return false;
}
