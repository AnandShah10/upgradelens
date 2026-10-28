/**
 * Parses a single PEP 508 requirement string - the format used both in
 * `requirements.txt` lines and in pyproject.toml's PEP 621
 * `dependencies = [...]` / `optional-dependencies` arrays - into a
 * name + version-range pair.
 *
 * This is intentionally a practical subset, not a full PEP 508 parser:
 * it does not resolve environment markers (`; python_version >= "3.8"`),
 * direct URL/VCS references (`package @ git+https://...`), or nested
 * extras beyond capturing their presence. Those pieces are stripped
 * rather than mis-parsed, which keeps the common case (name + version
 * specifier) accurate rather than attempting - and risking getting wrong
 * - the full grammar.
 */
export interface ParsedRequirement {
  name: string;
  declaredRange: string;
}

const NAME_RE = /^([A-Za-z0-9][A-Za-z0-9._-]*)/;

export function parseRequirementString(raw: string): ParsedRequirement | null {
  // Strip inline comments and environment markers (anything after ";").
  const withoutMarker = raw.split(";")[0].trim();
  if (!withoutMarker) return null;

  // Direct URL / VCS references ("pkg @ git+https://...") aren't a
  // version range we can meaningfully display or compare - skip them
  // rather than misreport a range.
  if (withoutMarker.includes("@")) return null;

  const nameMatch = NAME_RE.exec(withoutMarker);
  if (!nameMatch) return null;
  const name = nameMatch[1];

  // Skip past an optional extras marker, e.g. "requests[security]>=2.28".
  let rest = withoutMarker.slice(name.length);
  const extrasMatch = /^\s*\[[^\]]*\]/.exec(rest);
  if (extrasMatch) rest = rest.slice(extrasMatch[0].length);

  const declaredRange = rest.trim();
  return { name, declaredRange: declaredRange || "*" };
}

/** Extracts the exact pinned version from a requirement's range when it's a plain `==x.y.z` pin. */
export function extractExactPin(declaredRange: string): string | undefined {
  const match = /^==\s*([^\s,]+)/.exec(declaredRange);
  return match ? match[1] : undefined;
}
