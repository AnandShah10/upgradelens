import * as fs from "fs";
import * as path from "path";
import { extractExportedSymbols } from "./dtsExportExtractor";

/**
 * Reads the *currently installed* version's .d.ts entry point (if any) and
 * extracts top-level exported symbol names via a lightweight regex scan.
 *
 * Scope note: comparing this against the *target* version's type
 * declarations would require installing that version somewhere (even a
 * temp dir) and resolving its entry point, which is real work with real
 * failure modes (private registries, no types published, monorepo type
 * resolution, etc). For the MVP this analyzer answers a narrower, still
 * useful question: "does this symbol currently exist in the installed
 * types?" - which lets the ImpactEngine upgrade a known-changes-db claim
 * from "documented" to "confirmed present today", and downgrade its
 * confidence if the symbol can't be found locally at all. Full two-version
 * diffing is intentionally isolated behind this class so it can be
 * upgraded later without touching callers.
 */
export class ApiAnalyzer {
  /** Best-effort: returns null if types can't be located, never throws. */
  findLocalExportedSymbols(projectRoot: string, packageName: string): Set<string> | null {
    const entry = this.resolveTypesEntryPoint(projectRoot, packageName);
    if (!entry) return null;
    try {
      const text = fs.readFileSync(entry, "utf8");
      return extractExportedSymbols(text);
    } catch {
      return null;
    }
  }

  private resolveTypesEntryPoint(projectRoot: string, packageName: string): string | null {
    const pkgDir = path.join(projectRoot, "node_modules", ...packageName.split("/"));
    const pkgJsonPath = path.join(pkgDir, "package.json");
    if (!fs.existsSync(pkgJsonPath)) return null;

    try {
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
      const declared: string | undefined = pkgJson.types ?? pkgJson.typings;
      if (declared) {
        const resolved = path.join(pkgDir, declared);
        if (fs.existsSync(resolved)) return resolved;
      }
      // Common convention: an index.d.ts alongside the compiled entry point.
      const fallback = path.join(pkgDir, "index.d.ts");
      if (fs.existsSync(fallback)) return fallback;

      // @types/<package> as a fallback for packages that ship no bundled types.
      const scopedName = packageName.startsWith("@")
        ? packageName.slice(1).replace("/", "__")
        : packageName;
      const typesPkgIndex = path.join(projectRoot, "node_modules", "@types", scopedName, "index.d.ts");
      if (fs.existsSync(typesPkgIndex)) return typesPkgIndex;

      return null;
    } catch {
      return null;
    }
  }
}
