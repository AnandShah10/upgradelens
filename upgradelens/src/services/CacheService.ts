import * as fs from "fs";
import * as path from "path";

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * A tiny two-tier cache: an in-memory Map for the lifetime of the extension
 * host, backed by a JSON file under the extension's global storage path so
 * repeated analyses across VS Code restarts don't re-hit the npm registry
 * for metadata that rarely changes (published versions are immutable).
 */
export class CacheService {
  private readonly memory = new Map<string, CacheEntry<unknown>>();
  private diskLoaded = false;
  private disk: Record<string, CacheEntry<unknown>> = {};

  constructor(private readonly storageDir: string | undefined, private readonly defaultTtlMs = 1000 * 60 * 60 * 12) {}

  private get diskPath(): string | undefined {
    return this.storageDir ? path.join(this.storageDir, "upgradelens-cache.json") : undefined;
  }

  private loadDiskOnce(): void {
    if (this.diskLoaded) return;
    this.diskLoaded = true;
    const p = this.diskPath;
    if (!p) return;
    try {
      if (fs.existsSync(p)) {
        this.disk = JSON.parse(fs.readFileSync(p, "utf8"));
      }
    } catch {
      // A corrupt cache file should never break analysis - just start fresh.
      this.disk = {};
    }
  }

  private persist(): void {
    const p = this.diskPath;
    if (!p) return;
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(this.disk), "utf8");
    } catch {
      // Best-effort only; an unwritable cache dir should not fail analysis.
    }
  }

  get<T>(key: string): T | undefined {
    const now = Date.now();
    const inMem = this.memory.get(key) as CacheEntry<T> | undefined;
    if (inMem && inMem.expiresAt > now) return inMem.value;

    this.loadDiskOnce();
    const onDisk = this.disk[key] as CacheEntry<T> | undefined;
    if (onDisk && onDisk.expiresAt > now) {
      this.memory.set(key, onDisk);
      return onDisk.value;
    }
    return undefined;
  }

  set<T>(key: string, value: T, ttlMs: number = this.defaultTtlMs): void {
    const entry: CacheEntry<T> = { value, expiresAt: Date.now() + ttlMs };
    this.memory.set(key, entry);
    this.loadDiskOnce();
    this.disk[key] = entry;
    this.persist();
  }
}
