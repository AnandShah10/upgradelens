// Procedurally paints a clean, anti-aliased icon - a magnifying glass with
// an upward "upgrade" chevron inside the lens, on a rounded diagonal-
// gradient background - and encodes it as a real PNG using only Node's
// built-in zlib. Anti-aliasing is done via supersampling (each output pixel
// is the average of a grid of sub-samples) rather than a real rasterizer,
// which needs no image library dependency for a one-time build asset.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SIZE = 128;
const SUPERSAMPLE = 4; // 4x4 = 16 sub-samples per output pixel

// Brand palette: a deep-to-mid blue diagonal gradient background, a white
// magnifying glass, and a warm accent color for the "upgrade" arrow so it
// pops against the glass instead of blending into it.
const BG_TOP_LEFT = [30, 64, 148];
const BG_BOTTOM_RIGHT = [56, 122, 204];
const GLASS = [255, 255, 255];
const ARROW = [255, 176, 59];

const CORNER_RADIUS = 26;
const GLASS_CX = 58;
const GLASS_CY = 58;
const GLASS_R = 30;
const RING_WIDTH = 9;
const HANDLE_LEN = 26;
const HANDLE_WIDTH = 10;

function isInsideRoundedRect(x, y, size, radius) {
  const cx = Math.min(Math.max(x, radius), size - radius);
  const cy = Math.min(Math.max(y, radius), size - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const lenSq = abx * abx + aby * aby;
  let t = lenSq === 0 ? 0 : ((px - ax) * abx + (py - ay) * aby) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projX = ax + t * abx;
  const projY = ay + t * aby;
  return Math.hypot(px - projX, py - projY);
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Returns the RGBA color for one infinitely-thin sample point (no AA at this level - AA comes from averaging many of these per output pixel). */
function sampleColor(x, y) {
  if (!isInsideRoundedRect(x, y, SIZE, CORNER_RADIUS)) return null; // transparent outside the rounded card

  const t = Math.max(0, Math.min(1, (x + y) / (SIZE * 2)));
  const bg = mix(BG_TOP_LEFT, BG_BOTTOM_RIGHT, t);

  // Magnifying glass handle (drawn first so the ring can sit visually "in front").
  const handleStart = { x: GLASS_CX + GLASS_R * 0.66, y: GLASS_CY + GLASS_R * 0.66 };
  const handleEnd = { x: handleStart.x + HANDLE_LEN * 0.72, y: handleStart.y + HANDLE_LEN * 0.72 };
  const dHandle = distToSegment(x, y, handleStart.x, handleStart.y, handleEnd.x, handleEnd.y);
  if (dHandle <= HANDLE_WIDTH / 2) return [...GLASS, 255];

  // Magnifying glass ring.
  const dRing = Math.hypot(x - GLASS_CX, y - GLASS_CY);
  const inRing = dRing <= GLASS_R && dRing >= GLASS_R - RING_WIDTH;

  // Upward "upgrade" chevron, centered inside the lens.
  const apexX = GLASS_CX;
  const apexY = GLASS_CY - GLASS_R * 0.42;
  const legDX = GLASS_R * 0.46;
  const legDY = GLASS_R * 0.5;
  const dLeftLeg = distToSegment(x, y, apexX, apexY, apexX - legDX, apexY + legDY);
  const dRightLeg = distToSegment(x, y, apexX, apexY, apexX + legDX, apexY + legDY);
  const inChevron = Math.min(dLeftLeg, dRightLeg) <= 5.5;

  if (inChevron) return [...ARROW, 255];
  if (inRing) return [...GLASS, 255];

  return [...bg, 255];
}

function pixelColor(px, py) {
  // Supersample: average many sub-pixel samples to anti-alias every edge
  // (rounded corners, the ring, the chevron, the handle) at once.
  let r = 0,
    g = 0,
    b = 0,
    a = 0;
  const step = 1 / SUPERSAMPLE;
  const offset = step / 2;
  for (let sy = 0; sy < SUPERSAMPLE; sy++) {
    for (let sx = 0; sx < SUPERSAMPLE; sx++) {
      const sampleX = px + offset + sx * step;
      const sampleY = py + offset + sy * step;
      const c = sampleColor(sampleX, sampleY);
      if (c) {
        r += c[0];
        g += c[1];
        b += c[2];
        a += c[3];
      }
    }
  }
  const n = SUPERSAMPLE * SUPERSAMPLE;
  if (a === 0) return [0, 0, 0, 0];
  // Un-premultiply: channels were summed including fully-transparent (0,0,0,0)
  // samples, so average by total sample count for alpha, but by "opaque hit
  // count" for color so background-adjacent edges don't darken toward black.
  const opaqueHits = a / 255;
  return [Math.round(r / opaqueHits), Math.round(g / opaqueHits), Math.round(b / opaqueHits), Math.round(a / n)];
}

function crc32(buf) {
  let c;
  const table =
    crc32.table ||
    (crc32.table = (() => {
      const t = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
      }
      return t;
    })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function buildPng() {
  const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
  let offset = 0;
  for (let y = 0; y < SIZE; y++) {
    raw[offset++] = 0; // filter type: none
    for (let x = 0; x < SIZE; x++) {
      const [r, g, bch, alpha] = pixelColor(x, y);
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = bch;
      raw[offset++] = alpha;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = zlib.deflateSync(raw, { level: 9 });

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

const outPath = path.join(__dirname, "..", "resources", "icon.png");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, buildPng());
console.log(`UpgradeLens: generated icon at ${outPath}`);
