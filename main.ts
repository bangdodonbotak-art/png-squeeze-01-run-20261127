// Racer 3 — png-squeeze-01. Own implementation, written from scratch:
// own PNG decoder/encoder, own filter search, Node built-in zlib for deflate.
// Deterministic: fixed candidate sets, no clock, no randomness.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync, constants } from 'node:zlib';

const W = 1280;
const H = 720;
const N = W * H;

// ---------- CRC-32 (PNG, ISO 3309) ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(bytes, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ---------- PNG writer ----------
const SIG = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  out[4] = type.charCodeAt(0); out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2); out[7] = type.charCodeAt(3);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}
function ihdr(ct) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, W); v.setUint32(4, H);
  d[8] = 8; d[9] = ct;
  return d;
}
function pngOf(ct, plte, trns, idat) {
  const parts = [SIG, chunk('IHDR', ihdr(ct))];
  if (plte) parts.push(chunk('PLTE', plte));
  if (trns) parts.push(chunk('tRNS', trns));
  parts.push(chunk('IDAT', idat));
  parts.push(chunk('IEND', new Uint8Array(0)));
  let size = 0;
  for (const p of parts) size += p.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// ---------- PNG decoder (input is stored type-6, but handle all filters) ----------
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}
function decodePng(bytes) {
  // signature + chunks; collect IDAT
  let at = 8;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let idatLen = 0;
  const idatParts = [];
  while (at < bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    if (type === 'IDAT') { idatParts.push(data); idatLen += len; }
    if (type === 'IEND') break;
    at += 12 + len;
  }
  const idat = new Uint8Array(idatLen);
  let o = 0;
  for (const p of idatParts) { idat.set(p, o); o += p.length; }
  const raw = inflateSync(idat);
  const stride = W * 4;
  const rgba = new Uint8Array(N * 4);
  for (let y = 0; y < H; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const prev = y > 0 ? dst - stride : -1;
    if (ft === 0) {
      rgba.set(raw.subarray(src, src + stride), dst);
    } else if (ft === 1) {
      for (let i = 0; i < stride; i++) rgba[dst + i] = (raw[src + i] + (i >= 4 ? rgba[dst + i - 4] : 0)) & 0xff;
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) rgba[dst + i] = (raw[src + i] + (prev >= 0 ? rgba[prev + i] : 0)) & 0xff;
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) {
        const a = i >= 4 ? rgba[dst + i - 4] : 0;
        const b = prev >= 0 ? rgba[prev + i] : 0;
        rgba[dst + i] = (raw[src + i] + ((a + b) >> 1)) & 0xff;
      }
    } else {
      for (let i = 0; i < stride; i++) {
        const a = i >= 4 ? rgba[dst + i - 4] : 0;
        const b = prev >= 0 ? rgba[prev + i] : 0;
        const c = prev >= 0 && i >= 4 ? rgba[prev + i - 4] : 0;
        rgba[dst + i] = (raw[src + i] + paeth(a, b, c)) & 0xff;
      }
    }
  }
  return rgba;
}

// ---------- Analysis ----------
function analyse(rgba) {
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, N);
  for (let i = 0, d = 0; i < N; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  let colours = null;
  if (!many) {
    colours = [];
    for (const [word, count] of counts) {
      const b = new Uint8Array(Uint32Array.of(word).buffer);
      colours.push({ r: b[0], g: b[1], b: b[2], a: b[3], word, count });
    }
  }
  return { opaque, grey, colours };
}

// Single fully-transparent value usable as a tRNS key, or null.
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function samplesOf(rgba, ct) {
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(N * ch);
  for (let i = 0, d = 0, s = 0; i < N; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) { out[s] = rgba[d]; out[s + 1] = rgba[d + 3]; }
    else { out[s] = rgba[d]; out[s + 1] = rgba[d + 1]; out[s + 2] = rgba[d + 2]; }
  }
  return out;
}

// ---------- Palette ----------
function paletteForm(rgba, colours, order) {
  const lum = (c) => 299 * c.r + 587 * c.g + 114 * c.b;
  const entries = [...colours].sort((x, y) => {
    const ta = x.a === 255 ? 1 : 0;
    const tb = y.a === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.a !== y.a) return x.a - y.a;
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
  const index = new Map();
  entries.forEach((c, i) => index.set(c.word, i));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.r; plte[i * 3 + 1] = c.g; plte[i * 3 + 2] = c.b;
    if (c.a !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.a);
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, N);
  const indices = new Uint8Array(N);
  for (let i = 0; i < N; i++) indices[i] = index.get(u32[i]);
  return { plte, trns, indices };
}

