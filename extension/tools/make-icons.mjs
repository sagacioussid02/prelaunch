// Draws the toolbar and store icons (indigo rounded square, white check)
// into static/icons. Plain Node, no image libraries: run `node tools/make-icons.mjs`.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

const SIZES = [16, 32, 48, 128];
const BG = [79, 70, 229];
const FG = [255, 255, 255];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}
// Distance from point to segment, in unit coordinates.
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function inRoundedSquare(x, y, r) {
  const cx = Math.min(Math.max(x, r), 1 - r), cy = Math.min(Math.max(y, r), 1 - r);
  return Math.hypot(x - cx, y - cy) <= r;
}
function draw(size) {
  const ss = 4, out = Buffer.alloc(size * size * 4);
  const pad = size >= 48 ? 0.06 : 0.02;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let bg = 0, fg = 0;
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const u = (x + (sx + 0.5) / ss) / size, v = (y + (sy + 0.5) / ss) / size;
      const uu = (u - pad) / (1 - 2 * pad), vv = (v - pad) / (1 - 2 * pad);
      if (uu < 0 || uu > 1 || vv < 0 || vv > 1 || !inRoundedSquare(uu, vv, 0.22)) continue;
      bg++;
      const d = Math.min(segDist(uu, vv, 0.26, 0.52, 0.43, 0.69), segDist(uu, vv, 0.43, 0.69, 0.75, 0.33));
      if (d <= 0.075) fg++;
    }
    const n = ss * ss, a = bg / n, f = bg ? fg / bg : 0, i = (y * size + x) * 4;
    for (let k = 0; k < 3; k++) out[i + k] = Math.round(BG[k] * (1 - f) + FG[k] * f);
    out[i + 3] = Math.round(a * 255);
  }
  return png(size, out);
}
const dir = new URL("../static/icons/", import.meta.url);
mkdirSync(dir, { recursive: true });
for (const s of SIZES) writeFileSync(new URL(`icon-${s}.png`, dir), draw(s));
console.log("icons written:", SIZES.join(", "));
