const EXPORT_PATTERNS: RegExp[] = [
  /export\s+(?:declare\s+)?function\s+([A-Za-z_$][\w$]*)/g,
  /export\s+(?:declare\s+)?class\s+([A-Za-z_$][\w$]*)/g,
  /export\s+(?:declare\s+)?const\s+([A-Za-z_$][\w$]*)/g,
  /export\s+(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/g,
  /export\s+(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)/g,
  /export\s+\{([^}]*)\}/g,
];

/**
 * Extracts top-level exported symbol names from a .d.ts file's text via a
 * lightweight regex scan (not a real TypeScript AST parse). Good enough to
 * answer "does this symbol exist in this version's public surface" for the
 * common declaration shapes (function/class/const/interface/type
 * declarations, and `export { a, b as c }` re-export lists) without adding
 * a TypeScript-compiler-API dependency for what is, for this purpose, a
 * simple set-membership question.
 */
export function extractExportedSymbols(source: string): Set<string> {
  const symbols = new Set<string>();
  for (const pattern of EXPORT_PATTERNS) {
    for (const m of source.matchAll(pattern)) {
      const captured = m[1];
      if (captured.includes(",") || pattern.source.startsWith("export\\s+\\{")) {
        for (const part of captured.split(",")) {
          const name = part.trim().split(/\s+as\s+/).pop()?.trim();
          if (name) symbols.add(name);
        }
      } else if (captured) {
        symbols.add(captured.trim());
      }
    }
  }
  return symbols;
}
