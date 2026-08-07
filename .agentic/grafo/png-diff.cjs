'use strict';

/**
 * PNG Diff — decodificador/codificador PNG mínimo + comparación de píxeles
 * (v3.17.0). Soporte del snapshot visual de browser-gate.cjs.
 *
 * Cero dependencias nuevas: PNG es zlib (que Node trae) + filtros por
 * scanline. Soporta exactamente lo que producen las capturas de
 * playwright-core: 8 bits por canal, RGB o RGBA, sin entrelazado. Cualquier
 * otro PNG devuelve null y el caller degrada a comparación de bytes — nunca
 * crashea (fail-soft, misma disciplina que todos los gates).
 *
 * La comparación usa tolerancia por canal (default 12/255) para no gritar
 * por el ruido de antialiasing entre corridas del mismo navegador — el
 * objetivo es detectar cambios REALES de layout/color, no diferencias de
 * subpíxel.
 */

const zlib = require('zlib');

// ─── CRC32 (requerido por los chunks PNG al escribir) ───────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// ─── Decodificar ─────────────────────────────────────────────────────────────

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Decodifica un PNG a {width, height, channels, data(Buffer RGBA/RGB plano)}.
 * Devuelve null si el formato no está soportado (nunca lanza).
 */
function decodePNG(buf) {
  try {
    if (!buf || buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
    let pos = 8;
    let width = 0, height = 0, bitDepth = 0, colorType = -1, interlace = 0;
    const idatParts = [];
    while (pos + 8 <= buf.length) {
      const len = buf.readUInt32BE(pos);
      const type = buf.toString('ascii', pos + 4, pos + 8);
      const dataStart = pos + 8;
      if (type === 'IHDR') {
        width = buf.readUInt32BE(dataStart);
        height = buf.readUInt32BE(dataStart + 4);
        bitDepth = buf[dataStart + 8];
        colorType = buf[dataStart + 9];
        interlace = buf[dataStart + 12];
      } else if (type === 'IDAT') {
        idatParts.push(buf.subarray(dataStart, dataStart + len));
      } else if (type === 'IEND') break;
      pos = dataStart + len + 4; // +4 CRC
    }
    // Soporte: 8-bit, RGB (2) o RGBA (6), sin entrelazado — lo que produce playwright
    if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) return null;
    if (!width || !height || !idatParts.length) return null;

    const channels = colorType === 6 ? 4 : 3;
    const raw = zlib.inflateSync(Buffer.concat(idatParts));
    const stride = width * channels;
    const out = Buffer.allocUnsafe(height * stride);

    for (let y = 0; y < height; y++) {
      const filter = raw[y * (stride + 1)];
      const rowIn = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
      const rowOut = out.subarray(y * stride, (y + 1) * stride);
      const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
      for (let x = 0; x < stride; x++) {
        const a = x >= channels ? rowOut[x - channels] : 0;         // izquierda
        const b = prev ? prev[x] : 0;                                // arriba
        const c = (prev && x >= channels) ? prev[x - channels] : 0;  // diagonal
        let v = rowIn[x];
        if (filter === 1) v = (v + a) & 0xFF;
        else if (filter === 2) v = (v + b) & 0xFF;
        else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xFF;
        else if (filter === 4) v = (v + paeth(a, b, c)) & 0xFF;
        rowOut[x] = v;
      }
    }
    return { width, height, channels, data: out };
  } catch { return null; }
}

// ─── Codificar (para la imagen de diff) ──────────────────────────────────────

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** Codifica {width, height, data RGBA} a Buffer PNG (filtro 0, deflate). */
function encodePNG(img) {
  const { width, height, data } = img;
  const stride = width * 4;
  const raw = Buffer.allocUnsafe(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filtro None
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─── Comparar ────────────────────────────────────────────────────────────────

/**
 * Compara dos PNGs (buffers). Devuelve:
 *   { supported, dimsMismatch?, totalPixels, diffPixels, diffPct, diffImage? }
 * - tolerance: delta máximo por canal que se considera "igual" (antialiasing).
 * - Si algún PNG no se puede decodificar → supported:false y el caller decide
 *   (fallback razonable: comparar bytes exactos).
 */
function diffPNG(bufA, bufB, opts) {
  const tolerance = (opts && opts.tolerance) != null ? opts.tolerance : 12;
  const wantDiffImage = !opts || opts.diffImage !== false;

  const a = decodePNG(bufA);
  const b = decodePNG(bufB);
  if (!a || !b) return { supported: false };
  if (a.width !== b.width || a.height !== b.height) {
    return {
      supported: true, dimsMismatch: true,
      dimsA: `${a.width}x${a.height}`, dimsB: `${b.width}x${b.height}`,
      totalPixels: a.width * a.height, diffPixels: null, diffPct: null,
    };
  }

  const { width, height } = a;
  const total = width * height;
  let diffPixels = 0;
  const diffData = wantDiffImage ? Buffer.allocUnsafe(total * 4) : null;

  for (let i = 0; i < total; i++) {
    const ia = i * a.channels, ib = i * b.channels;
    const dr = Math.abs(a.data[ia] - b.data[ib]);
    const dg = Math.abs(a.data[ia + 1] - b.data[ib + 1]);
    const db_ = Math.abs(a.data[ia + 2] - b.data[ib + 2]);
    const distinto = dr > tolerance || dg > tolerance || db_ > tolerance;
    if (distinto) diffPixels++;
    if (diffData) {
      const o = i * 4;
      if (distinto) { // rojo pleno donde cambió
        diffData[o] = 255; diffData[o + 1] = 32; diffData[o + 2] = 32; diffData[o + 3] = 255;
      } else {        // referencia atenuada donde no
        const gris = (a.data[ia] * 0.3 + a.data[ia + 1] * 0.59 + a.data[ia + 2] * 0.11) | 0;
        const suave = 128 + (gris >> 1);
        diffData[o] = suave; diffData[o + 1] = suave; diffData[o + 2] = suave; diffData[o + 3] = 255;
      }
    }
  }

  return {
    supported: true,
    dimsMismatch: false,
    width, height,
    totalPixels: total,
    diffPixels,
    diffPct: total ? +(diffPixels * 100 / total).toFixed(3) : 0,
    diffImage: diffData ? encodePNG({ width, height, data: diffData }) : null,
  };
}

module.exports = { decodePNG, encodePNG, diffPNG };
