import { extractExactPin, parseRequirementString } from "./pythonRequirementParser";

export interface RequirementsTxtEntry {
  name: string;
  declaredRange: string;
  /** Set when the line is an exact `==` pin, which in Python projects commonly serves the role a lockfile plays elsewhere. */
  exactVersion?: string;
}

/**
 * Parses a `requirements.txt` file: one requirement per line, `#` starts
 * a comment, and lines starting with `-` are pip options (`-r other.txt`,
 * `--index-url ...`, `-e .`) rather than dependencies, and are skipped.
 */
export function parseRequirementsTxt(content: string): RequirementsTxtEntry[] {
  const entries: RequirementsTxtEntry[] = [];

  for (const rawLine of content.split("\n")) {
    const withoutComment = rawLine.split("#")[0];
    const line = withoutComment.trim();
    if (!line || line.startsWith("-")) continue;

    const parsed = parseRequirementString(line);
    if (!parsed) continue;

    const exactVersion = extractExactPin(parsed.declaredRange);
    entries.push({ name: parsed.name, declaredRange: parsed.declaredRange, exactVersion });
  }

  return entries;
}
