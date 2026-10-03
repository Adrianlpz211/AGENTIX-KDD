'use strict';
/**
 * Almacén de evidencias y originales (C01 "Seguridad de evidencias" + H01 "Almacén").
 *
 * Guarda el ORIGINAL AUTORIZADO de lo que luego se entrega compactado, para poder
 * recuperarlo íntegro, por rango, por página o por selector JSON limitado.
 *
 * No es una segunda memoria KDD: es una caché/archivo auxiliar con identidad por
 * proyecto + hash. El conocimiento vive en `nodos`; aquí solo viven artefactos.
 *
 * Garantías (cada una tiene prueba):
 *   · Privacidad primero: lo guardado ya pasó por memory-privacy (secretos tapados
 *     ANTES de escribir, tanto el original como cualquier resumen). Rutas privadas
 *     y binarios sin autorizar no se guardan.
 *   · Guardado atómico (tmp + fsync + rename) y la referencia solo se devuelve
 *     cuando el original quedó confirmado en disco Y en la tabla.
 *   · Al recuperar se verifican tamaño y SHA-256. Si cambió → EVIDENCE_CHANGED;
 *     si no existe → EVIDENCE_UNAVAILABLE; si caducó → EXPIRED. Nunca contenido
 *     reconstruido ni un PASS inventado.
 *   · Aislamiento: realpath dentro de `.agentic/_evidence` (o de la raíz del
 *     proyecto para referencias a archivos); se rechazan traversal, symlinks hacia
 *     fuera, referencias de otro proyecto y cualquier URL/ruta entregada por una
 *     herramienta como ubicación de confianza.
 *   · Retención: `durable_audit` (gates) nunca se purga; lo referenciado por una
 *     tarea/sprint activo tiene PIN (persiste el reinicio, se libera explícitamente);
 *     solo la caché sin pin se purga por TTL/LRU. Sin espacio: el original NO se
 *     comprime y se pierde; se devuelve NO_SPACE y quien llama entrega el original.
 *   · Límites: tamaño por objeto, total del almacén y tamaño de página; lectura por
 *     bloques (no se carga un archivo enorme en RAM para paginarlo).
 *   · Selector JSON sin eval: ruta (a.b[3], a[0:20]) y proyección de campos.
 *
 * Esto NO ejecuta jamás nada de lo recuperado: es dato.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const core = require('./memory-core.cjs');
const privacy = require('./memory-privacy.cjs');

const DIR = path.join('.agentic', '_evidence');
const LIMITES = Object.freeze({
  max_object_bytes: 64 * 1024 * 1024,
  max_store_bytes: 512 * 1024 * 1024,
  page_bytes: 64 * 1024,
  max_page_bytes: 1024 * 1024,
  max_json_selector_bytes: 16 * 1024 * 1024,
  cache_ttl_ms: 7 * 24 * 3600 * 1000,
  huerfano_ms: 3600 * 1000,
});
const RETENCIONES = ['durable_audit', 'cache'];
const PESO = { cache: 1, durable_audit: 2 };
const BLOQUE = 1024 * 1024;

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const iso = (o) => new Date(o && o.now ? o.now : Date.now()).toISOString();
const idDe = (hash) => 'ev_' + hash.slice(0, 40);
const falla = (code, message, extra) => ({ ok: false, status: code, code, message, ...(extra || {}) });

function raizAlmacen(root) { return path.join(root, DIR); }
function rutaObjeto(root, hash) { return path.join(raizAlmacen(root), 'objects', hash.slice(0, 2), hash); }

/** ¿`hijo` está dentro de `padre` (tras resolver enlaces)? */
function dentroDe(padre, hijo) {
  const rel = path.relative(padre, hijo);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
function realpathSeguro(p) { try { return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p); } catch { return null; } }

function hashArchivo(ruta) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(ruta, 'r');
  try {
    const buf = Buffer.allocUnsafe(Math.min(BLOQUE, 1 << 20));
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

function escribirAtomico(root, hash, bytes) {
  const destino = rutaObjeto(root, hash);
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  if (fs.existsSync(destino) && fs.statSync(destino).size === bytes.length) return destino;
  const tmpDir = path.join(raizAlmacen(root), 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmp = path.join(tmpDir, hash.slice(0, 12) + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex'));
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, bytes, 0, bytes.length); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(tmp, destino); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* ya no está */ } if (!fs.existsSync(destino)) throw e; }
  return destino;
}

