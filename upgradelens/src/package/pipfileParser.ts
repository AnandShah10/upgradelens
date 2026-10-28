/**
 * Minimal Pipfile + Pipfile.lock support for Python projects.
 *
 * Pipfile is TOML with [packages] and [dev-packages] tables. Values are either
 * a version string ("==1.2.3", "*") or a table ({ version = "...", extras = [...] }).
 * Pipfile.lock is JSON with `default` and `develop` maps of package -> { version: "==x.y.z", ... }.
 */

export interface PipfileDependency {
  name: string;
  declaredRange: string;
  kind: "production" | "development";
}

function rangeFromValue(value: unknown): string {
  if (typeof value === "string") return value === "*" ? "*" : value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const v = (value as Record<string, unknown>).version;
    if (typeof v === "string") return v === "*" ? "*" : v;
  }
  return "*";
}

/**
 * Parse a Pipfile TOML document (already parsed by smol-toml) into dependency entries.
 */
export function parsePipfile(doc: unknown): PipfileDependency[] {
  const out: PipfileDependency[] = [];
  if (!doc || typeof doc !== "object") return out;
  const root = doc as Record<string, unknown>;

  const packages = root["packages"];
  if (packages && typeof packages === "object" && !Array.isArray(packages)) {
    for (const [name, value] of Object.entries(packages as Record<string, unknown>)) {
      out.push({ name, declaredRange: rangeFromValue(value), kind: "production" });
    }
  }

  const dev = root["dev-packages"];
  if (dev && typeof dev === "object" && !Array.isArray(dev)) {
    for (const [name, value] of Object.entries(dev as Record<string, unknown>)) {
      out.push({ name, declaredRange: rangeFromValue(value), kind: "development" });
    }
  }

  return out;
}

/**
 * Parse Pipfile.lock JSON text into package-name -> resolved version (without ==).
 */
export function parsePipfileLock(text: string): Record<string, string> {
  const resolved: Record<string, string> = {};
  try {
    const doc = JSON.parse(text) as {
      default?: Record<string, { version?: string }>;
      develop?: Record<string, { version?: string }>;
    };
    for (const section of [doc.default, doc.develop]) {
      if (!section || typeof section !== "object") continue;
      for (const [name, meta] of Object.entries(section)) {
        const raw = meta?.version;
        if (typeof raw !== "string") continue;
        const ver = raw.startsWith("==") ? raw.slice(2) : raw;
        if (ver && !(name in resolved)) resolved[name] = ver;
      }
    }
  } catch {
    // Malformed lock - treat as absent.
  }
  return resolved;
}
