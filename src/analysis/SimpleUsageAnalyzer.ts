import { DependencyUsage, FileUsageSummary, SymbolReference } from "../models/DependencyUsage";

export type SimpleLanguage = "rust" | "go" | "java";

/**
 * Regex fallback usage detection for Rust, Go, and Java.
 *
 * Primary path is `TreeSitterUsageAnalyzer` (real AST + lexical shadowing via
 * web-tree-sitter WASM). This class is used only when WASM init/parse fails.
 *
 * Improvements over a naive scan:
 * - Line/block comments and string literals are masked before matching
 * - Rust: `use`, `extern crate`, braced multi-import, `as` aliases
 * - Go: single and parenthesized import blocks, aliases, dot/blank imports
 * - Java/Kotlin-style: normal and static imports, wildcards
 *
 * Shadowing is *not* tracked here — that is the tree-sitter path's job.
 */
export class SimpleUsageAnalyzer {
  analyzeSource(
    source: string,
    filePath: string,
    packageName: string,
    language: SimpleLanguage
  ): FileUsageSummary | null {
    switch (language) {
      case "rust":
        return analyzeRust(source, filePath, packageName);
      case "go":
        return analyzeGo(source, filePath, packageName);
      case "java":
        return analyzeJava(source, filePath, packageName);
      default:
        return null;
    }
  }
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

/**
 * Mask comments (and optionally string literals) so scanners ignore noise.
 * For Go/Java import detection we must keep string contents (import paths live
 * inside quotes); pass `maskStrings: false` in that case.
 */
function maskNoise(source: string, language: SimpleLanguage, maskStrings = true): string {
  const out: string[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const n = source[i + 1];

    // Line comment
    if (c === "/" && n === "/" && language !== "rust") {
      out.push(" ");
      i += 2;
      while (i < source.length && source[i] !== "\n") {
        out.push(" ");
        i++;
      }
      continue;
    }
    if (language === "rust" && c === "/" && n === "/") {
      out.push(" ");
      i += 2;
      while (i < source.length && source[i] !== "\n") {
        out.push(" ");
        i++;
      }
      continue;
    }
    // Block comment /* */ or Rust //! already handled as line; /** */
    if (c === "/" && n === "*") {
      out.push("  ");
      i += 2;
      while (i < source.length - 1 && !(source[i] === "*" && source[i + 1] === "/")) {
        out.push(source[i] === "\n" ? "\n" : " ");
        i++;
      }
      out.push("  ");
      i += 2;
      continue;
    }
    // Double-quoted string
    if (maskStrings && c === '"') {
      out.push(" ");
      i++;
      while (i < source.length) {
        if (source[i] === "\\") {
          out.push("  ");
          i += 2;
          continue;
        }
        if (source[i] === '"') {
          out.push(" ");
          i++;
          break;
        }
        out.push(source[i] === "\n" ? "\n" : " ");
        i++;
      }
      continue;
    }
    // Raw string Rust r#"..."#  — simplified: r"..." 
    if (language === "rust" && c === "r" && (n === '"' || n === "#")) {
      // fall through to char copy for simplicity of raw strings edge cases
    }
    out.push(c);
    i++;
  }
  return out.join("");
}

function analyzeRust(source: string, filePath: string, packageName: string): FileUsageSummary | null {
  const rustName = packageName.replace(/-/g, "_");
  const masked = maskNoise(source, "rust");
  const usages: DependencyUsage[] = [];
  const importedSymbols = new Set<string>();
  const usedSymbols = new Set<string>();
  const symbolReferences: SymbolReference[] = [];
  const importLines = new Set<number>();

  // use foo::bar::{Baz, Qux as Q};
  // use foo::bar as baz;
  // extern crate foo;
  const useRe = new RegExp(
    `^[ \\t]*(?:pub\\s+)?use\\s+(?:crate::)?${rustName}(?:::([\\w:{}\\s,]+))?|extern\\s+crate\\s+${rustName}`,
    "gm"
  );

  let matched = false;
  for (const m of masked.matchAll(useRe)) {
    matched = true;
    const line = lineOf(masked, m.index ?? 0);
    importLines.add(line);
    const rest = m[1]?.trim();
    const symbols: string[] = [];
    if (rest) {
      // Brace group or single path
      const brace = /^\{([^}]+)\}$/.exec(rest);
      const items = brace ? brace[1].split(",") : [rest];
      for (const raw of items) {
        const item = raw.trim();
        if (!item || item === "self" || item === "super") continue;
        const asMatch = /^([\w:]+)\s+as\s+(\w+)$/.exec(item);
        if (asMatch) {
          symbols.push(asMatch[2]);
          importedSymbols.add(asMatch[2]);
        } else {
          const leaf = item.split("::").pop()!;
          symbols.push(leaf);
          importedSymbols.add(leaf);
        }
      }
    } else {
      symbols.push(rustName);
      importedSymbols.add(rustName);
    }
    usages.push({
      packageName,
      filePath,
      line,
      column: 1,
      importPath: rustName,
      importedSymbols: symbols,
      bindingKind: "named",
      usageType: "import",
    });
  }
  if (!matched) return null;

  for (const sym of importedSymbols) {
    const re = new RegExp(`\\b${sym}\\b`, "g");
    for (const m of masked.matchAll(re)) {
      const line = lineOf(masked, m.index ?? 0);
      if (importLines.has(line)) continue;
      usedSymbols.add(sym);
      symbolReferences.push({ symbol: sym, filePath, line, column: 1 });
    }
  }