function bytesTotales(root) {
  const base = path.join(raizAlmacen(root), 'objects');
  let total = 0;
  const rec = (d) => { let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of ents) { const p = path.join(d, e.name); if (e.isDirectory()) rec(p); else { try { total += fs.statSync(p).size; } catch { /* desapareció */ } } } };
  rec(base);
  return total;
}

// ───────────────────────────── guardar ──────────────────────────────────────
/**
 * Guarda un original AUTORIZADO. entrada: { text } | { bytes }.
 * opts: { kind, task_id, retention, content_type, scope, source_path, allow_binary, max_object_bytes, max_store_bytes, now }
 * Devuelve { ok:true, evidence_id, sha256, bytes, retention, privacy_class, redactions } o { ok:false, code }.
 */
function guardar(root, entrada, opts = {}) {
  try {
    const retention = opts.retention || 'cache';
    if (!RETENCIONES.includes(retention)) return falla('RETENCION_INVALIDA', 'retention debe ser ' + RETENCIONES.join('|'));
    const pol = privacy.cargarPolitica(root);
    let bytes;
    let clase = 'authorized';
    let redacciones = 0;
    if (entrada && Buffer.isBuffer(entrada.bytes) && entrada.bytes.includes(0)) {
      if (!opts.allow_binary) return falla('BINARY_NOT_ALLOWED', 'Un binario no se puede escanear en busca de secretos: solo se guarda con allow_binary explícito.', { privacy_class: 'unknown' });
      if (opts.source_path && privacy.rutaPrivada(root, opts.source_path)) return falla('PRIVATE_NOT_STORED', 'ruta privada', { privacy_class: 'private' });
      bytes = entrada.bytes;
    } else {
      const p = privacy.prepararParaPersistir({ ...(entrada || {}), path: opts.source_path, modo: opts.modo || (entrada && entrada.modo) }, pol);
      if (p.privacy_class === 'private') return falla('PRIVATE_NOT_STORED', 'Contenido privado (' + p.motivo + '): no se guarda ni payload ni vista previa.', { privacy_class: 'private' });
      if (p.privacy_class === 'unknown') return falla('UNCLASSIFIABLE', 'No se pudo clasificar/redactar (' + p.motivo + '): no se guarda.', { privacy_class: 'unknown' });
      clase = p.privacy_class; redacciones = p.redactions;
      bytes = Buffer.from(p.text, 'utf8');
    }
    const maxObj = opts.max_object_bytes || LIMITES.max_object_bytes;
    if (bytes.length > maxObj) return falla('TOO_LARGE', 'El objeto (' + bytes.length + ' B) excede el límite (' + maxObj + ' B): entrega el original o pagínalo en origen.', { bytes: bytes.length });

    const hash = sha256(bytes);
    const eid = idDe(hash);
    const maxStore = opts.max_store_bytes || LIMITES.max_store_bytes;
    if (!fs.existsSync(rutaObjeto(root, hash)) && bytesTotales(root) + bytes.length > maxStore) {
      limpiar(root, { now: opts.now, max_bytes: Math.max(0, maxStore - bytes.length) });
      if (bytesTotales(root) + bytes.length > maxStore) return falla('NO_SPACE', 'No hay espacio para conservar el original: NO se comprime ni se entrega una referencia que no se pueda cumplir.', { bytes: bytes.length });
    }

    const db = core.abrir(root, { write: true });
    if (!db) return falla('NO_DB', 'No hay memoria.db');
    try {
      const faltan = core.tablasFaltantes(db, ['mem_evidence', 'mem_project']);
      if (faltan.length) return falla('SCHEMA_MISSING', 'Faltan tablas (' + faltan.join(', ') + '): ejecuta akdd update.', { missing: faltan });
      const ident = core.identidad(root);
      let pid = ident.project_id;
      if (ident.state === 'ROOT_MISMATCH') return falla('PROJECT_ROOT_MISMATCH', 'La memoria pertenece a otra ruta: akdd memory project adopt|fork');
      if (!pid) {
        pid = 'prj_' + crypto.randomUUID().replace(/-/g, '');
        db.run('INSERT OR IGNORE INTO mem_project (singleton, project_id, canonical_root, created_at, origin) VALUES (1, ?, ?, ?, ?)', pid, core.canonicalRoot(root), iso(opts), 'created');
        pid = db.get('SELECT project_id FROM mem_project WHERE singleton = 1').project_id;
      }
      const previa = db.get('SELECT evidence_id, sha256, retention, status FROM mem_evidence WHERE evidence_id = ?', eid);
      if (previa && previa.sha256 !== hash) return falla('EVIDENCE_ID_COLLISION', 'El identificador ya existe con otro contenido: se rechaza.');

      const destino = escribirAtomico(root, hash, bytes);
      if (!fs.existsSync(destino) || fs.statSync(destino).size !== bytes.length) return falla('WRITE_UNCONFIRMED', 'El original no quedó confirmado en disco: no se entrega referencia.');
      db.transaction(() => {
        const ahora = iso(opts);
        if (!previa) {
          db.run(
            `INSERT INTO mem_evidence (evidence_id, project_id, kind, store, locator, sha256, bytes, content_type, scope, policy_id, privacy_class, retention, status, created_at, last_verified_at, last_accessed_at, expires_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'AVAILABLE', ?, ?, ?, ?)`,
            eid, pid, opts.kind || 'tool_output', 'evidence_store', path.posix.join('objects', hash.slice(0, 2), hash), hash, bytes.length, opts.content_type || 'text/plain', opts.scope || opts.task_id || null, pol.policy_id, clase, retention, ahora, ahora, ahora,
            retention === 'cache' ? new Date((opts.now || Date.now()) + (opts.ttl_ms || LIMITES.cache_ttl_ms)).toISOString() : null,
          );
        } else {
          const sube = (PESO[retention] || 0) > (PESO[previa.retention] || 0);
          db.run("UPDATE mem_evidence SET status = 'AVAILABLE', last_verified_at = ?, retention = ?, expires_at = ? WHERE evidence_id = ?", ahora, sube ? retention : previa.retention, (sube ? retention : previa.retention) === 'cache' ? new Date((opts.now || Date.now()) + (opts.ttl_ms || LIMITES.cache_ttl_ms)).toISOString() : null, eid);
        }
      })();
      return { ok: true, status: 'OK', evidence_id: eid, sha256: hash, bytes: bytes.length, retention: previa && (PESO[previa.retention] || 0) > (PESO[retention] || 0) ? previa.retention : retention, privacy_class: clase, redactions: redacciones, policy_id: pol.policy_id };
    } finally { db.close(); }
  } catch (e) {
    return falla('STORE_FAILED', e && e.message);
  }
}

