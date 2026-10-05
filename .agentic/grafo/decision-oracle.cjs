'use strict';

/**
 * Juez tipado (decision-oracle): preguntas con respuesta de sí/no y probabilidad,
 * contestadas por motores intercambiables, con registro y calibración medida.
 *
 * QUÉ ES Y QUÉ NO
 * ---------------
 * Es un CONTRATO nativo de Agentix, no un modelo. Los motores (hoy solo `reglas`)
 * son lo que contesta; el juez se ocupa de lo que importa para confiar en ellos:
 * apuntar cada respuesta, ponerle la verdad cuando llega, medir y decidir qué
 * autoridad merece. Un motor externo (p. ej. Jev) sería un enchufe más: se
 * registra con `registrarMotor` y pasa por el mismo experimento. Ninguno se
 * integra en esta versión.
 *
 * MODOS (por motor y por pregunta)
 *   off      no corre
 *   sombra   responde y se registra; NO influye en nada (modo por defecto)
 *   asesor   su respuesta se ofrece como consejo
 *   decide   su respuesta puede actuar (solo en preguntas reversibles)
 * Subir de modo exige que la evidencia lo permita (`veredicto`); bajar es libre.
 *
 * REGLAS DE AUTORIDAD (no se negocian)
 *   1. Un motor nunca levanta un gate ni una prohibición: este módulo ni siquiera
 *      tiene forma de hacerlo; solo devuelve datos.
 *   2. Cada pregunta tiene un tope de modo (`max_modo`); la configuración se recorta.
 *   3. Si un motor falla o tarda, se registra el fallo y se sigue: nunca bloquea.
 *   4. Un falso negativo en un caso decidido por un motor lo baja a `asesor`.
 *   5. Un cambio de versión del motor reinicia su evidencia (se evalúa por versión).
 *
 * DÓNDE VIVE EL ESTADO
 *   <datos>/oracle-log.jsonl   registro append-only (respuestas, etiquetas, eventos)
 *   <datos>/config.json        modos por motor y pregunta
 * Por defecto <raiz>/.agentic/_oraculo/, fuera de las carpetas que `akdd update`
 * gestiona. `--datos` permite escribir en otro sitio y `--root` leer la memoria
 * de otro proyecto sin escribir nada en él.
 *
 *   node .agentic/grafo/decision-oracle.cjs estado
 *   node .agentic/grafo/decision-oracle.cjs preguntar Q1 --tarea "..." [--nivel ALTO]
 *   node .agentic/grafo/decision-oracle.cjs etiquetar          (Q1 desde prediction_log)
 *   node .agentic/grafo/decision-oracle.cjs backfill           (repite el historial)
 *   node .agentic/grafo/decision-oracle.cjs metricas [Q1] [--json]
 *   node .agentic/grafo/decision-oracle.cjs veredicto [Q1]
 *   node .agentic/grafo/decision-oracle.cjs modo reglas Q0 asesor [--forzar]
 *   node .agentic/grafo/decision-oracle.cjs muestra Q0 [--n 20]
 *   node .agentic/grafo/decision-oracle.cjs etiquetar --id <id> --y 0|1 [--fuente humano]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VERSION = 1;
const MODOS = ['off', 'sombra', 'asesor', 'decide'];
const RANGO = { off: 0, sombra: 1, asesor: 2, decide: 3 };
const ARCHIVO_LOG = 'oracle-log.jsonl';
const ARCHIVO_CONFIG = 'config.json';
const FUENTES_REALES = new Set(['prediction_log', 'humano', 'gate_events']);

const safe = (fn, fb = null) => { try { return fn(); } catch { return fb; } };

/* ── preguntas ─────────────────────────────────────────────────────────────── */

const PREGUNTAS = Object.freeze({
  Q0: { id: 'Q0', version: 1, tipo: 'noul', umbral_positivo: 0.5, max_modo: 'decide', tau: 0.9,
    texto: '¿Esto es una tarea de desarrollo (y no una conversación)?',
    etiqueta: 'solo humana: no hay fuente mecánica independiente de las reglas' },
  Q1: { id: 'Q1', version: 1, tipo: 'noul', umbral_positivo: 0.10, max_modo: 'asesor', tau: 0.9,
    texto: '¿Este ciclo terminará con algún problema detectado por los controles?',
    etiqueta: 'mecánica: prediction_log (STOP, contrato roto, reversión de diseño)' },
  Q2: { id: 'Q2', version: 1, tipo: 'noul', umbral_positivo: 0.5, max_modo: 'asesor', tau: 0.9,
    texto: '¿La tarea toca un valor de negocio protegido?',
    etiqueta: 'sin fuente mecánica: el Spec Gate previo es protocolo, no se ejecuta en el ciclo' },
  Q3: { id: 'Q3', version: 1, tipo: 'choice', max_modo: 'asesor', disponible: false,
    texto: 'Clase de decisión: reversible / provisional / del dueño',
    etiqueta: 'pendiente: requiere el registro de decisiones del modelo (fase 2 del plan de autonomía)' },
});

