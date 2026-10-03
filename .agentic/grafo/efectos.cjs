'use strict';

/**
 * Registro de efectos externos (P08): lo que un cambio hizo fuera del código
 * — filas de base de datos, colas, archivos externos, mensajes, pagos,
 * despliegues, migraciones. Restaurar código no deshace nada de esto; por eso
 * cada efecto queda con su tipo, recurso, clave de idempotencia,
 * reversibilidad y plan de compensación, y el restore lo muestra pendiente.
 *
 * Diario de solo agregar en .agentic/efectos.jsonl (no se toca memoria.db:
 * crear una tabla ahí sería migrar la base real). Sin secretos: los campos
 * con nombre de credencial se descartan y los valores con forma de secreto se
 * redactan antes de escribir.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TIPOS = ['db', 'cola', 'archivo', 'mensaje', 'pago', 'deploy', 'migracion', 'api', 'otro'];
const IRREVERSIBLES_CON_STOP = new Set(['pago', 'deploy', 'migracion', 'mensaje']);
const CAMPO_SECRETO = /pass(word)?|secret|token|api[_-]?key|credential|private[_-]?key|authorization|cookie/i;
const VALOR_SECRETO = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{10,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/,
  /[a-z]+:\/\/[^\s:@/]+:[^\s@/]+@/i,
  /\bBearer\s+[A-Za-z0-9._-]{12,}/i,
];

const archivo = (root) => path.join(root, '.agentic', 'efectos.jsonl');

function limpiar(valor, ruta = []) {
  if (valor == null) return valor;
  if (typeof valor === 'string') return VALOR_SECRETO.some((re) => re.test(valor)) ? '[REDACTADO]' : valor;
  if (Array.isArray(valor)) return valor.map((v) => limpiar(v, ruta));
  if (typeof valor === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(valor)) {
      if (CAMPO_SECRETO.test(k)) continue;
      out[k] = limpiar(v, ruta.concat(k));
    }
    return out;
  }
  return valor;
}

function leer(root) {
  let txt = '';
  try { txt = fs.readFileSync(archivo(root), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; return []; }
  const out = [];
  for (const l of txt.split(/\r?\n/)) {
    if (!l) continue;
    let r;
    try { r = JSON.parse(l); } catch { continue; }
    if (Array.isArray(r.lote)) out.push(...r.lote);
    else out.push(r);
  }
  return out;
}

/** Estado vigente de cada efecto: la última línea con su id manda. */
function vigentes(root) {
  const porId = new Map();
  for (const e of leer(root)) porId.set(e.id, Object.assign({}, porId.get(e.id) || {}, e));
  return [...porId.values()];
}

/** Agrega una línea; si la anterior quedó cortada, la cierra primero para no fundirse con ella. */
function agregarLinea(root, obj) {
  const f = archivo(root);
  let prefijo = '';
  try {
    const { size } = fs.statSync(f);
    if (size > 0) {
      const fd = fs.openSync(f, 'r');
      try {
        const b = Buffer.alloc(1);
        fs.readSync(fd, b, 0, 1, size - 1);
        if (b[0] !== 0x0a) prefijo = '\n';
      } finally { fs.closeSync(fd); }
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  fs.appendFileSync(f, prefijo + JSON.stringify(obj) + '\n');
}

function conCandado(root, fn) {
  const lock = archivo(root) + '.lock';
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const hasta = Date.now() + 5000;
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 30000) { fs.rmdirSync(lock); continue; } } catch { /* otro lo liberó */ }
      if (Date.now() > hasta) { const err = new Error('efectos ocupado'); err.code = 'EFECTOS_OCUPADO'; throw err; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(lock); } catch { /* ya liberado */ } }
}

