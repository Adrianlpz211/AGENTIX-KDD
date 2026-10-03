'use strict';

/**
 * Referencias visuales con candidato, aprobación y comparación separados.
 *
 *   .agentic/snapshots/<vista>/<variante>/
 *     aprobado.png + aprobado.json   referencia vigente (manifiesto con hash)
 *     candidatos/<id>.png + .json    capturas nuevas, nunca pisan la aprobada
 *     historial/<sha>.png + .json    referencias aprobadas anteriores
 *
 * Una captura nunca reemplaza la referencia: solo `aprobar` lo hace, con
 * aprobador y motivo (persona, cambio intencional o base inicial autorizada).
 * La variante identifica viewport, densidad, tema y estado: 1280x800 no
 * prueba el móvil.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const png = require('./png-diff.cjs');

const VIEWPORT_BASE = { width: 1280, height: 800 };
const ORIGENES = ['humano', 'cambio_intencional', 'baseline_inicial'];
const MASCARA_MAX = 0.2;

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const limpio = (s) => String(s || '').replace(/[^a-z0-9-_]/gi, '_').slice(0, 80);

function variante(v = {}) {
  const w = v.width || VIEWPORT_BASE.width;
  const h = v.height || VIEWPORT_BASE.height;
  return `${w}x${h}@${v.dpr || 1}-${limpio(v.theme || 'light')}-${limpio(v.estado || 'default')}`;
}

function dirDe(root, vista, vari) {
  return path.join(root, '.agentic', 'snapshots', limpio(vista), vari);
}

function guardarCandidato(root, vista, vari, buf, meta = {}) {
  const dir = path.join(dirDe(root, vista, vari), 'candidatos');
  fs.mkdirSync(dir, { recursive: true });
  const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + sha(buf).slice(0, 8);
  const manifest = Object.assign({}, meta, { vista: limpio(vista), variante: vari, sha256: sha(buf), candidato_id: id, capturado_at: new Date().toISOString() });
  fs.writeFileSync(path.join(dir, id + '.png'), buf);
  fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(manifest, null, 2));
  return { id, path: path.join(dir, id + '.png'), manifest };
}

/** Referencia aprobada (o la plana de la v3.17 para la variante base). */
function referencia(root, vista, vari) {
  const dir = dirDe(root, vista, vari);
  const p = path.join(dir, 'aprobado.png');
  if (fs.existsSync(p)) {
    const buf = fs.readFileSync(p);
    let manifest = null;
    try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'aprobado.json'), 'utf8')); } catch { /* sin manifiesto */ }
    if (!manifest) return { ok: false, reason_code: 'REFERENCIA_SIN_MANIFIESTO' };
    if (manifest.sha256 !== sha(buf)) return { ok: false, reason_code: 'REFERENCIA_ALTERADA' };
    return { ok: true, buf, manifest };
  }
  const plana = path.join(root, '.agentic', 'snapshots', limpio(vista) + '.png');
  if (vari === variante() && fs.existsSync(plana)) {
    const buf = fs.readFileSync(plana);
    // La v3.17 sobrescribía esta foto en cada captura: sirve para mirar, no
    // para aprobar un PASS.
    return { ok: true, legacy: true, buf, manifest: { legacy: true, sha256: sha(buf), variante: vari, origen: 'v3.17' } };
  }
  return { ok: false, reason_code: 'SIN_REFERENCIA' };
}

function aprobar(root, vista, vari, candidatoId, decision = {}) {
  const aprobador = String(decision.aprobador || '').trim();
  const motivo = String(decision.motivo || '').trim();
  const origen = decision.origen || 'humano';
  if (!aprobador || !motivo) return { ok: false, reason_code: 'SIN_DECISION' };
  if (!ORIGENES.includes(origen)) return { ok: false, reason_code: 'ORIGEN_INVALIDO' };
  const dir = dirDe(root, vista, vari);
  const cand = path.join(dir, 'candidatos', String(candidatoId) + '.png');
  if (!/^[\w.-]+$/.test(String(candidatoId)) || !fs.existsSync(cand)) return { ok: false, reason_code: 'CANDIDATO_NO_EXISTE' };
  const actual = referencia(root, vista, vari);
  if (origen === 'baseline_inicial' && actual.ok && !actual.legacy) return { ok: false, reason_code: 'YA_HAY_BASE' };
  const buf = fs.readFileSync(cand);
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(cand.replace(/\.png$/, '.json'), 'utf8')); } catch { /* manifiesto del candidato perdido */ }
  if (meta.sha256 && meta.sha256 !== sha(buf)) return { ok: false, reason_code: 'CANDIDATO_ALTERADO' };

  const ap = path.join(dir, 'aprobado.png');
  if (fs.existsSync(ap)) {
    const hist = path.join(dir, 'historial');
    fs.mkdirSync(hist, { recursive: true });
    const viejo = fs.readFileSync(ap);
    const destino = path.join(hist, sha(viejo).slice(0, 16));
    if (!fs.existsSync(destino + '.png')) {
      fs.writeFileSync(destino + '.png', viejo);
      try { fs.copyFileSync(path.join(dir, 'aprobado.json'), destino + '.json'); } catch { /* sin manifiesto previo */ }
    }
  }
  const manifest = Object.assign({}, meta, {
    sha256: sha(buf), aprobado_por: aprobador, motivo, origen, aprobado_at: new Date().toISOString(),
    reemplaza: actual.ok ? actual.manifest.sha256 : null,
  });
  fs.writeFileSync(ap, buf);
  fs.writeFileSync(path.join(dir, 'aprobado.json'), JSON.stringify(manifest, null, 2));
  return { ok: true, manifest };
}