// ---------- Filters ----------
function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) { out.set(cur); return; }
  if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = (cur[i] - (i >= bpp ? cur[i - bpp] : 0)) & 0xff;
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = (cur[i] - (prev ? prev[i] : 0)) & 0xff;
  } else if (type === 3) {
    for (let i = 0; i < n; i++) out[i] = (cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev ? prev[i] : 0)) >> 1)) & 0xff;
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= bpp ? prev[i - bpp] : 0;
      out[i] = (cur[i] - paeth(a, b, c)) & 0xff;
    }
  }
}
function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}
function pairsOf(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) { seen[pair] = stamp; n++; }
  }
  return n;
}

const BRUTE_CONTEXT = 32768;
// Build filtered data for one form + filter choice. choice: number | 'minsum' | 'pairs' | 'brute'
function filtered(samples, bpp, choice) {
  const stride = W * bpp;
  const raw = new Uint8Array(H * (stride + 1));
  const trial = [];
  for (let t = 0; t < 5; t++) trial.push(new Uint8Array(stride + 1));
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < H; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      trial[t][0] = t;
      filterRow(t, cur, prev, bpp, trial[t].subarray(1));
      let cost;
      if (choice === 'minsum') cost = signedSum(trial[t].subarray(1));
      else if (choice === 'pairs') cost = pairsOf(trial[t].subarray(1), seen, ++stamp);
      else {
        cost = deflateSync(trial[t], before.length === 0
          ? { level: 4, memLevel: 9 }
          : { level: 4, memLevel: 9, dictionary: before }).length;
      }
      if (cost < best) { best = cost; type = t; }
    }
    trial[type][0] = type;
    raw.set(trial[type], at);
  }
  return raw;
}

// ---------- Deflate candidates ----------
// Screen at level 6, then re-compress the winner at level 9 with a couple of
// configs and keep the smallest. All fixed, deterministic.
const SCREEN = { level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY };
const FINAL = [
  { level: 9, memLevel: 9, strategy: constants.Z_DEFAULT_STRATEGY },
  { level: 9, memLevel: 9, strategy: constants.Z_FILTERED },
  { level: 9, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY },
];

function compressBest(raw, overhead) {
  // returns {zlib, bytes} smallest total (zlib + overhead)
  let best = null;
  const s = deflateSync(raw, SCREEN);
  best = { zlib: s, bytes: s.length + overhead };
  for (const cfg of FINAL) {
    const z = deflateSync(raw, cfg);
    const b = z.length + overhead;
    if (b < best.bytes) best = { zlib: z, bytes: b };
  }
  return best;
}

// ---------- Per-image encode ----------
function encodeImage(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    for (const order of ['count', 'luminance']) {
      const p = paletteForm(rgba, colours, order);
      forms.push({
        ct: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns,
        filters: order === 'count' ? [0, 'minsum', 'brute'] : [0, 'minsum', 'brute'],
      });
    }
    if (!grey) {
      return finish(forms);
    }
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct;
  let trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({
    ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns,
    filters: [0, 1, 2, 4, 'minsum', 'pairs', 'brute'],
  });
  return finish(forms);
}

function finish(forms) {
  let best = null;
  for (const form of forms) {
    const overhead = (form.plte ? 12 + form.plte.length : 0) + (form.trns ? 12 + form.trns.length : 0);
    for (const choice of form.filters) {
      const data = filtered(form.samples, form.bpp, choice);
      // Screen cheaply at level 6 first; only the overall winner gets level-9 tries.
      const s = deflateSync(data, SCREEN);
      const bytes = s.length + overhead;
      if (best === null || bytes < best.bytes) {
        best = { form, data, screenZlib: s, bytes };
      }
    }
  }
  // Re-compress the winner's filtered data at level 9 with several configs.
  let zlib = best.screenZlib;
  let bytes = best.bytes;
  for (const cfg of FINAL) {
    const z = deflateSync(best.data, cfg);
    const b = z.length + (best.form.plte ? 12 + best.form.plte.length : 0) + (best.form.trns ? 12 + best.form.trns.length : 0);
    if (b < bytes) { zlib = z; bytes = b; }
  }
  return pngOf(best.form.ct, best.form.plte, best.form.trns, zlib);
}

// ---------- Main ----------
const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const rgba = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  const out = encodeImage(rgba);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), out);
}
