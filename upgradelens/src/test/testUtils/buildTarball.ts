import * as zlib from "node:zlib";

function buildTarEntry(name: string, content: Buffer, typeFlag: string = "0"): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  header.write("0000644", 100, "utf8");
  header.write("0000000", 108, "utf8");
  header.write("0000000", 116, "utf8");
  header.write(content.length.toString(8).padStart(11, "0"), 124, "utf8");
  header.write("00000000000", 136, "utf8");
  header.write("        ", 148, "utf8");
  header[156] = typeFlag.charCodeAt(0);
  header.write("ustar", 257, "utf8");
  header.write("00", 263, "utf8");

  let checksum = 0;
  for (const b of header) checksum += b;
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "utf8");

  const paddedSize = Math.ceil(content.length / 512) * 512;
  const contentBlock = Buffer.alloc(paddedSize);
  content.copy(contentBlock);

  return Buffer.concat([header, contentBlock]);
}

function buildPaxRecord(key: string, value: string): string {
  // PAX record: "<total-length> <key>=<value>\n", where total-length
  // includes its own digit count - computed by trying candidate lengths
  // until the digit count stabilizes (standard PAX construction approach).
  let len = key.length + value.length + 3; // " " + "=" + "\n"
  for (;;) {
    const candidate = `${len} ${key}=${value}\n`;
    if (candidate.length === len) return candidate;
    len = candidate.length;
  }
}

/**
 * Builds a synthetic tar entry preceded by a PAX extended header (typeflag
 * 'x') that overrides its path - simulating how real tarballs represent
 * file paths too long for the classic 100-byte ustar name field.
 */
export function buildPaxEntry(longName: string, content: Buffer): Buffer {
  const paxRecord = buildPaxRecord("path", longName);
  const paxContent = Buffer.from(paxRecord, "utf8");
  const paxHeaderBlock = buildTarEntry("PaxHeaders/entry", paxContent, "x");
  // The regular header's own name field is irrelevant once a PAX "path"
  // override is present - real tools write a truncated/placeholder name.
  const regularBlock = buildTarEntry(longName.slice(0, 90), content, "0");
  return Buffer.concat([paxHeaderBlock, regularBlock]);
}

/** Builds a gzipped tar buffer from {name, content} entries - a synthetic stand-in for a downloaded npm tarball. */
export function buildFakeTarball(entries: { name: string; content: string }[]): Buffer {
  const blocks = entries.map((e) => buildTarEntry(e.name, Buffer.from(e.content, "utf8")));
  const end = Buffer.alloc(1024);
  return zlib.gzipSync(Buffer.concat([...blocks, end]));
}