/**
 * Guarda un archivo del proyecto. `copy:true` (por defecto) copia su contenido autorizado al almacén
 * (durable si es de un gate); `copy:false` solo registra una referencia que se verifica al recuperar.
 */
function guardarArchivo(root, rel, opts = {}) {
  const relN = privacy.normRuta(rel);
  if (!relN || relN.split('/').includes('..') || path.isAbsolute(relN)) return falla('DENIED', 'ruta fuera de la raíz del proyecto');
  if (privacy.rutaPrivada(root, relN)) return falla('PRIVATE_NOT_STORED', 'ruta privada', { privacy_class: 'private' });
  const raizReal = realpathSeguro(root);
  const real = realpathSeguro(path.join(root, relN));
  if (!real || !raizReal) return falla('EVIDENCE_UNAVAILABLE', 'el archivo no existe');
  if (!dentroDe(raizReal, real)) return falla('DENIED', 'el enlace apunta fuera del proyecto');
  const st = fs.statSync(real);
  if (!st.isFile()) return falla('DENIED', 'no es un archivo regular');
  if (opts.copy === false) return registrarReferenciaArchivo(root, relN, real, st, opts);
  if (st.size > (opts.max_object_bytes || LIMITES.max_object_bytes)) return falla('TOO_LARGE', 'archivo demasiado grande para copiar', { bytes: st.size });
  return guardar(root, { bytes: fs.readFileSync(real) }, { ...opts, source_path: relN, kind: opts.kind || 'artifact', retention: opts.retention || 'durable_audit', allow_binary: opts.allow_binary });
}

