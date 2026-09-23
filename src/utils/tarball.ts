import * as zlib from "zlib";

export interface TarEntry {
  name: string;
  content: Buffer;
}

/**
 * Parses PAX extended header records: a sequence of
 * "<total-length> <keyword>=<value>\n" entries (the length is the record's
 * own total byte length, digits included), used by tar implementations to
 * carry file names/sizes longer than the classic ustar header fields
 * (100 bytes for a name) can hold.
 */
function parsePaxRecords(content: Buffer): Record<string, string> {
  const records: Record<string, string> = {};
  const text = content.toString("utf8");
  let i = 0;
  while (i < text.length) {
    const spaceIndex = text.indexOf(" ", i);
    if (spaceIndex === -1) break;
    const lenStr = text.slice(i, spaceIndex);
    const len = parseInt(lenStr, 10);
    if (!len || len <= 0 || i + len > text.length) break;
    const record = text.slice(i, i + len);
    const eq = record.indexOf("=", spaceIndex - i);
    if (eq !== -1) {
      const key = record.slice(spaceIndex - i + 1, eq);
      // Records end with "\n"; drop it from the captured value.
      const value = record.slice(eq + 1).replace(/\n$/, "");
      records[key] = value;
    }
    i += len;
  }
  return records;
}

/**
 * Parses a POSIX ustar archive already decompressed into memory, returning
 * every regular file entry. Handles PAX extended headers (typeflag 'x' for
 * the next entry, 'g' as a global default applying until overridden) for
 * file names beyond the classic 100-byte ustar field - the case that
 * actually shows up in real npm tarballs with deeply nested paths. GNU
 * long-name ('L'/'K') extensions, a separate, older mechanism for the same
 * problem, are not handled, as they're rare among npm-published packages
 * (npm's own tarball creation uses PAX, not GNU format).
 */
export function parseTar(buffer: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let globalPaxOverrides: Record<string, string> = {};
  let nextEntryPaxOverrides: Record<string, string> | null = null;

  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    // Two consecutive zeroed blocks mark the end of the archive.
    if (header.every((b) => b === 0)) break;

    const headerName = readString(header, 0, 100);
    if (!headerName) break;

    const sizeField = readString(header, 124, 12).trim();
    const size = sizeField ? parseInt(sizeField, 8) || 0 : 0;
    const typeFlag = String.fromCharCode(header[156]);

    offset += 512;
    const content = buffer.subarray(offset, offset + size);

    if (typeFlag === "x") {
      // Extended header for the immediately following entry.
      nextEntryPaxOverrides = parsePaxRecords(Buffer.from(content));
    } else if (typeFlag === "g") {
      // Global extended header: applies to every following entry until superseded.
      globalPaxOverrides = { ...globalPaxOverrides, ...parsePaxRecords(Buffer.from(content)) };
    } else if (typeFlag === "0" || typeFlag === "\0") {
      const overrides = { ...globalPaxOverrides, ...(nextEntryPaxOverrides ?? {}) };
      const name = overrides.path ?? headerName;
      entries.push({ name, content: Buffer.from(content) });
      nextEntryPaxOverrides = null;
    } else {
      // Directory, symlink, etc. - not a file entry, but a pending
      // per-entry PAX override was meant for it and shouldn't leak forward.
      nextEntryPaxOverrides = null;
    }

    // Advance past this entry's data, padded up to the next 512-byte boundary.
    offset += Math.ceil(size / 512) * 512;
  }

  return entries;
}

function readString(buf: Buffer, start: number, length: number): string {
  const slice = buf.subarray(start, start + length);
  const nullIndex = slice.indexOf(0);
  const trimmed = nullIndex === -1 ? slice : slice.subarray(0, nullIndex);
  return trimmed.toString("utf8");
}

/** Gunzips and parses a full npm tarball buffer into its file entries. */
export function extractTarball(gzippedBuffer: Buffer): TarEntry[] {
  const raw = zlib.gunzipSync(gzippedBuffer);
  return parseTar(raw);
}

/** Strips the conventional single top-level "package/" directory npm tarballs use. */
export function stripPackagePrefix(entryName: string): string {
  const firstSlash = entryName.indexOf("/");
  return firstSlash === -1 ? entryName : entryName.slice(firstSlash + 1);
}