function dentro(px, py, r) { return px >= r.x && py >= r.y && px < r.x + r.w && py < r.y + r.h; }
const solapan = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Compara contra la referencia. Máscaras: solo regiones dinámicas
 * documentadas (con motivo), nunca sobre una región protegida y nunca más
 * del 20% de la imagen. Cada región protegida tiene su propia tolerancia.
 */
const CAMPOS_MANIFIESTO = ['project_id', 'fixture_hash', 'language', 'locale', 'browser', 'browser_major', 'theme', 'estado'];

function mayorBrowser(nombre) {
  const m = String(nombre || '').match(/(\d+)/);
  return m ? m[1] : String(nombre || '');
}

function compatibleManifiesto(ref, actual = {}) {
  if (!ref || ref.legacy) return { ok: true, legacy: !!ref };
  const fallos = [];
  const identidad = (campo) => {
    if (ref[campo] == null && actual[campo] == null) return;
    if (ref[campo] == null || actual[campo] == null || String(ref[campo]) !== String(actual[campo])) fallos.push(campo);
  };
  const opcional = (campo) => {
    if (ref[campo] != null && actual[campo] != null && String(ref[campo]) !== String(actual[campo])) fallos.push(campo);
  };
  identidad('project_id');
  identidad('fixture_hash');
  identidad('language');
  opcional('locale');
  opcional('theme');
  opcional('estado');
  const rb = ref.browser_major || mayorBrowser(ref.browser);
  const ab = actual.browser_major || mayorBrowser(actual.browser);
  if (rb && ab && rb !== ab) fallos.push('browser');
  if (fallos.length) return { ok: false, reason_code: 'MANIFIESTO_INCOMPATIBLE', campos: fallos };
  return { ok: true };
}

function comparar(refBuf, buf, opts = {}) {
  const umbral = opts.threshold != null ? opts.threshold : 0.5;
  const tolerancia = opts.tolerance != null ? opts.tolerance : 12;
  const mascaras = opts.mascaras || [];
  const regiones = opts.regiones || [];
  const a = png.decodePNG(refBuf);
  const b = png.decodePNG(buf);
  if (!a || !b) return { status: 'UNVERIFIED', reason_code: 'FORMATO_NO_SOPORTADO' };
  if (a.width !== b.width || a.height !== b.height) {
    return { status: 'FAIL', reason_code: 'DIMENSIONES', ref: `${a.width}x${a.height}`, actual: `${b.width}x${b.height}` };
  }
  if (mascaras.some((m) => !String(m.motivo || '').trim())) return { status: 'UNVERIFIED', reason_code: 'MASCARA_SIN_MOTIVO' };
  const areaMasc = mascaras.reduce((s, m) => s + m.w * m.h, 0);
  if (areaMasc > MASCARA_MAX * a.width * a.height) return { status: 'UNVERIFIED', reason_code: 'MASCARA_EXCESIVA' };
  if (mascaras.some((m) => regiones.some((r) => r.protegida !== false && solapan(m, r)))) {
    return { status: 'UNVERIFIED', reason_code: 'MASCARA_SOBRE_REGION_PROTEGIDA' };
  }

  let distintos = 0;
  let total = 0;
  const porRegion = regiones.map(() => ({ distintos: 0, total: 0 }));
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      if (mascaras.some((m) => dentro(x, y, m))) continue;
      const i = (y * a.width + x) * 4;
      const diff = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]),
        Math.abs(a.data[i + 2] - b.data[i + 2]), Math.abs(a.data[i + 3] - b.data[i + 3])) > tolerancia;
      total++;
      if (diff) distintos++;
      regiones.forEach((r, k) => {
        if (!dentro(x, y, r)) return;
        porRegion[k].total++;
        if (diff) porRegion[k].distintos++;
      });
    }
  }
  const pct = total ? Math.round((distintos / total) * 10000) / 100 : 0;
  const regionesRotas = regiones.map((r, k) => {
    const pr = porRegion[k];
    const p = pr.total ? Math.round((pr.distintos / pr.total) * 10000) / 100 : 0;
    return { nombre: r.nombre, diffPct: p, umbral: r.umbral != null ? r.umbral : 0 };
  }).filter((r) => r.diffPct > r.umbral);
  if (regionesRotas.length) return { status: 'FAIL', reason_code: 'REGION_PROTEGIDA_CAMBIO', diffPct: pct, regiones: regionesRotas };
  if (pct > umbral) return { status: 'FAIL', reason_code: 'DIFF_SOBRE_UMBRAL', diffPct: pct };
  return { status: 'PASS', diffPct: pct };
}

function compararConContexto(refBuf, buf, opts = {}) {
  const comp = compatibleManifiesto(opts.manifiesto_ref || {}, opts.manifiesto_actual || {});
  if (!comp.ok) return { status: 'UNVERIFIED', reason_code: comp.reason_code, campos: comp.campos };
  return comparar(refBuf, buf, opts);
}

function listar(root, vista) {
  const base = path.join(root, '.agentic', 'snapshots', limpio(vista));
  let variantes = [];
  try { variantes = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* sin vista */ }
  return variantes.map((v) => {
    const ref = referencia(root, vista, v);
    let candidatos = [];
    try { candidatos = fs.readdirSync(path.join(base, v, 'candidatos')).filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4)); } catch { /* sin candidatos */ }
    return { variante: v, aprobado: ref.ok ? ref.manifest : null, estado: ref.ok ? 'APROBADO' : ref.reason_code, candidatos };
  });
}

module.exports = { variante, guardarCandidato, referencia, aprobar, comparar, compararConContexto, compatibleManifiesto, listar, VIEWPORT_BASE, ORIGENES, sha, CAMPOS_MANIFIESTO };