function registrarReferenciaArchivo(root, relN, real, st, opts) {
  const db = core.abrir(root, { write: true });
  if (!db) return falla('NO_DB', 'No hay memoria.db');
  try {
    if (core.tablasFaltantes(db, ['mem_evidence', 'mem_project']).length) return falla('SCHEMA_MISSING', 'ejecuta akdd update');
    const ident = core.identidad(root);
    if (ident.state === 'ROOT_MISMATCH') return falla('PROJECT_ROOT_MISMATCH', 'otra ruta');
    const hash = hashArchivo(real);
    const eid = idDe(hash);
    const ahora = iso(opts);
    const pid = ident.project_id || (() => { const id = 'prj_' + crypto.randomUUID().replace(/-/g, ''); db.run('INSERT OR IGNORE INTO mem_project (singleton, project_id, canonical_root, created_at, origin) VALUES (1, ?, ?, ?, ?)', id, core.canonicalRoot(root), ahora, 'created'); return db.get('SELECT project_id FROM mem_project WHERE singleton = 1').project_id; })();
    const previa = db.get('SELECT sha256 FROM mem_evidence WHERE evidence_id = ?', eid);
    if (previa && previa.sha256 !== hash) return falla('EVIDENCE_ID_COLLISION', 'colisión de identificador');
    if (!previa) db.run(`INSERT INTO mem_evidence (evidence_id, project_id, kind, store, locator, sha256, bytes, content_type, scope, policy_id, privacy_class, retention, status, created_at, last_verified_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'AVAILABLE', ?, ?)`, eid, pid, opts.kind || 'artifact', 'project_file', relN, hash, st.size, opts.content_type || 'application/octet-stream', opts.scope || null, privacy.cargarPolitica(root).policy_id, 'authorized', opts.retention || 'cache', ahora, ahora);
    return { ok: true, status: 'OK', evidence_id: eid, sha256: hash, bytes: st.size, store: 'project_file', locator: relN };
  } finally { db.close(); }
}

// ───────────────────────────── resolver y verificar ─────────────────────────
function filaDe(root, evidence_id) {
  const db = core.abrir(root);
  if (!db) return { error: falla('NO_DB', 'No hay memoria.db') };
  try {
    if (core.tablasFaltantes(db, ['mem_evidence']).length) return { error: falla('SCHEMA_MISSING', 'Faltan tablas: akdd update') };
    if (!/^ev_[a-f0-9]{16,64}$/.test(String(evidence_id || ''))) return { error: falla('UNKNOWN_REFERENCE', 'referencia mal formada') };
    const f = db.get('SELECT * FROM mem_evidence WHERE evidence_id = ?', evidence_id);
    if (!f) return { error: falla('UNKNOWN_REFERENCE', 'la referencia no existe en este proyecto') };
    const ident = db.get('SELECT project_id FROM mem_project WHERE singleton = 1');
    if (ident && f.project_id !== ident.project_id) return { error: falla('DENIED', 'la referencia pertenece a otro proyecto') };
    return { fila: f };
  } finally { db.close(); }
}

/** Ruta real y segura de una evidencia, o error. */
function resolver(root, f) {
  if (f.store === 'evidence_store') {
    const base = realpathSeguro(raizAlmacen(root)) || path.resolve(raizAlmacen(root));
    const objeto = path.join(raizAlmacen(root), f.locator);
    const real = realpathSeguro(objeto);
    if (!real) return falla('EVIDENCE_UNAVAILABLE', 'el original ya no está en el almacén');
    if (!dentroDe(base, real)) return falla('DENIED', 'ruta fuera del almacén');
    return { ok: true, ruta: real };
  }
  if (f.store === 'project_file') {
    const raizReal = realpathSeguro(root);
    const real = realpathSeguro(path.join(root, f.locator));
    if (!real) return falla('EVIDENCE_UNAVAILABLE', 'el archivo referenciado ya no existe');
    if (!raizReal || !dentroDe(raizReal, real)) return falla('DENIED', 'el enlace apunta fuera del proyecto');
    return { ok: true, ruta: real };
  }
  return falla('DENIED', 'almacén desconocido');
}

const verificadas = new Map(); // ruta → { mtimeMs, size, sha }

