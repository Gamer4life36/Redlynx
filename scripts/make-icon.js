#!/usr/bin/env node
/**
 * Turn a generated square image into an application icon.
 *
 *   node scripts/make-icon.js <source.png> <out-base>
 *
 * Three jobs, in order:
 *   1. Remove the flat background. Flood fill inward from the edges rather
 *      than keying a colour, so grey inside the artwork survives while grey
 *      around it does not.
 *   2. Trim to what is left and re-centre it square, so the subject fills the
 *      icon instead of floating in the padding the generator produced.
 *   3. Render every size Windows asks for and pack them into one .ico.
 *
 * Uses the Chromium already in node_modules — canvas does the pixel work and
 * the downscaling, which is the same resampling the browser itself uses.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const src = path.resolve(process.argv[2] || 'branding/source.png');
const outBase = path.resolve(process.argv[3] || 'branding/redlynx');

function icoFrom(pngs) {
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  pngs.forEach((p, i) => {
    const at = 16 * i;
    dir.writeUInt8(p.size >= 256 ? 0 : p.size, at);
    dir.writeUInt8(p.size >= 256 ? 0 : p.size, at + 1);
    dir.writeUInt16LE(1, at + 4);
    dir.writeUInt16LE(32, at + 6);
    dir.writeUInt32LE(p.data.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += p.data.length;
  });
  return Buffer.concat([header, dir, ...pngs.map((p) => p.data)]);
}

const WORK = `
async function build(dataUrl, sizes) {
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });

  const w = img.width, h = img.height;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const id = ctx.getImageData(0, 0, w, h);
  const px = id.data;

  // Background colour is whatever dominates the border ring.
  const samples = [];
  for (let x = 0; x < w; x += 4) {
    samples.push([px[(x) * 4], px[(x) * 4 + 1], px[(x) * 4 + 2]]);
    const bot = ((h - 1) * w + x) * 4;
    samples.push([px[bot], px[bot + 1], px[bot + 2]]);
  }
  for (let y = 0; y < h; y += 4) {
    const l = (y * w) * 4, r = (y * w + w - 1) * 4;
    samples.push([px[l], px[l + 1], px[l + 2]]);
    samples.push([px[r], px[r + 1], px[r + 2]]);
  }
  const bg = samples.reduce((a, s) => [a[0] + s[0], a[1] + s[1], a[2] + s[2]], [0, 0, 0])
    .map((v) => Math.round(v / samples.length));

  // Flood fill inward. Keying by colour alone would punch holes in the grey
  // fur; only background connected to an edge should go.
  const TOL = 42;
  const seen = new Uint8Array(w * h);
  const stack = [];
  for (let x = 0; x < w; x++) { stack.push(x, 0, x, h - 1); }
  for (let y = 0; y < h; y++) { stack.push(0, y, w - 1, y); }

  const near = (i) => {
    const dr = px[i] - bg[0], dg = px[i + 1] - bg[1], db = px[i + 2] - bg[2];
    return Math.sqrt(dr * dr + dg * dg + db * db) <= TOL;
  };

  while (stack.length) {
    const y = stack.pop(), x = stack.pop();
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const p = y * w + x;
    if (seen[p]) continue;
    const i = p * 4;
    if (!near(i)) continue;
    seen[p] = 1;
    px[i + 3] = 0;
    stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
  }

  // Soften the cut edge so the icon does not look chewed at small sizes.
  const copy = new Uint8ClampedArray(px);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x, i = p * 4;
      if (copy[i + 3] === 0) continue;
      let clear = 0;
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        if (copy[((y + dy) * w + (x + dx)) * 4 + 3] === 0) clear++;
      }
      if (clear) px[i + 3] = Math.round(255 * (1 - clear / 6));
    }
  }
  ctx.putImageData(id, 0, 0);

  // Trim to the remaining content, then pad back to a square with a small
  // margin so nothing touches the icon's edge.
  let minX = w, minY = h, maxX = 0, maxY = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (px[(y * w + x) * 4 + 3] > 8) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  const cw = maxX - minX + 1, chh = maxY - minY + 1;
  const side = Math.max(cw, chh);
  const pad = 0;
  const box = side + pad * 2;

  const sq = document.createElement('canvas');
  sq.width = box; sq.height = box;
  const sctx = sq.getContext('2d');
  sctx.drawImage(c, minX, minY, cw, chh,
    Math.round((box - cw) / 2), Math.round((box - chh) / 2), cw, chh);

  const out = {};
  for (const s of sizes) {
    const t = document.createElement('canvas');
    t.width = s; t.height = s;
    const tctx = t.getContext('2d');
    tctx.imageSmoothingEnabled = true;
    tctx.imageSmoothingQuality = 'high';

    // Small sizes get tighter artwork. Shrinking the whole badge into 16px
    // averages the face into a smudge; zooming to the head keeps the eyes and
    // the red behind them, which is what makes it recognisable at a glance.
    // This is why real icon sets ship different drawings per size.
    // Downscaling averages neighbouring pixels, which drains contrast exactly
    // where there is least room for it. Pushing contrast and saturation back
    // at the small sizes is what keeps the eyes and the red disc distinct
    // rather than blending into grey.
    if (s <= 32) tctx.filter = s <= 16 ? 'contrast(1.45) saturate(1.5)' : 'contrast(1.22) saturate(1.28)';
    const zoom = s <= 16 ? 0.95 : 1;
    if (zoom < 1) {
      const keep = Math.round(box * zoom);
      const off = Math.round((box - keep) / 2);
      // Bias upward: the head sits above centre once the badge is cropped.
      const offY = Math.round(off * 0.72);
      tctx.drawImage(sq, off, offY, keep, keep, 0, 0, s, s);
    } else {
      tctx.drawImage(sq, 0, 0, s, s);
    }
    out[s] = t.toDataURL('image/png');
  }
  out.full = sq.toDataURL('image/png');
  out.meta = { bg: bg, trimmed: [cw, chh], box: box };
  return out;
}
build(SRC_DATA_URL, SIZES_JSON);
`;

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const raw = fs.readFileSync(src);
  const dataUrl = 'data:image/png;base64,' + raw.toString('base64');

  const win = new BrowserWindow({ show: false, width: 64, height: 64 });
  await win.loadURL('data:text/html,<meta charset="utf-8"><body></body>');

  const code = WORK
    .replace('SRC_DATA_URL', JSON.stringify(dataUrl))
    .replace('SIZES_JSON', JSON.stringify(SIZES));
  const res = await win.webContents.executeJavaScript(code, true);

  console.log('  background colour detected: rgb(' + res.meta.bg.join(',') + ')');
  console.log('  trimmed to ' + res.meta.trimmed.join('x') + ', squared to ' + res.meta.box);

  const pngs = [];
  for (const s of SIZES) {
    const buf = Buffer.from(res[s].split(',')[1], 'base64');
    fs.writeFileSync(outBase + '-' + s + '.png', buf);
    pngs.push({ size: s, data: buf });
  }
  fs.writeFileSync(outBase + '.png', Buffer.from(res.full.split(',')[1], 'base64'));
  fs.writeFileSync(outBase + '.ico', icoFrom(pngs));
  console.log('  wrote ' + path.basename(outBase) + '.ico with ' + pngs.length + ' sizes');

  win.destroy();
  app.quit();
});
