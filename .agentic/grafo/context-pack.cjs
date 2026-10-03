#!/usr/bin/env node
/**
 * Agentic KDD — Paquete de contexto por tarea (02-esfuerzo-y-tokens)
 *
 * Un solo paquete por task_id: objetivo, aceptación, paths autorizados,
 * decisiones aplicables (resumen + id de recall), riesgos, hashes de los
 * archivos y evidencias ya obtenidas. Cada rol recibe su parte. Si la misma
 * tarea pide el paquete otra vez con el mismo contexto y el mismo grafo, se
 * reutiliza: un prompt no recibe dos veces el mismo enriquecimiento.
 *
 * Las instrucciones de los agentes no se cargan enteras por defecto: el núcleo
 * (.agentic/nucleo-reglas.md) siempre; las referencias especializadas según
 * rol, tier y lado (front/back) del cambio.
 *
 * El paquete respeta context_budget_bytes de la decisión del router; si no
 * cabe, recorta decisiones y lo dice. Texto libre pasa por el redactor de
 * secretos de la telemetría.
 *
 * CLI: node context-pack.cjs armar "<objetivo>" --paths=a,b [--task=T-1] [--rol=builder]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
const DIR = path.join('.agentic', '_context');
const NUCLEO = '.agentic/nucleo-reglas.md';
const VECINOS_POR_TIER = { LOW: 3, MEDIUM: 8, HIGH: 15 };
const FRONT = /\.(html?|css|scss|less|jsx|tsx|vue|svelte|astro)$|(^|\/)(components?|pages|views|app|public|styles?)\//i;

function redactar(t) {
  try { return require('./telemetry.cjs').redactar(String(t)); } catch { return String(t); }
}

function hashArchivo(root, rel) {
  try { return sha(fs.readFileSync(path.join(root, rel))).slice(0, 16); } catch { return null; }
}

/** Qué instrucciones necesita cada rol, según tier y lado del cambio. */
function referencias(rol, tier, paths) {
  const refs = [NUCLEO];
  if (tier === 'LOW') return refs;
  const front = (paths || []).some((p) => FRONT.test(String(p).replace(/\\/g, '/')));
  const back = (paths || []).some((p) => !FRONT.test(String(p).replace(/\\/g, '/')));
  if (rol === 'analyst' || rol === 'director') refs.push('.agentic/agentes/02-analista.md');
  if (rol === 'builder') {
    if (front) refs.push('.agentic/agentes/03-front.md');
    if (back || !(paths || []).length) refs.push('.agentic/agentes/04-back.md');
  }
  if (rol === 'qa' || rol === 'reviewer') refs.push('.agentic/agentes/05-qa.md');
  return refs;
}

function tamano(root, rel) { try { return fs.statSync(path.join(root, rel)).size; } catch { return 0; } }

function ruta(root, id) {
  if (!/^[\w.-]{1,80}$/.test(String(id || ''))) { const e = new Error('task_id inválido'); e.code = 'INVALID_TASK_ID'; throw e; }
  return path.join(root, DIR, id + '.json');
}

/**
 * Arma (o reutiliza) el paquete. `decision` es la del effort-router; si no se
 * pasa, se pide. Devuelve el paquete con `reutilizado` y `bytes`.
 */