function comprobar(root, f) {
  if (f.status === 'EXPIRED') return falla('EXPIRED', 'La evidencia caducó y se purgó (nunca se reconstruye).', { evidence_id: f.evidence_id });
  const r = resolver(root, f);
  if (!r.ok) return { ...r, evidence_id: f.evidence_id };
  const st = fs.statSync(r.ruta);
  if (st.size !== Number(f.bytes)) return falla('EVIDENCE_CHANGED', 'El tamaño cambió (' + f.bytes + ' → ' + st.size + ').', { evidence_id: f.evidence_id, expected_bytes: Number(f.bytes), actual_bytes: st.size });
  const cache = verificadas.get(r.ruta);
  let hash;
  if (cache && cache.mtimeMs === st.mtimeMs && cache.size === st.size) hash = cache.sha;
  else {
    hash = hashArchivo(r.ruta);
    // Solo se confía en la caché si el archivo es lo bastante ANTIGUO: un cambio del mismo tamaño dentro de la misma marca de
    // tiempo (resolución del sistema de archivos) no cambiaría mtime ni size y pasaría por intacto («racy» como en git).
    if (Date.now() - st.mtimeMs > 3000) verificadas.set(r.ruta, { mtimeMs: st.mtimeMs, size: st.size, sha: hash });
  }
  if (hash !== f.sha256) return falla('EVIDENCE_CHANGED', 'El contenido cambió (el hash ya no coincide).', { evidence_id: f.evidence_id, expected_sha256: f.sha256, actual_sha256: hash });
  return { ok: true, status: 'OK', ruta: r.ruta, evidence_id: f.evidence_id, sha256: f.sha256, bytes: Number(f.bytes) };
}

/** Estado verificable de una evidencia (hash + tamaño al momento). No escribe. */
function verificar(root, evidence_id) {
  const { fila, error } = filaDe(root, evidence_id);
  if (error) return error;
  const c = comprobar(root, fila);
  if (!c.ok) return c;
  return { ok: true, status: 'OK', evidence_id, sha256: c.sha256, bytes: c.bytes, retention: fila.retention, kind: fila.kind, store: fila.store, privacy_class: fila.privacy_class };
}

// ───────────────────────────── recuperar ────────────────────────────────────
function leerBloque(ruta, offset, length) {
  const fd = fs.openSync(ruta, 'r');
  try {
    const buf = Buffer.allocUnsafe(length);
    const n = fs.readSync(fd, buf, 0, length, offset);
    return buf.subarray(0, n);
  } finally { fs.closeSync(fd); }
}

/** Ajusta [ini, fin) para no cortar un carácter UTF-8 por la mitad. */
function alinearUtf8(ruta, total, ini, fin) {
  const esCont = (b) => (b & 0xC0) === 0x80;
  let a = ini;
  if (a > 0 && a < total) { const b = leerBloque(ruta, a, 1); while (a > 0 && b.length && esCont(b[0])) { a--; b[0] = leerBloque(ruta, a, 1)[0]; } }
  let z = fin;
  if (z < total) { let b = leerBloque(ruta, z, 1); while (z < total && b.length && esCont(b[0])) { z++; b = leerBloque(ruta, z, 1); } }
  return [a, Math.min(z, total)];
}

function leerLineas(ruta, desde, hasta, maxBytes) {
  const fd = fs.openSync(ruta, 'r');
  const out = [];
  let linea = 1; let resto = Buffer.alloc(0); let pos = 0; let bytes = 0; let truncado = false; let ultima = 0;
  const tam = fs.fstatSync(fd).size;
  try {
    const buf = Buffer.allocUnsafe(BLOQUE);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, pos)) > 0) {
      pos += n;
      let datos = Buffer.concat([resto, buf.subarray(0, n)]);
      let i;
      while ((i = datos.indexOf(10)) >= 0) {
        const txt = datos.subarray(0, i).toString('utf8').replace(/\r$/, '');
        datos = datos.subarray(i + 1);
        if (linea >= desde && linea <= hasta) {
          bytes += Buffer.byteLength(txt) + 1;
          if (bytes > maxBytes) { truncado = true; return { lineas: out, ultima, truncado, llegoAlFinal: false }; }
          out.push(txt); ultima = linea;
        }
        linea++;
        // Pasamos de la última línea pedida: ¿queda algo más en el original? Solo entonces hay más páginas.
        if (linea > hasta) return { lineas: out, ultima, truncado, llegoAlFinal: !(datos.length > 0 || pos < tam) };
      }
      resto = datos;
    }
    if (resto.length && linea >= desde && linea <= hasta) { out.push(resto.toString('utf8')); ultima = linea; }
    return { lineas: out, ultima, truncado, llegoAlFinal: true };
  } finally { fs.closeSync(fd); }
}