function validar(e) {
  const errores = [];
  if (!TIPOS.includes(e.tipo)) errores.push('TIPO_INVALIDO');
  if (!String(e.recurso_id || '').trim()) errores.push('SIN_RECURSO');
  if (!String(e.idempotency_key || '').trim()) errores.push('SIN_IDEMPOTENCIA');
  if (typeof e.reversible !== 'boolean') errores.push('REVERSIBILIDAD_NO_DECLARADA');
  if (e.reversible === false && !String(e.compensacion || '').trim()) errores.push('SIN_PLAN_DE_COMPENSACION');
  if (e.reversible === false && IRREVERSIBLES_CON_STOP.has(e.tipo) && !(e.aprobacion && String(e.aprobacion.aprobador || '').trim() && String(e.aprobacion.motivo || '').trim())) {
    errores.push('STOP_HUMANO_REQUERIDO');
  }
  return errores;
}

const claveIdem = (e) => `${e.tenant || ''}\u0000${e.tipo}\u0000${e.idempotency_key}`;

/**
 * Registra un lote de efectos: se validan todos antes de escribir y se
 * escriben juntos; si uno no pasa, no se escribe ninguno. Repetir la misma
 * clave de idempotencia (dentro del mismo tenant) no duplica.
 */
function registrarLote(root, efectos, contexto = {}) {
  const lista = (efectos || []).map((e) => limpiar(Object.assign({}, e)));
  const rechazos = lista.map((e, i) => ({ i, errores: validar(e) })).filter((r) => r.errores.length);
  if (rechazos.length) {
    const stop = rechazos.some((r) => r.errores.includes('STOP_HUMANO_REQUERIDO'));
    return { status: stop ? 'STOP_HUMANO' : 'RECHAZADO', rechazos, escritos: 0 };
  }
  return conCandado(root, () => {
    const existentes = new Map(vigentes(root).map((e) => [claveIdem(e), e]));
    const nuevos = [];
    const duplicados = [];
    for (const e of lista) {
      const k = claveIdem(e);
      if (existentes.has(k) || nuevos.some((n) => claveIdem(n) === k)) { duplicados.push(existentes.get(k) ? existentes.get(k).id : null); continue; }
      nuevos.push(Object.assign({
        id: 'ef_' + crypto.randomUUID().slice(0, 12), estado: 'APLICADO', at: new Date().toISOString(),
        ciclo_id: contexto.ciclo_id || null, task_id: contexto.task_id || null,
      }, e));
    }
    // Un lote es una sola línea: si la escritura se corta, la línea queda
    // ilegible y el lote entero no cuenta — nunca la mitad.
    if (nuevos.length) agregarLinea(root, { lote: nuevos });
    return { status: 'OK', escritos: nuevos.length, ids: nuevos.map((n) => n.id), duplicados };
  });
}

const registrar = (root, efecto, contexto) => registrarLote(root, [efecto], contexto);

function compensar(root, id, { evidencia, motivo } = {}) {
  if (!String(evidencia || '').trim()) return { status: 'RECHAZADO', reason_code: 'SIN_EVIDENCIA_DE_COMPENSACION' };
  return conCandado(root, () => {
    const e = vigentes(root).find((x) => x.id === id);
    if (!e) return { status: 'NO_EXISTE' };
    if (e.estado === 'COMPENSADO') return { status: 'OK', ya: true };
    agregarLinea(root, limpiar({ id, estado: 'COMPENSADO', compensado_at: new Date().toISOString(), evidencia_compensacion: evidencia, motivo_compensacion: motivo || null }));
    return { status: 'OK' };
  });
}

/** Lista efectos. Con tenant, solo los de ese tenant: nunca los de otro. */
function listar(root, { tenant, desde, pendientes = false } = {}) {
  return vigentes(root).filter((e) => (tenant === undefined || (e.tenant || null) === (tenant || null))
    && (!desde || e.at > desde) && (!pendientes || e.estado !== 'COMPENSADO'));
}

/** Lo que pasó fuera del código desde un instante y sigue sin compensar. */
const pendientesDesde = (root, iso) => listar(root, { desde: iso, pendientes: true });

module.exports = { TIPOS, registrar, registrarLote, compensar, listar, pendientesDesde, limpiar, validar };