async function armar(root, entrada) {
  const router = require('./effort-router.cjs');
  const paths = (entrada.paths || []).map((p) => String(p).replace(/\\/g, '/'));
  const decision = entrada.decision || router.decidirYGuardar(root, { task_id: entrada.task_id, intent: entrada.objetivo, paths, origen: entrada.origen });
  const id = decision.task_id;
  let grafo = '-';
  try { grafo = require('./kdd-memory.cjs').huellaGrafo(root); } catch { /* sin memoria */ }
  const hashes = Object.fromEntries(paths.map((p) => [p, hashArchivo(root, p)]));
  const contextHash = sha(JSON.stringify([entrada.objetivo, entrada.aceptacion || [], hashes, decision.tier, decision.policy_version]));

  let previo = null;
  try { previo = JSON.parse(fs.readFileSync(ruta(root, id), 'utf8')); } catch (e) { if (e.code === 'INVALID_TASK_ID') throw e; }
  if (previo && previo.context_hash === contextHash && previo.grafo === grafo && !entrada.forzar) {
    return { ...previo, reutilizado: true };
  }

  let decisiones = [];
  let recallInfo = null;
  try {
    const presupuesto = Math.max(200, Math.floor(decision.context_budget_bytes / 4 / 3));
    const r = await require('./kdd-memory.cjs').recall(entrada.objetivo, { topK: decision.recall_top_k || 3, presupuestoTokens: presupuesto, excluir: entrada.excluir || [], via: 'context-pack' }, root);
    decisiones = (r.results || []).map((x) => ({ id: x.id, tipo: x.tipo, titulo: x.titulo, confianza: x.confianza, vigencia: x.vigencia, archivos: x.archivos, resumen: x.resumen, ...(x.verificar ? { verificar: true } : {}) }));
    recallInfo = { source: r.source, presupuesto: r.presupuesto };
  } catch { /* memoria es un plus */ }

  let vecinos = null;
  if (paths.length) {
    let db = null;
    try {
      db = require('./db-adapter.cjs').openReadOnly(path.join(root, '.agentic', 'memoria.db'));
      vecinos = require('./blast-radius.cjs').vecinos(db, paths, { max: VECINOS_POR_TIER[decision.tier] || 3 });
    } catch { vecinos = { fuente: 'sin_indice', archivos: {} }; } finally { try { db && db.close(); } catch { /* ya cerrada */ } }
  }

  const evidencias = [];
  try {
    const ec = require('./evidence-cache.cjs');
    for (const q of entrada.evidencias_buscar || []) {
      const b = ec.buscar(root, q);
      evidencias.push(b.hit ? { comando: q.comando, tipo: b.entrada.tipo, status: b.entrada.resultado.status, ref: b.entrada.key } : { comando: q.comando, tipo: q.tipo || 'dirigido', reutilizable: false, motivo: b.motivo });
    }
  } catch { /* sin caché */ }

  const pack = {
    schema_version: 1,
    task_id: id,
    context_hash: contextHash,
    grafo,
    creado: new Date().toISOString(),
    objetivo: redactar(entrada.objetivo),
    aceptacion: (entrada.aceptacion || []).map(redactar),
    paths_autorizados: paths,
    hashes,
    tier: decision.tier,
    riesgo: decision.risk,
    riesgos: (entrada.riesgos || []).map(redactar).concat(decision.reason_codes.filter((c) => /AUTH|PAY|MIGRATION|SENSITIVE|PROTECTED|CRITICAL|TRANSACTION/.test(c))),
    gates: decision.required_gates,
    roles: decision.required_roles,
    decisiones,
    recall: recallInfo,
    vecinos,
    evidencias,
    ampliaciones: previo && previo.ampliaciones ? previo.ampliaciones : [],
  };

  const presupuesto = decision.context_budget_bytes;
  const medir = () => Buffer.byteLength(JSON.stringify(pack), 'utf8');
  let recortadas = 0;
  while (medir() > presupuesto && pack.decisiones.length) { pack.decisiones.pop(); recortadas++; }
  pack.truncado = recortadas ? { decisiones_omitidas: recortadas, motivo: 'context_budget_bytes' } : null;
  pack.bytes = medir();

  fs.mkdirSync(path.dirname(ruta(root, id)), { recursive: true });
  fs.writeFileSync(ruta(root, id), JSON.stringify(pack, null, 2));
  return { ...pack, reutilizado: false };
}

/** La parte de cada rol, más las instrucciones que le tocan y su peso. */
function paraRol(root, pack, rol) {
  const base = { task_id: pack.task_id, tier: pack.tier, objetivo: pack.objetivo, paths_autorizados: pack.paths_autorizados };
  let parte;
  if (rol === 'builder') parte = { ...base, aceptacion: pack.aceptacion, decisiones: pack.decisiones, riesgos: pack.riesgos, gates: pack.gates, vecinos: pack.vecinos };
  else if (rol === 'qa' || rol === 'reviewer') parte = { ...base, aceptacion: pack.aceptacion, hashes: pack.hashes, evidencias: pack.evidencias, gates: pack.gates, riesgos: pack.riesgos, vecinos: pack.vecinos };
  else parte = { ...base, aceptacion: pack.aceptacion, decisiones: pack.decisiones.map((d) => ({ id: d.id, titulo: d.titulo, confianza: d.confianza })), riesgos: pack.riesgos, roles: pack.roles, gates: pack.gates };
  const refs = referencias(rol, pack.tier, pack.paths_autorizados);
  const bytesRefs = refs.reduce((s, r) => s + tamano(root, r), 0);
  return { ...parte, instrucciones: refs, bytes: Buffer.byteLength(JSON.stringify(parte), 'utf8') + bytesRefs };
}

/** Registrar por qué se amplía contexto o pruebas (queda en el paquete). */
function ampliar(root, taskId, { que, motivo }) {
  const f = ruta(root, taskId);
  const pack = JSON.parse(fs.readFileSync(f, 'utf8'));
  pack.ampliaciones = pack.ampliaciones || [];
  pack.ampliaciones.push({ ts: new Date().toISOString(), que: String(que), motivo: redactar(motivo) });
  fs.writeFileSync(f, JSON.stringify(pack, null, 2));
  return pack.ampliaciones;
}

module.exports = { armar, paraRol, referencias, ampliar, NUCLEO };

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  const opt = {}; const libres = [];
  for (const a of rest) { const m = /^--([^=]+)(?:=(.*))?$/s.exec(a); if (m) opt[m[1]] = m[2] === undefined ? true : m[2]; else libres.push(a); }
  if (cmd === 'armar') {
    armar(process.cwd(), { task_id: opt.task, objetivo: libres.join(' '), paths: opt.paths ? String(opt.paths).split(',') : [] })
      .then((p) => console.log(JSON.stringify(opt.rol ? paraRol(process.cwd(), p, opt.rol) : p, null, 2)))
      .catch((e) => { console.error(e.message); process.exitCode = 1; });
  } else {
    console.log('Uso: node context-pack.cjs armar "<objetivo>" --paths=a,b [--task=T-1] [--rol=builder|qa|analyst]');
  }
}