const RE_SELECTOR = /^(?:\.?[A-Za-z_$][\w$-]*|\[\d+\]|\[\d*:\d*\])+$/;
/** Selector JSON limitado: ruta + proyección. NUNCA eval. */
function aplicarSelector(obj, sel) {
  let v = obj;
  const ruta = String(sel.path || '');
  if (ruta) {
    if (!RE_SELECTOR.test(ruta)) return { ok: false, code: 'SELECTOR_INVALIDO' };
    const toks = ruta.match(/\.?[A-Za-z_$][\w$-]*|\[\d+\]|\[\d*:\d*\]/g);
    for (const t of toks) {
      if (v == null) return { ok: false, code: 'SELECTOR_SIN_RESULTADO' };
      if (t.startsWith('[')) {
        const m = /^\[(\d*)(:)?(\d*)\]$/.exec(t);
        if (!Array.isArray(v)) return { ok: false, code: 'SELECTOR_NO_ES_ARREGLO' };
        v = m[2] ? v.slice(m[1] === '' ? 0 : Number(m[1]), m[3] === '' ? undefined : Number(m[3])) : v[Number(m[1])];
      } else {
        const k = t.replace(/^\./, '');
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') return { ok: false, code: 'SELECTOR_INVALIDO' };
        if (typeof v !== 'object' || !Object.prototype.hasOwnProperty.call(v, k)) return { ok: false, code: 'SELECTOR_SIN_RESULTADO' };
        v = v[k];
      }
    }
  }
  const total = Array.isArray(v) ? v.length : null;
  let paginado = null;
  if (Array.isArray(v) && (sel.limit != null || sel.offset != null)) {
    const off = Math.max(0, Number(sel.offset) || 0); const lim = Math.min(Math.max(1, Number(sel.limit) || 50), 1000);
    v = v.slice(off, off + lim); paginado = { offset: off, limit: lim, total };
  }
  if (Array.isArray(sel.fields) && sel.fields.length) {
    const campos = sel.fields.map(String).filter((c) => /^[A-Za-z_$][\w$-]*$/.test(c) && c !== '__proto__' && c !== 'constructor');
    const pick = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.fromEntries(campos.filter((c) => Object.prototype.hasOwnProperty.call(o, c)).map((c) => [c, o[c]])) : o);
    v = Array.isArray(v) ? v.map(pick) : pick(v);
  }
  return { ok: true, value: v, total, paginated: paginado };
}

/**
 * Recupera un original. sel: { offset,length } | { cursor } | { line_from,line_to } | { json:{path,fields,offset,limit} }
 * Siempre devuelve sha256, bytes totales, si la respuesta es completa y el cursor siguiente.
 */