/* ── motores ───────────────────────────────────────────────────────────────── */

const MOTORES = new Map();

/** Un motor cumple { nombre, version, externo, evaluar(pregunta, estado) → {p, razones[]} }. */
function registrarMotor(motor) {
  if (!motor || !motor.nombre || typeof motor.evaluar !== 'function') throw new Error('motor inválido');
  MOTORES.set(motor.nombre, motor);
}
registrarMotor(require('./oraculo-motor-reglas.cjs'));

/* ── rutas, configuración y registro ───────────────────────────────────────── */

const dirDatos = (root, datos) => datos || path.join(root, '.agentic', '_oraculo');

function cargarConfig(datos) {
  const cfg = safe(() => JSON.parse(fs.readFileSync(path.join(datos, ARCHIVO_CONFIG), 'utf8')), null);
  return cfg && typeof cfg === 'object' && cfg.motores ? cfg : { version: VERSION, motores: {} };
}

function guardarConfig(datos, cfg) {
  fs.mkdirSync(datos, { recursive: true });
  fs.writeFileSync(path.join(datos, ARCHIVO_CONFIG), JSON.stringify(cfg, null, 2) + '\n');
}

/** Modo efectivo: lo configurado, recortado al tope de la pregunta. El motor `reglas` arranca en sombra. */
function modoEfectivo(cfg, motor, qid) {
  const p = PREGUNTAS[qid];
  if (!p || p.disponible === false) return 'off';
  const m = MOTORES.get(motor);
  const configurado = safe(() => cfg.motores[motor][qid], null);
  let modo = MODOS.includes(configurado) ? configurado : (m && m.nombre === 'reglas' ? 'sombra' : 'off');
  if (RANGO[modo] > RANGO[p.max_modo]) modo = p.max_modo;
  return modo;
}

function anexar(datos, rec) {
  fs.mkdirSync(datos, { recursive: true });
  fs.appendFileSync(path.join(datos, ARCHIVO_LOG), JSON.stringify(rec) + '\n');
}

/** Lee y pliega el registro: respuestas por id, última etiqueta por id, eventos. */
function leer(datos) {
  const out = { respuestas: [], etiquetaDe: new Map(), eventos: [] };
  let txt;
  try { txt = fs.readFileSync(path.join(datos, ARCHIVO_LOG), 'utf8'); } catch { return out; }
  for (const linea of txt.split('\n')) {
    if (!linea.trim()) continue;
    const r = safe(() => JSON.parse(linea), null);
    if (!r) continue;
    if (r.t === 'resp') out.respuestas.push(r);
    else if (r.t === 'etiq') out.etiquetaDe.set(r.id, r);
    else if (r.t === 'evento') out.eventos.push(r);
  }
  return out;
}

/* ── responder ─────────────────────────────────────────────────────────────── */

