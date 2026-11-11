// Generate the home-screen icons (solid dark square, white check mark) as PNGs with no dependencies.
// Usage: node scripts/make-icons.mjs   (writes public/push-test/icons/icon-<size>.png)
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync, crc32 } from "node:zlib";

const BG = [20, 32, 31], FG = [255, 255, 255];

function png(size) {
  // Check mark as a two-segment polyline in unit coordinates.
  const pts = [[0.27, 0.52], [0.43, 0.68], [0.74, 0.34]];
  const half = 0.045; // half stroke width
  const dist = (px, py, [x1, y1], [x2, y2]) => {
    const dx = x2 - x1, dy = y2 - y1;
    const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  };
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3); // filter byte 0 + RGB
    for (let x = 0; x < size; x++) {
      // 3x3 supersampling for smooth edges
      let cover = 0;
      for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) {
        const px = (x + (sx + 0.5) / 3) / size, py = (y + (sy + 0.5) / 3) / size;
        const d = Math.min(dist(px, py, pts[0], pts[1]), dist(px, py, pts[1], pts[2]));
        if (d <= half) cover++;
      }
      const a = cover / 9;
      for (let c = 0; c < 3; c++) row[1 + x * 3 + c] = Math.round(BG[c] * (1 - a) + FG[c] * a);
    }
    rows.push(row);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0)),
  ]);
}

const dir = new URL("../public/push-test/icons/", import.meta.url);
mkdirSync(dir, { recursive: true });
for (const s of [180, 192, 512]) writeFileSync(new URL(`icon-${s}.png`, dir), png(s));
console.log("wrote icon-180.png, icon-192.png, icon-512.png");