function obtener(root, evidence_id, sel = {}, opts = {}) {
  const { fila, error } = filaDe(root, evidence_id);
  if (error) return error;
  const c = comprobar(root, fila);
  if (!c.ok) return c;
  const base = { ok: true, status: 'OK', evidence_id, sha256: c.sha256, total_bytes: c.bytes, kind: fila.kind, retention: fila.retention, privacy_class: fila.privacy_class };
  const maxPage = Math.min(Number(opts.max_page_bytes) || LIMITES.max_page_bytes, LIMITES.max_page_bytes);
  let respuesta;
  if (sel.json) {
    if (c.bytes > LIMITES.max_json_selector_bytes) return falla('TOO_LARGE_FOR_SELECTOR', 'El JSON excede el límite del selector: pagina por bytes o líneas.', { total_bytes: c.bytes });
    let obj; try { obj = JSON.parse(fs.readFileSync(c.ruta, 'utf8')); } catch (e) { return falla('NOT_JSON', 'El original no es JSON válido: ' + e.message); }
    const r = aplicarSelector(obj, sel.json);
    if (!r.ok) return falla(r.code, 'selector no aplicable');
    const texto = JSON.stringify(r.value);
    if (Buffer.byteLength(texto) > maxPage) return falla('SELECTOR_TOO_BIG', 'El resultado del selector excede la página: acótalo con limit/offset/fields.', { bytes: Buffer.byteLength(texto) });
    respuesta = { ...base, selector: sel.json, content: texto, content_type: 'application/json', selection_total: r.total, paginated: r.paginated, complete: false, has_more: false, note: 'Es una SELECCIÓN del original, no el original completo.' };
  } else if (sel.line_from != null || sel.line_to != null) {
    const desde = Math.max(1, Number(sel.line_from) || 1); const hasta = Math.max(desde, Number(sel.line_to) || desde + 199);
    const r = leerLineas(c.ruta, desde, hasta, maxPage);
    respuesta = { ...base, content: r.lineas.join('\n'), range: { line_from: desde, line_to: r.ultima || desde }, complete: desde === 1 && r.llegoAlFinal && !r.truncado, has_more: !r.llegoAlFinal || r.truncado, next_cursor: !r.llegoAlFinal || r.truncado ? { line_from: (r.ultima || desde - 1) + 1 } : null };
  } else {
    const ini0 = Math.max(0, Number(sel.offset != null ? sel.offset : (sel.cursor && sel.cursor.offset)) || 0);
    const len = Math.min(Number(sel.length) || LIMITES.page_bytes, maxPage);
    if (ini0 >= c.bytes && c.bytes > 0) return falla('RANGE_OUT_OF_BOUNDS', 'offset fuera del original', { total_bytes: c.bytes });
    const [ini, fin] = alinearUtf8(c.ruta, c.bytes, ini0, Math.min(c.bytes, ini0 + len));
    const buf = leerBloque(c.ruta, ini, fin - ini);
    respuesta = { ...base, content: buf.toString('utf8'), range: { offset: ini, length: buf.length }, complete: ini === 0 && fin >= c.bytes, has_more: fin < c.bytes, next_cursor: fin < c.bytes ? { offset: fin } : null };
  }
  respuesta.delivered_bytes = Buffer.byteLength(respuesta.content || '');
  if (opts.touch !== false) tocar(root, evidence_id, opts);
  return respuesta;
}

function tocar(root, evidence_id, opts) {
  let db = null;
  try {
    db = core.abrir(root, { write: true });
    if (db) db.run('UPDATE mem_evidence SET last_accessed_at = ?, last_verified_at = ? WHERE evidence_id = ?', iso(opts), iso(opts), evidence_id);
  } catch { /* contabilizar el acceso es auxiliar: no rompe la recuperación */ } finally { try { if (db) db.close(); } catch { /* ya cerrada */ } }
}

// ───────────────────────────── pins y retención ─────────────────────────────
function fijar(root, evidence_id, owner_kind, owner_id, opts = {}) {
  if (!['task', 'sprint', 'plan'].includes(owner_kind) || !owner_id) return falla('PIN_INVALIDO', 'owner_kind debe ser task|sprint|plan y owner_id obligatorio');
  const { fila, error } = filaDe(root, evidence_id);
  if (error) return error;
  const db = core.abrir(root, { write: true });
  if (!db) return falla('NO_DB', 'No hay memoria.db');
  try {
    if (core.tablasFaltantes(db, ['mem_evidence_pins']).length) return falla('SCHEMA_MISSING', 'ejecuta akdd update');
    db.run('INSERT OR IGNORE INTO mem_evidence_pins (evidence_id, owner_kind, owner_id, created_at) VALUES (?,?,?,?)', fila.evidence_id, owner_kind, String(owner_id), iso(opts));
    return { ok: true, status: 'OK', evidence_id, pinned_by: { owner_kind, owner_id: String(owner_id) } };
  } finally { db.close(); }
}

/** Libera todos los pins de un dueño al cerrar/abandonar explícitamente la tarea/sprint/plan. */
function soltar(root, owner_kind, owner_id) {
  const db = core.abrir(root, { write: true });
  if (!db) return falla('NO_DB', 'No hay memoria.db');
  try {
    if (core.tablasFaltantes(db, ['mem_evidence_pins']).length) return falla('SCHEMA_MISSING', 'ejecuta akdd update');
    const r = db.run('DELETE FROM mem_evidence_pins WHERE owner_kind = ? AND owner_id = ?', owner_kind, String(owner_id));
    return { ok: true, status: 'OK', released: r.changes };
  } finally { db.close(); }
}