function textoMinimo(t) {
  let s = String(t || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  try {
    const priv = require('./memory-privacy.cjs');
    s = String(priv.sanitizarValor(s) || '');
  } catch { s = s.replace(/(sk-|ghp_|xox[bap]-|eyJ)[\w.-]{8,}/g, '[SECRETO]'); }
  return s;
}

const hashEntrada = (e) => crypto.createHash('sha256')
  .update(JSON.stringify([String((e && e.tarea) || '').trim().toLowerCase(), (e && e.nivel) || '', (e && e.modulo) || ''])).digest('hex').slice(0, 16);

/**
 * Pregunta `qid` a todos los motores que no estén apagados para ella.
 *
 * @returns { respuestas, decision, consejo }
 *   decision  solo si un motor en modo `decide` tiene confianza >= tau (si no, null)
 *   consejo   la respuesta del motor de mayor modo >= `asesor` (si no, null)
 * En sombra ambos son null: el registro es lo único que cambia.
 */
function responder(root, qid, estado, { datos, origen = 'vivo', ciclo_id = null, id = null } = {}) {
  const preg = PREGUNTAS[qid];
  if (!preg || preg.disponible === false) return { error: 'PREGUNTA_NO_DISPONIBLE', respuestas: [], decision: null, consejo: null };
  const dir = dirDatos(root, datos);
  const cfg = cargarConfig(dir);
  const respuestas = [];

  for (const [nombre, motor] of MOTORES) {
    const modo = modoEfectivo(cfg, nombre, qid);
    if (modo === 'off') continue;
    const t0 = Date.now();
    let ans = null; let estadoResp = 'OK';
    try { ans = motor.evaluar(preg, estado || {}); } catch (e) { estadoResp = 'ERROR'; }
    if (ans && ans.soportada === false) { estadoResp = 'NO_SOPORTADA'; }
    const p = ans && Number.isFinite(ans.p) ? Math.min(1, Math.max(0, ans.p)) : null;
    const rec = {
      t: 'resp', id: id ? `${id}@${nombre}` : ('or-' + crypto.randomBytes(5).toString('hex')), ts: new Date().toISOString(), v: VERSION,
      pregunta: qid, pv: preg.version, motor: nombre, mv: motor.version || '0', externo: !!motor.externo, modo, origen,
      ciclo_id, prediccion_id: (estado && estado.prediccion_id) || null, input_hash: hashEntrada(estado),
      estado_min: { tarea: textoMinimo(estado && estado.tarea), nivel: (estado && estado.nivel) || null, modulo: (estado && estado.modulo) || null,
        n_archivos: Array.isArray(estado && estado.archivos) ? estado.archivos.length : null },
      p, valor: p == null ? null : (p >= preg.umbral_positivo ? 'si' : 'no'),
      confianza: p == null ? null : Math.max(p, 1 - p), razones: (ans && ans.razones) || [],
      latencia_ms: Date.now() - t0, estado: estadoResp,
    };
    safe(() => anexar(dir, rec));
    respuestas.push(rec);
  }

  const validas = respuestas.filter((r) => r.estado === 'OK');
  const decide = validas.filter((r) => r.modo === 'decide' && r.confianza >= preg.tau).sort((a, b) => b.confianza - a.confianza)[0];
  const asesora = validas.filter((r) => RANGO[r.modo] >= RANGO.asesor).sort((a, b) => RANGO[b.modo] - RANGO[a.modo] || b.confianza - a.confianza)[0];
  return {
    respuestas,
    decision: decide ? { valor: decide.valor, p: decide.p, motor: decide.motor } : null,
    consejo: asesora ? { valor: asesora.valor, p: asesora.p, motor: asesora.motor, razones: asesora.razones } : null,
  };
}

/**
 * Observación en sombra para el enricher: Q0, Q1 y Q2. No devuelve nada que
 * pueda influir y no lanza nunca: medir es un plus, jamás un requisito.
 */
function sombra(root, estado, opciones = {}) {
  try {
    for (const q of ['Q0', 'Q1', 'Q2']) safe(() => responder(root, q, estado, Object.assign({ origen: 'vivo' }, opciones)));
  } catch { /* nunca */ }
}

/* ── memoria del proyecto (solo lectura) ───────────────────────────────────── */

function abrirSoloLectura(root) {
  const p = path.join(root, '.agentic', 'memoria.db');
  if (!fs.existsSync(p)) return null;
  /* Por el adaptador, como exige el resto del proyecto: elige el conector y respeta las pausas de un update. */
  try { return require('./db-adapter.cjs').openReadOnly(p); } catch { return null; }
}

/* ── etiquetas ─────────────────────────────────────────────────────────────── */

function etiquetarManual(datos, id, y, { fuente = 'humano', evidencia = null } = {}) {
  if (!(y === 0 || y === 1)) return { status: 'RECHAZADO', motivo: 'y debe ser 0 o 1' };
  const log = leer(datos);
  if (!log.respuestas.some((r) => r.id === id)) return { status: 'RECHAZADO', motivo: 'id desconocido' };
  anexar(datos, { t: 'etiq', id, ts: new Date().toISOString(), y, fuente, evidencia });
  return { status: 'OK', degradados: revisarDegradaciones(datos) };
}

/**
 * Pone la verdad a las respuestas de Q1 que ya la tienen en `prediction_log`
 * (la calificación mecánica que escribe el post-cycle). Q0 y Q2 no tienen fuente
 * mecánica independiente: Q0 se etiqueta a mano y Q2 espera a que el Spec Gate se ejecute.
 */
function etiquetar(root, { datos } = {}) {
  const dir = dirDatos(root, datos);
  const db = abrirSoloLectura(root);
  if (!db) return { error: 'sin memoria.db (o sin driver de SQLite)' };
  const res = { etiquetadas: 0, degradados: [] };
  try {
    const log = leer(dir);
    for (const r of log.respuestas) {
      if (r.pregunta !== 'Q1' || r.estado !== 'OK' || !r.prediccion_id || log.etiquetaDe.has(r.id)) continue;
      const fila = safe(() => db.prepare('SELECT hubo_problema, evidencia, evaluado_en FROM prediction_log WHERE prediccion_id = ?').get(r.prediccion_id), null);
      if (!fila || fila.evaluado_en == null || fila.hubo_problema == null) continue;
      const y = fila.hubo_problema ? 1 : 0;
      anexar(dir, { t: 'etiq', id: r.id, ts: new Date().toISOString(), y, fuente: 'prediction_log', evidencia: fila.evidencia || null });
      res.etiquetadas++;
    }
  } finally { safe(() => db.close()); }
  res.degradados = revisarDegradaciones(dir);
  return res;
}

/**
 * Regla 4: un falso negativo en un caso que un motor DECIDIÓ lo baja a `asesor`.
 * Se revisa sobre todo el registro (etiquetas mecánicas y manuales) y es idempotente.
 */
function revisarDegradaciones(datos) {
  const log = leer(datos);
  const hechos = [];
  for (const r of log.respuestas) {
    const e = log.etiquetaDe.get(r.id);
    if (!e || r.modo !== 'decide' || r.valor !== 'no' || e.y !== 1) continue;
    if (log.eventos.some((x) => x.tipo === 'DEGRADADO' && x.rec === r.id)) continue;
    hechos.push(degradar(datos, r, 'falso negativo en un caso decidido'));
  }
  return hechos;
}

function degradar(datos, rec, razon) {
  const cfg = cargarConfig(datos);
  cfg.motores[rec.motor] = Object.assign({}, cfg.motores[rec.motor], { [rec.pregunta]: 'asesor' });
  guardarConfig(datos, cfg);
  anexar(datos, { t: 'evento', ts: new Date().toISOString(), tipo: 'DEGRADADO', motor: rec.motor, pregunta: rec.pregunta, a: 'asesor', razon, rec: rec.id });
  return { motor: rec.motor, pregunta: rec.pregunta, razon };
}

/**
 * Repite el historial de `prediction_log` por los motores activos y le pone la
 * verdad de Q1. Es retrospectivo: la entrada es solo lo que se sabía antes del
 * ciclo (tarea, nivel predicho, módulo). Idempotente.
 */
function backfill(root, { datos } = {}) {
  const dir = dirDatos(root, datos);
  const db = abrirSoloLectura(root);
  if (!db) return { error: 'sin memoria.db (o sin driver de SQLite)' };
  const res = { filas: 0, nuevas: 0, positivos: 0 };
  try {
    const log = leer(dir);
    const existentes = new Set(log.respuestas.map((r) => String(r.id).split('@')[0]));
    const filas = safe(() => db.prepare(`SELECT id, prediccion_id, tarea, modulo, archivos, nivel_predicho, hubo_problema, evidencia
      FROM prediction_log WHERE evaluado_en IS NOT NULL AND hubo_problema IS NOT NULL ORDER BY id`).all(), []) || [];
    res.filas = filas.length;
    for (const f of filas) {
      const base = 'bf-' + (f.prediccion_id || ('r' + f.id));
      const estado = { tarea: f.tarea, modulo: f.modulo, nivel: f.nivel_predicho, archivos: safe(() => JSON.parse(f.archivos || '[]'), []) };
      for (const q of ['Q0', 'Q1', 'Q2']) {
        const id = `${base}-${q}`;
        if (existentes.has(id)) continue;
        const r = responder(root, q, estado, { datos: dir, origen: 'backfill', id });
        if (r.respuestas.length) res.nuevas++;
        if (q === 'Q1') {
          for (const rr of r.respuestas) {
            anexar(dir, { t: 'etiq', id: rr.id, ts: new Date().toISOString(), y: f.hubo_problema ? 1 : 0, fuente: 'prediction_log', evidencia: f.evidencia || null });
          }
          if (f.hubo_problema) res.positivos++;
        }
      }
    }
  } finally { safe(() => db.close()); }
  return res;
}

/* ── estadística ───────────────────────────────────────────────────────────── */

const media = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

const brier = (ps, ys) => media(ps.map((p, i) => (p - ys[i]) ** 2));

/** Error de calibración esperado, 10 casillas iguales. */
function ece(ps, ys, casillas = 10) {
  const n = ps.length; if (!n) return null;
  let total = 0;
  for (let b = 0; b < casillas; b++) {
    const idx = []; ps.forEach((p, i) => { const k = Math.min(casillas - 1, Math.floor(p * casillas)); if (k === b) idx.push(i); });
    if (!idx.length) continue;
    total += Math.abs(media(idx.map((i) => ys[i])) - media(idx.map((i) => ps[i]))) * (idx.length / n);
  }
  return total;
}

/** AUROC por rangos (Mann-Whitney), con empates promediados. */
function auroc(ps, ys) {
  const pos = ys.filter((y) => y === 1).length; const neg = ys.length - pos;
  if (!pos || !neg) return null;
  const orden = ps.map((p, i) => [p, ys[i]]).sort((a, b) => a[0] - b[0]);
  let sumaRangosPos = 0; let i = 0;
  while (i < orden.length) {
    let j = i; while (j + 1 < orden.length && orden[j + 1][0] === orden[i][0]) j++;
    const rango = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (orden[k][1] === 1) sumaRangosPos += rango;
    i = j + 1;
  }
  return (sumaRangosPos - pos * (pos + 1) / 2) / (pos * neg);
}

/** Cota superior unilateral al 95 % de una tasa: exacta con 0 eventos, Wilson si no. */
function cotaSuperior(k, n) {
  if (!n) return null;
  if (k === 0) return 1 - Math.pow(0.05, 1 / n);
  const z = 1.645; const p = k / n; const z2 = z * z;
  return (p + z2 / (2 * n) + z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
}

function prng(semilla) {
  let a = semilla >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Mejora de Brier sobre el predictor constante (prevalencia), con IC95 % por remuestreo. */
function mejoraBrier(ps, ys, remuestras = 2000) {
  const n = ps.length; if (n < 2) return null;
  const rnd = prng(12345);
  const dif = (idx) => {
    const y = idx.map((i) => ys[i]); const p = idx.map((i) => ps[i]);
    const prev = media(y);
    return brier(y.map(() => prev), y) - brier(p, y);
  };
  const completo = dif([...Array(n).keys()]);
  const muestras = [];
  for (let r = 0; r < remuestras; r++) { const idx = Array.from({ length: n }, () => Math.floor(rnd() * n)); muestras.push(dif(idx)); }
  muestras.sort((a, b) => a - b);
  return { diff: completo, lo: muestras[Math.floor(remuestras * 0.025)], hi: muestras[Math.floor(remuestras * 0.975)] };
}

const percentil = (xs, q) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

/* ── métricas ──────────────────────────────────────────────────────────────── */

function metricas(datos, { pregunta = 'Q1', motor = 'reglas', fuente = 'real', mv = null } = {}) {
  const preg = PREGUNTAS[pregunta];
  if (!preg || preg.disponible === false) return { error: 'PREGUNTA_NO_DISPONIBLE' };
  const log = leer(datos);
  const delMotor = log.respuestas.filter((r) => r.pregunta === pregunta && r.motor === motor && (!mv || r.mv === mv));
  const ok = delMotor.filter((r) => r.estado === 'OK');
  const esReal = (e) => FUENTES_REALES.has(e.fuente);
  const filas = ok.map((r) => ({ r, e: log.etiquetaDe.get(r.id) }))
    .filter((x) => x.e && (fuente === 'todas' || (fuente === 'real' ? esReal(x.e) : !esReal(x.e))));

  const m = {
    pregunta, motor, fuente, umbral: preg.umbral_positivo,
    respuestas: delMotor.length, etiquetadas: filas.length,
    sin_etiqueta: ok.length - filas.length,
    disponibilidad: delMotor.length ? ok.length / delMotor.length : null,
    latencia_p95_ms: percentil(delMotor.map((r) => r.latencia_ms), 0.95),
    dias: delMotor.length > 1 ? (Date.parse(delMotor[delMotor.length - 1].ts) - Date.parse(delMotor[0].ts)) / 86400000 : 0,
    origen: { vivo: filas.filter((x) => x.r.origen === 'vivo').length, backfill: filas.filter((x) => x.r.origen === 'backfill').length },
  };
  if (!filas.length) return m;

  const ps = filas.map((x) => x.r.p); const ys = filas.map((x) => x.e.y);
  const pred = ps.map((p) => (p >= preg.umbral_positivo ? 1 : 0));
  const tp = pred.filter((v, i) => v === 1 && ys[i] === 1).length;
  const fp = pred.filter((v, i) => v === 1 && ys[i] === 0).length;
  const fn = pred.filter((v, i) => v === 0 && ys[i] === 1).length;
  const tn = pred.filter((v, i) => v === 0 && ys[i] === 0).length;
  const n = filas.length; const pos = tp + fn;
  Object.assign(m, {
    positivos: pos, prevalencia: pos / n,
    acierto: (tp + tn) / n,
    /* La vara con la que hay que compararse: el mejor predictor constante. */
    acierto_constante: Math.max(pos, n - pos) / n,
    confusion: { tp, fp, fn, tn },
    falso_negativo: pos ? fn / pos : null,
    falso_negativo_cota95: pos ? cotaSuperior(fn, pos) : null,
    brier: brier(ps, ys), ece: ece(ps, ys), auroc: auroc(ps, ys),
    mejora_brier: mejoraBrier(ps, ys),
    selectiva: [0.6, 0.7, 0.8, 0.9, 0.95].map((tau) => {
      const sub = filas.map((x, i) => ({ conf: x.r.confianza, ok: pred[i] === ys[i], fn: pred[i] === 0 && ys[i] === 1, y: ys[i] })).filter((s) => s.conf >= tau);
      return { tau, cobertura: sub.length / n, acierto: sub.length ? sub.filter((s) => s.ok).length / sub.length : null, fn: sub.filter((s) => s.fn).length, positivos: sub.filter((s) => s.y === 1).length };
    }),
  });
  return m;
}

/* ── veredicto: ¿qué autoridad permite la evidencia? ───────────────────────── */

function veredicto(datos, { pregunta = 'Q1', motor = 'reglas', mv = null } = {}) {
  const preg = PREGUNTAS[pregunta];
  const m = metricas(datos, { pregunta, motor, fuente: 'real', mv });
  if (m.error) return m;
  const mot = MOTORES.get(motor);
  const c = (id, cumple, detalle) => ({ id, cumple: !!cumple, detalle });
  const n = m.etiquetadas || 0;
  const A = [
    c('A1 casos etiquetados >= 100', n >= 100, `${n}`),
    c('A2 positivos reales >= 30', (m.positivos || 0) >= 30, `${m.positivos || 0}`),
    c('A3 mejora de Brier sobre el predictor constante (IC95 % > 0)', m.mejora_brier && m.mejora_brier.lo > 0,
      m.mejora_brier ? `${m.mejora_brier.diff.toFixed(4)} [${m.mejora_brier.lo.toFixed(4)}, ${m.mejora_brier.hi.toFixed(4)}]` : 'sin datos'),
    c('A4 ECE <= 0,08 (con >= 100 casos)', n >= 100 && m.ece != null && m.ece <= 0.08, m.ece == null ? 'sin datos' : m.ece.toFixed(3)),
    c('A5 disponibilidad >= 99 %', m.disponibilidad != null && m.disponibilidad >= 0.99, m.disponibilidad == null ? 'sin datos' : (m.disponibilidad * 100).toFixed(1) + '%'),
    c('A6 sin incidentes de privacidad', !(mot && mot.externo) || false, mot && mot.externo ? 'motor externo: no medible aquí, exige revisión humana' : 'motor local'),
  ];
  const sel = (m.selectiva || []).find((s) => s.acierto != null && s.acierto >= 0.95 && s.cobertura >= 0.25);
  const B = [
    c('B1 falso negativo <= 5 % y cota95 <= 10 %', m.falso_negativo != null && m.falso_negativo <= 0.05 && m.falso_negativo_cota95 <= 0.10,
      m.falso_negativo == null ? 'sin positivos' : `${(m.falso_negativo * 100).toFixed(1)}% (cota ${(m.falso_negativo_cota95 * 100).toFixed(1)}%)`),
    c('B2 exactitud selectiva >= 95 % con cobertura >= 25 %', !!sel, sel ? `tau ${sel.tau}: ${(sel.acierto * 100).toFixed(0)}% sobre ${(sel.cobertura * 100).toFixed(0)}%` : 'ninguna franja lo cumple'),
    c('B3 estable >= 30 días', (m.dias || 0) >= 30, `${(m.dias || 0).toFixed(1)} días`),
  ];
  let nivel = 'sombra';
  if (A.every((x) => x.cumple)) { nivel = 'asesor'; if (B.every((x) => x.cumple)) nivel = 'decide'; }
  const tope = preg.max_modo;
  const permitido = RANGO[nivel] > RANGO[tope] ? tope : nivel;
  return { pregunta, motor, nivel_por_evidencia: nivel, tope_pregunta: tope, nivel_permitido: permitido, A, B, metricas: m,
    nota: n < 100 ? 'Datos insuficientes: ningún criterio de promoción puede darse por probado.' : null };
}

/** Cambia un modo. Subir exige que `veredicto` lo permita (o --forzar, que queda registrado). */
function fijarModo(root, { datos, motor, pregunta, modo, forzar = false } = {}) {
  const dir = dirDatos(root, datos);
  if (!MOTORES.has(motor)) return { status: 'RECHAZADO', motivo: 'motor desconocido' };
  const preg = PREGUNTAS[pregunta];
  if (!preg || preg.disponible === false) return { status: 'RECHAZADO', motivo: 'pregunta no disponible' };
  if (!MODOS.includes(modo)) return { status: 'RECHAZADO', motivo: 'modo inválido' };
  if (RANGO[modo] > RANGO[preg.max_modo]) return { status: 'RECHAZADO', motivo: `${pregunta} tiene tope ${preg.max_modo}: nunca llega a ${modo}` };
  const cfg = cargarConfig(dir);
  const actual = modoEfectivo(cfg, motor, pregunta);
  if (RANGO[modo] > RANGO[actual] && RANGO[modo] > RANGO.sombra) {
    const v = veredicto(dir, { pregunta, motor });
    if (RANGO[modo] > RANGO[v.nivel_permitido]) {
      if (!forzar) return { status: 'RECHAZADO', motivo: 'la evidencia no permite ese modo', veredicto: v };
      anexar(dir, { t: 'evento', ts: new Date().toISOString(), tipo: 'FORZADO', motor, pregunta, a: modo, razon: 'subida forzada sin evidencia' });
    }
  }
  cfg.motores[motor] = Object.assign({}, cfg.motores[motor], { [pregunta]: modo });
  guardarConfig(dir, cfg);
  anexar(dir, { t: 'evento', ts: new Date().toISOString(), tipo: 'MODO', motor, pregunta, a: modo });
  return { status: 'OK', modo };
}

/* ── CLI ───────────────────────────────────────────────────────────────────── */

const pct = (x) => (x == null ? '—' : (x * 100).toFixed(1) + '%');
const num = (x, d = 3) => (x == null ? '—' : Number(x).toFixed(d));

function imprimirMetricas(m) {
  console.log(`\n  ${m.pregunta} · motor ${m.motor} · etiquetas ${m.fuente}`);
  console.log('  ' + '─'.repeat(52));
  console.log(`  respuestas ${m.respuestas} · etiquetadas ${m.etiquetadas} · sin etiqueta ${m.sin_etiqueta}`);
  if (!m.etiquetadas) { console.log('  Aún no hay casos con verdad conocida.\n'); return; }
  console.log(`  positivos reales ${m.positivos} (prevalencia ${pct(m.prevalencia)})  ·  vivo ${m.origen.vivo} / histórico ${m.origen.backfill}`);
  console.log(`  acierto ${pct(m.acierto)}   vs  predictor constante ${pct(m.acierto_constante)}   ← el que hay que superar`);
  console.log(`  falso negativo ${pct(m.falso_negativo)} (cota95 ${pct(m.falso_negativo_cota95)})   confusión ${JSON.stringify(m.confusion)}`);
  console.log(`  Brier ${num(m.brier)} · ECE ${num(m.ece)} · AUROC ${num(m.auroc)}`);
  if (m.mejora_brier) console.log(`  mejora de Brier sobre la constante ${num(m.mejora_brier.diff, 4)}  IC95 [${num(m.mejora_brier.lo, 4)}, ${num(m.mejora_brier.hi, 4)}]`);
  console.log('  clasificación selectiva (confianza >= tau):');
  for (const s of m.selectiva) console.log(`    tau ${s.tau.toFixed(2)}  cobertura ${pct(s.cobertura).padStart(6)}  acierto ${pct(s.acierto).padStart(6)}  falsos negativos ${s.fn}`);
  console.log(`  disponibilidad ${pct(m.disponibilidad)} · latencia p95 ${m.latencia_p95_ms} ms · ${num(m.dias, 1)} días de datos\n`);
}

function cli(argv) {
  const args = argv.slice(2);
  const flags = {}; const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const k = a.slice(2);
    if (k === 'json' || k === 'forzar') flags[k] = true; else { flags[k] = args[i + 1]; i++; }
  }
  const flag = (n, d = null) => (flags[n] !== undefined ? flags[n] : d);
  const cmd = pos[0] || 'estado';
  const root = path.resolve(flag('root', process.cwd()));
  const datos = flag('datos') ? path.resolve(flag('datos')) : undefined;
  const dir = dirDatos(root, datos);
  const q = (pos[1] && /^Q\d$/i.test(pos[1]) ? pos[1].toUpperCase() : null);

  if (cmd === 'estado') {
    const cfg = cargarConfig(dir); const log = leer(dir);
    console.log(`\n  JUEZ TIPADO · datos en ${dir}`);
    console.log('  ' + '─'.repeat(52));
    for (const p of Object.values(PREGUNTAS)) {
      const modos = [...MOTORES.keys()].map((mo) => `${mo}:${modoEfectivo(cfg, mo, p.id)}`).join(' ');
      const rs = log.respuestas.filter((r) => r.pregunta === p.id);
      const et = rs.filter((r) => log.etiquetaDe.has(r.id)).length;
      console.log(`  ${p.id} ${p.disponible === false ? '(no disponible)' : ''} ${p.texto}`);
      console.log(`     modos ${modos} · tope ${p.max_modo} · respuestas ${rs.length} · etiquetadas ${et}`);
      console.log(`     verdad: ${p.etiqueta}`);
    }
    console.log(`  eventos registrados: ${log.eventos.length}\n`);
  } else if (cmd === 'preguntar') {
    if (!q) { console.log('  Uso: preguntar Q0|Q1|Q2 --tarea "..." [--nivel ALTO]'); process.exit(1); }
    const r = responder(root, q, { tarea: String(flag('tarea', '')), nivel: flag('nivel') || null, modulo: flag('modulo') || null }, { datos });
    for (const x of r.respuestas) console.log(`  [${x.motor}/${x.modo}] ${x.pregunta} → ${x.valor} (p=${num(x.p)}, conf=${num(x.confianza)})  ${x.razones.join(' · ')}`);
    console.log(`  decisión: ${r.decision ? JSON.stringify(r.decision) : 'ninguna (sombra: no influye)'}`);
  } else if (cmd === 'etiquetar') {
    if (flag('id')) {
      const r = etiquetarManual(dir, String(flag('id')), Number(flag('y')), { fuente: String(flag('fuente', 'humano')) });
      console.log('  ' + JSON.stringify(r));
    } else console.log('  ' + JSON.stringify(etiquetar(root, { datos })));
  } else if (cmd === 'backfill') {
    console.log('  ' + JSON.stringify(backfill(root, { datos })));
  } else if (cmd === 'metricas') {
    const m = metricas(dir, { pregunta: q || 'Q1', motor: String(flag('motor', 'reglas')), fuente: String(flag('fuente', 'real')) });
    if (flag('json')) console.log(JSON.stringify(m, null, 2)); else if (m.error) console.log('  ' + m.error); else imprimirMetricas(m);
  } else if (cmd === 'veredicto') {
    const v = veredicto(dir, { pregunta: q || 'Q1', motor: String(flag('motor', 'reglas')) });
    if (v.error) { console.log('  ' + v.error); return; }
    console.log(`\n  VEREDICTO ${v.pregunta} · ${v.motor}: la evidencia permite «${v.nivel_por_evidencia}», el tope de la pregunta es «${v.tope_pregunta}» → modo máximo «${v.nivel_permitido}»`);
    for (const x of [...v.A, ...v.B]) console.log(`   ${x.cumple ? '✅' : '❌'} ${x.id}  (${x.detalle})`);
    if (v.nota) console.log('  ' + v.nota);
    console.log('');
  } else if (cmd === 'modo') {
    const r = fijarModo(root, { datos, motor: pos[1], pregunta: (pos[2] || '').toUpperCase(), modo: pos[3], forzar: !!flag('forzar') });
    console.log('  ' + (r.status === 'OK' ? `OK · ${pos[1]} ${pos[2]} → ${r.modo}` : `${r.status}: ${r.motivo}`));
    if (r.veredicto) for (const x of [...r.veredicto.A, ...r.veredicto.B].filter((y) => !y.cumple)) console.log(`   ❌ ${x.id}  (${x.detalle})`);
    if (r.status !== 'OK') process.exit(1);
  } else if (cmd === 'muestra') {
    const log = leer(dir); const n = Number(flag('n', 20));
    const sin = log.respuestas.filter((r) => r.pregunta === (q || 'Q0') && r.estado === 'OK' && !log.etiquetaDe.has(r.id)).slice(0, n);
    for (const r of sin) console.log(`  ${r.id}  p=${num(r.p, 2)}  ${r.estado_min.tarea.slice(0, 90)}`);
    console.log(`\n  Etiqueta cada una con:  etiquetar --id <id> --y 1|0   (1 = sí, es una tarea)`);
  } else {
    console.log('  Comandos: estado · preguntar · etiquetar · backfill · metricas · veredicto · modo · muestra');
  }
}

if (require.main === module) cli(process.argv);

module.exports = {
  PREGUNTAS, MODOS, MOTORES, registrarMotor, responder, sombra, etiquetar, etiquetarManual, backfill,
  metricas, veredicto, fijarModo, modoEfectivo, cargarConfig, guardarConfig, leer, dirDatos,
  _estadistica: { brier, ece, auroc, cotaSuperior, mejoraBrier },
};