  return { filePath, usages, symbolReferences, importedSymbols, usedSymbols };
}

function analyzeGo(source: string, filePath: string, packageName: string): FileUsageSummary | null {
  // Keep quoted import paths; only strip comments
  const masked = maskNoise(source, "go", false);
  const usages: DependencyUsage[] = [];
  const importedSymbols = new Set<string>();
  const usedSymbols = new Set<string>();
  const symbolReferences: SymbolReference[] = [];
  const importLines = new Set<number>();

  // Collect import block contents and single-line imports
  const blockRe = /import\s*\(([\s\S]*?)\)/g;
  const singles: { alias: string | null; path: string; index: number }[] = [];

  for (const m of masked.matchAll(blockRe)) {
    const block = m[1];
    const blockStart = (m.index ?? 0) + m[0].indexOf("(");
    const lineImport = /^\s*(?:(\w+|\.|_)\s+)?"([^"]+)"/gm;
    for (const li of block.matchAll(lineImport)) {
      singles.push({
        alias: li[1] ?? null,
        path: li[2],
        index: blockStart + (li.index ?? 0),
      });
    }
  }

  const singleRe = /^[ \t]*import\s+(?:(\w+|\.|_)\s+)?"([^"]+)"/gm;
  for (const m of masked.matchAll(singleRe)) {
    singles.push({ alias: m[1] ?? null, path: m[2], index: m.index ?? 0 });
  }

  let matched = false;
  for (const s of singles) {
    if (!s.path.startsWith(packageName) && s.path !== packageName) continue;
    // Allow subpackages: packageName is module root
    if (!(s.path === packageName || s.path.startsWith(packageName + "/"))) continue;
    matched = true;
    const line = lineOf(masked, s.index);
    importLines.add(line);
    const leaf =
      s.alias && s.alias !== "." && s.alias !== "_"
        ? s.alias
        : s.path.split("/").pop() || s.path;
    if (s.alias === "_") continue; // blank import - side effect only
    importedSymbols.add(leaf);
    usages.push({
      packageName,
      filePath,
      line,
      column: 1,
      importPath: s.path,
      importedSymbols: [leaf],
      bindingKind: s.alias ? "namespace" : "named",
      usageType: "import",
    });
  }
  if (!matched) return null;

  for (const sym of importedSymbols) {
    const re = new RegExp(`\\b${sym}\\b`, "g");
    for (const m of masked.matchAll(re)) {
      const line = lineOf(masked, m.index ?? 0);
      if (importLines.has(line)) continue;
      usedSymbols.add(sym);
      symbolReferences.push({ symbol: sym, filePath, line, column: 1 });
    }
  }

  return { filePath, usages, symbolReferences, importedSymbols, usedSymbols };
}

function analyzeJava(source: string, filePath: string, packageName: string): FileUsageSummary | null {
  const masked = maskNoise(source, "java", false);
  const artifactId = packageName.includes(":") ? packageName.split(":")[1] : packageName;
  const groupId = packageName.includes(":") ? packageName.split(":")[0] : "";
  // Typical Java package often mirrors group or artifact
  const hints = new Set<string>();
  if (artifactId) hints.add(artifactId.replace(/-/g, ".").toLowerCase());
  if (artifactId) hints.add(artifactId.replace(/-/g, "").toLowerCase());
  if (groupId) {
    const parts = groupId.toLowerCase().split(".");
    for (let i = 1; i <= parts.length; i++) {
      hints.add(parts.slice(0, i).join("."));
    }
  }

  const importRe = /^[ \t]*import\s+(static\s+)?([\w.]+(?:\.\*)?)\s*;?/gm;
  const usages: DependencyUsage[] = [];
  const importedSymbols = new Set<string>();
  const usedSymbols = new Set<string>();
  const symbolReferences: SymbolReference[] = [];
  const importLines = new Set<number>();
  let matched = false;

  for (const m of masked.matchAll(importRe)) {
    const importPath = m[2];
    const lower = importPath.toLowerCase();
    const hitsHint = [...hints].some((h) => h && lower.includes(h));
    if (!hitsHint && !lower.startsWith(packageName.toLowerCase())) continue;

    matched = true;
    const line = lineOf(masked, m.index ?? 0);
    importLines.add(line);
    const leaf = importPath.endsWith(".*") ? importPath.slice(0, -2).split(".").pop()! : importPath.split(".").pop()!;
    importedSymbols.add(leaf);
    usages.push({
      packageName,
      filePath,
      line,
      column: 1,
      importPath,
      importedSymbols: [leaf],
      bindingKind: importPath.endsWith(".*") ? "namespace" : "named",
      usageType: "import",
    });
  }
  if (!matched) return null;

  for (const sym of importedSymbols) {
    const simple = sym.includes(".") ? sym.split(".").pop()! : sym;
    const re = new RegExp(`\\b${simple}\\b`, "g");
    for (const m of masked.matchAll(re)) {
      const line = lineOf(masked, m.index ?? 0);
      if (importLines.has(line)) continue;
      usedSymbols.add(simple);
      symbolReferences.push({ symbol: simple, filePath, line, column: 1 });
    }
  }

  return { filePath, usages, symbolReferences, importedSymbols, usedSymbols };
}