/**
 * Purga SOLO caché sin pin: por TTL y, si se pasa max_bytes, por LRU. Nunca toca durable_audit,
 * nunca toca pins, nunca toca memoria. Repara huérfanos (archivos sin fila, de un fallo a medio guardar).
 */
function limpiar(root, opts = {}) {
  const ahoraMs = opts.now || Date.now();
  const db = core.abrir(root, { write: !opts.dry_run });
  if (!db) return { ok: false, code: 'NO_DB' };
  const borrados = []; const huerfanos = [];
  try {
    if (core.tablasFaltantes(db, ['mem_evidence', 'mem_evidence_pins']).length) return { ok: false, code: 'SCHEMA_MISSING' };
    const candidatas = db.all(`SELECT e.* FROM mem_evidence e WHERE e.retention = 'cache' AND e.status = 'AVAILABLE' AND e.store = 'evidence_store'
      AND NOT EXISTS (SELECT 1 FROM mem_evidence_pins p WHERE p.evidence_id = e.evidence_id) ORDER BY COALESCE(e.last_accessed_at, e.created_at) ASC`);
    const caducadas = candidatas.filter((e) => e.expires_at && Date.parse(e.expires_at) <= ahoraMs);
    const aBorrar = new Set(caducadas.map((e) => e.evidence_id));
    if (Number.isFinite(opts.max_bytes)) {
      let total = bytesTotales(root);
      for (const e of caducadas) total -= Number(e.bytes);
      for (const e of candidatas) { if (total <= opts.max_bytes) break; if (!aBorrar.has(e.evidence_id)) { aBorrar.add(e.evidence_id); total -= Number(e.bytes); } }
    }
    for (const e of candidatas.filter((x) => aBorrar.has(x.evidence_id))) {
      if (!opts.dry_run) {
        try { fs.unlinkSync(path.join(raizAlmacen(root), e.locator)); } catch { /* ya no estaba */ }
        db.run("UPDATE mem_evidence SET status = 'EXPIRED' WHERE evidence_id = ?", e.evidence_id);
      }
      borrados.push(e.evidence_id);
    }
    // huérfanos: objetos sin fila, de más de una hora
    const conocidos = new Set(db.all("SELECT sha256 FROM mem_evidence WHERE store = 'evidence_store'").map((r) => r.sha256));
    const base = path.join(raizAlmacen(root), 'objects');
    const rec = (d) => { let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const en of ents) { const p = path.join(d, en.name); if (en.isDirectory()) rec(p); else if (!conocidos.has(en.name)) { try { if (ahoraMs - fs.statSync(p).mtimeMs > LIMITES.huerfano_ms) { huerfanos.push(en.name); if (!opts.dry_run) fs.unlinkSync(p); } } catch { /* carrera */ } } } };
    rec(base);
    return { ok: true, status: 'OK', expired: borrados, orphans_removed: huerfanos, dry_run: !!opts.dry_run };
  } finally { db.close(); }
}

function estadisticas(root) {
  const db = core.abrir(root);
  if (!db) return { available: false, code: 'NO_DB' };
  try {
    if (core.tablasFaltantes(db, ['mem_evidence', 'mem_evidence_pins']).length) return { available: false, code: 'SCHEMA_MISSING' };
    return {
      available: true,
      by_retention: db.all("SELECT retention, status, count(*) AS n, COALESCE(SUM(bytes),0) AS bytes FROM mem_evidence GROUP BY 1,2"),
      pinned: Number(db.get('SELECT count(DISTINCT evidence_id) AS n FROM mem_evidence_pins').n),
      store_bytes: bytesTotales(root),
      limits: { ...LIMITES },
    };
  } finally { db.close(); }
}

module.exports = { LIMITES, RETENCIONES, guardar, guardarArchivo, verificar, obtener, fijar, soltar, limpiar, estadisticas, aplicarSelector, idDe, rutaObjeto, raizAlmacen };
