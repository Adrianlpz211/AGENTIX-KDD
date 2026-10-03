'use strict';
/**
 * Reutilización de contexto (H02 "Reutilización"): no entregar dos veces lo que
 * el receptor YA tiene, y no ocultar jamás un cambio.
 *
 * Dos cachés, ambas AUXILIARES (no son otra memoria: son datos derivados que se
 * pueden borrar sin perder conocimiento; el manifest de instalación las excluye):
 *
 *  1. Lecturas — clave: proyecto + realpath + selector (líneas/bytes).
 *     Se valida SIEMPRE por el hash del contenido seleccionado, leído de nuevo en
 *     cada llamada: el nombre igual NO prueba contenido igual. Resultado:
 *       NUEVO        el receptor nunca lo recibió → se entrega el contenido.
 *       REFERENCIA   el receptor ya lo tiene y no cambió → solo una referencia.
 *       CAMBIADO     el hash cambió → DELTA (un tramo) o la nueva versión completa.
 *       FORZADO      `necesario:true` (p. ej. reparar un bug): se entrega igual.
 *     Lo que "tiene el receptor" es por receptor (tarea+rol+sesión): si la sesión
 *     reinició, `olvidarReceptor` y vuelve a recibirlo todo.
 *
 *  2. Contexto — clave: proyecto + tarea + rol + revisión de memoria + revisión
 *     de código (hashes de los archivos) + versión de política. Cualquier cambio
 *     de esas tres revisiones INVALIDA la entrada y se reconstruye.
 *
 * Garantías con prueba:
 *   · Un cambio de hash nunca devuelve REFERENCIA.
 *   · Una lectura marcada necesaria nunca se sustituye por una referencia.
 *   · No se guarda CONTENIDO de archivos en la caché de lecturas: solo hashes de
 *     contenido y de línea (un delta se calcula contra hashes de línea).
 *   · Rutas privadas, binarios y enlaces fuera del proyecto no se entregan.
 *   · Cada acierto/invalidación se anota en el presupuesto acumulado de la tarea
 *     (effort-budget) y en los contadores propios; fail-soft.
 *
 * Una caché ausente, corrupta o expirada solo cuesta volver a entregar el
 * contenido: el fallo siempre va hacia "entregar", nunca hacia "omitir".
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const privacy = require('./memory-privacy.cjs');

const DIR = path.join('.agentic', '_context', 'reuse');
const ARCHIVO = 'estado.json';
const LIMITES = Object.freeze({
  max_read_bytes: 8 * 1024 * 1024,        // archivo máximo que se lee para hashear/entregar
  max_deliver_bytes: 512 * 1024,          // contenido máximo entregado en una llamada
  max_lineas_delta: 20000,                // más líneas: sin delta, versión completa
  delta_max_ratio: 0.6,                   // un delta solo se usa si pesa < 60 % de la versión nueva
  max_lecturas: 3000,
  max_versiones_por_lectura: 3,
  max_contextos: 200,
  max_body_bytes: 256 * 1024,
  ttl_ms: 7 * 24 * 3600 * 1000,
});

const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
const iso = (o) => new Date(o && o.now ? o.now : Date.now()).toISOString();
const nowMs = (o) => (o && o.now ? new Date(o.now).getTime() : Date.now());
const hash8 = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 8);
const falla = (code, message, extra) => ({ ok: false, status: code, code, message, ...(extra || {}) });
const normRel = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');

// ─── estado en disco ─────────────────────────────────────────────────────────

const vacio = () => ({ schema_version: 1, lecturas: {}, contextos: {}, contadores: { reference_hits: 0, saved_bytes: 0, invalidations: 0, forced_reads: 0, new_reads: 0, changed_reads: 0, context_hits: 0, context_builds: 0 } });
const archivo = (root) => path.join(root, DIR, ARCHIVO);

function cargar(root) {
  try {
    const e = JSON.parse(fs.readFileSync(archivo(root), 'utf8'));
    if (!e || e.schema_version !== 1 || typeof e.lecturas !== 'object' || typeof e.contextos !== 'object') return vacio();
    e.contadores = { ...vacio().contadores, ...(e.contadores || {}) };
    return e;
  } catch { return vacio(); } // ausente o corrupta: se empieza de cero (entregar de más, jamás de menos)
}

function guardar(root, e) {
  try {
    const f = archivo(root);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + '.' + process.pid + '.' + crypto.randomBytes(3).toString('hex') + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(e));
    fs.renameSync(tmp, f);
    return true;
  } catch { return false; } // caché auxiliar: no poder escribirla no rompe nada
}

function acotar(e, ahora) {
  const ls = Object.entries(e.lecturas);
  if (ls.length > LIMITES.max_lecturas) {
    ls.sort((a, b) => (a[1].last_used || 0) - (b[1].last_used || 0));
    for (const [k] of ls.slice(0, ls.length - LIMITES.max_lecturas)) delete e.lecturas[k];
  }
  for (const [k, v] of Object.entries(e.lecturas)) if (ahora - (v.last_used || 0) > LIMITES.ttl_ms) delete e.lecturas[k];
  const cs = Object.entries(e.contextos);
  for (const [k, v] of cs) if (ahora - (v.last_used || 0) > LIMITES.ttl_ms) delete e.contextos[k];
  const restantes = Object.entries(e.contextos);
  if (restantes.length > LIMITES.max_contextos) {
    restantes.sort((a, b) => (a[1].last_used || 0) - (b[1].last_used || 0));
    for (const [k] of restantes.slice(0, restantes.length - LIMITES.max_contextos)) delete e.contextos[k];
  }
}

// ─── rutas seguras ───────────────────────────────────────────────────────────

const realSeguro = (p) => { try { return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p); } catch { return null; } };
function dentroDe(padre, hijo) { const r = path.relative(padre, hijo); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); }

/** Resuelve `rel` a un archivo REAL dentro del proyecto, o devuelve el motivo del rechazo. */
function resolverArchivo(root, rel) {
  const raizReal = realSeguro(root);
  if (!raizReal) return falla('NO_ROOT', 'raíz del proyecto ilegible');
  let relN = normRel(rel);
  if (path.isAbsolute(relN) || /^[a-zA-Z]:\//.test(relN)) {
    const real = realSeguro(relN);
    if (!real || !dentroDe(raizReal, real)) return falla('DENIED', 'ruta fuera del proyecto');
    relN = path.relative(raizReal, real).split(path.sep).join('/');
  }
  if (!relN || relN.split('/').includes('..')) return falla('DENIED', 'ruta fuera del proyecto');
  if (privacy.rutaPrivada(root, relN)) return falla('PRIVATE_NOT_DELIVERED', 'ruta privada según la política: no se entrega ni se cachea', { privacy_class: 'private' });
  const real = realSeguro(path.join(root, relN));
  if (!real) return falla('NOT_FOUND', 'el archivo no existe');
  if (!dentroDe(raizReal, real)) return falla('DENIED', 'el enlace apunta fuera del proyecto');
  let st;
  try { st = fs.statSync(real); } catch { return falla('NOT_FOUND', 'el archivo no existe'); }
  if (!st.isFile()) return falla('DENIED', 'no es un archivo regular');
  if (st.size > LIMITES.max_read_bytes) return falla('TOO_LARGE', 'el archivo excede el límite de lectura', { bytes: st.size });
  const relReal = path.relative(raizReal, real).split(path.sep).join('/');
  return { ok: true, real, relReal, size: st.size };
}

function selectorNorm(sel) {
  if (!sel) return { tipo: 'todo' };
  if (sel.line_from != null || sel.line_to != null) {
    const a = Math.max(1, Number(sel.line_from) || 1);
    const b = Math.max(a, Number(sel.line_to) || a + 199);
    return { tipo: 'lineas', from: a, to: b };
  }
  if (sel.offset != null || sel.length != null) return { tipo: 'bytes', offset: Math.max(0, Number(sel.offset) || 0), length: Math.max(1, Math.min(Number(sel.length) || 65536, LIMITES.max_deliver_bytes)) };
  return { tipo: 'todo' };
}

/** Contenido SELECCIONADO como texto exacto (lo que el receptor ve). */
function seleccionar(buf, sel) {
  if (buf.subarray(0, 8000).includes(0)) return falla('BINARY_NOT_DELIVERED', 'archivo binario: no se entrega como texto');
  if (sel.tipo === 'bytes') {
    const parte = buf.subarray(sel.offset, sel.offset + sel.length);
    return { ok: true, texto: parte.toString('utf8'), lineas: null };
  }
  const texto = buf.toString('utf8');
  if (sel.tipo === 'todo') return { ok: true, texto, lineas: texto.split('\n') };
  const todas = texto.split('\n');
  const parte = todas.slice(sel.from - 1, sel.to);
  return { ok: true, texto: parte.join('\n'), lineas: parte };
}

// ─── delta de un solo tramo ──────────────────────────────────────────────────

/**
 * Delta = prefijo y sufijo comunes (comparados por hash de línea) + lo insertado en medio.
 * `hb` son los hashes de línea de la versión que el receptor YA tiene (no se guarda su contenido).
 * Si un hash de línea colisionara, el receptor lo detecta con result_hash y pide la versión completa.
 */
function deltaPorHashes(hb, lineasNuevas, baseHash, resultHash) {
  const n = lineasNuevas.length;
  const m = hb.length;
  const hn = lineasNuevas.map(hash8);
  let pre = 0;
  while (pre < n && pre < m && hb[pre] === hn[pre]) pre++;
  let suf = 0;
  while (suf < n - pre && suf < m - pre && hb[m - 1 - suf] === hn[n - 1 - suf]) suf++;
  return { base_hash: baseHash, result_hash: resultHash, prefix_lines: pre, suffix_lines: suf, insert: lineasNuevas.slice(pre, n - suf) };
}
const calcularDelta = (lineasBase, lineasNuevas, baseHash, resultHash) => deltaPorHashes(lineasBase.map(hash8), lineasNuevas, baseHash, resultHash);

/** Receptor: reconstruye la versión nueva desde su texto base. Verifica el hash resultante. */
function aplicarDelta(textoBase, delta) {
  const base = String(textoBase).split('\n');
  if (sha(Buffer.from(textoBase)) !== delta.base_hash) return falla('DELTA_BASE_DISTINTA', 'la base del receptor no es la esperada: pide la versión completa');
  const out = base.slice(0, delta.prefix_lines).concat(delta.insert, delta.suffix_lines ? base.slice(base.length - delta.suffix_lines) : []);
  const texto = out.join('\n');
  if (sha(Buffer.from(texto)) !== delta.result_hash) return falla('DELTA_RESULTADO_DISTINTO', 'el resultado no coincide con el hash esperado: pide la versión completa');
  return { ok: true, texto };
}

// ─── presupuesto (fail-soft) ─────────────────────────────────────────────────

function anotar(root, task_id, ev, opts) {
  if (!task_id) return null;
  try { return require('./effort-budget.cjs').registrar(root, task_id, ev, opts); } catch { return null; }
}

// ─── lecturas ────────────────────────────────────────────────────────────────

/**
 * Lectura controlada con reutilización. opts:
 *   recipient   (OBLIGATORIO) quién recibe: p. ej. "T-1:builder:ses-ab12". Distintos receptores no comparten lo entregado.
 *   selector    { line_from, line_to } | { offset, length } | omitido (archivo completo)
 *   task_id, role, sprint_id   para el presupuesto acumulado
 *   necesario   true → entrega el contenido siempre (reparar un bug, verificar): jamás se sustituye por una referencia
 *   now
 */
function leer(root, rel, opts = {}) {
  try {
    if (!opts.recipient || !String(opts.recipient).trim()) return falla('RECIPIENT_REQUERIDO', 'sin receptor no se puede saber qué tiene ya');
    const r = resolverArchivo(root, rel);
    if (!r.ok) return r;
    const sel = selectorNorm(opts.selector);
    const buf = fs.readFileSync(r.real);
    const s = seleccionar(buf, sel);
    if (!s.ok) return s;
    const bytes = Buffer.byteLength(s.texto);
    if (bytes > LIMITES.max_deliver_bytes) return falla('SELECT_REQUIRED', 'el contenido excede lo entregable de una vez: acota con line_from/line_to u offset/length', { bytes });
    const hash = sha(Buffer.from(s.texto));
    const canon = require('./memory-core.cjs').canonicalRoot(root);
    const key = sha(canon + '|' + r.relReal + '|' + JSON.stringify(sel));
    const ahora = nowMs(opts);
    const e = cargar(root);
    const ent = (e.lecturas[key] = e.lecturas[key] || { rel: r.relReal, selector: sel, versiones: {}, entregas: {}, last_used: ahora });
    const recip = String(opts.recipient);
    const previa = ent.entregas[recip];
    const base = { ok: true, path: r.relReal, selector: sel, hash, bytes, cache_key: key.slice(0, 16) };
    const guardarVersion = () => {
      if (s.lineas && s.lineas.length <= LIMITES.max_lineas_delta) ent.versiones[hash] = { lineas: s.lineas.map(hash8), at: ahora };
      const hs = Object.entries(ent.versiones).sort((a, b) => b[1].at - a[1].at);
      for (const [h] of hs.slice(LIMITES.max_versiones_por_lectura)) delete ent.versiones[h];
    };
    let res;
    if (!previa) {
      // El receptor nunca lo recibió: se entrega. Nada que ahorrar, nada que ocultar.
      guardarVersion();
      ent.entregas[recip] = { hash, at: ahora };
      e.contadores.new_reads += 1;
      res = { ...base, status: 'NUEVO', content: s.texto };
      anotar(root, opts.task_id, { kind: 'file_read', role: opts.role, sprint_id: opts.sprint_id, original_bytes: bytes, delivered_bytes: bytes, detail: 'lectura nueva ' + r.relReal }, opts);
    } else if (previa.hash === hash) {
      if (opts.necesario || opts.reparacion) {
        // Reparar un bug o verificar exige ver el contenido: se entrega aunque no haya cambiado.
        ent.entregas[recip] = { hash, at: ahora };
        e.contadores.forced_reads += 1;
        res = { ...base, status: 'FORZADO', content: s.texto, motivo: 'lectura necesaria: no se sustituye por una referencia' };
        anotar(root, opts.task_id, { kind: 'file_read', role: opts.role, sprint_id: opts.sprint_id, original_bytes: bytes, delivered_bytes: bytes, detail: 'lectura necesaria ' + r.relReal }, opts);
      } else {
        const ref = { kind: 'ALREADY_DELIVERED', path: r.relReal, selector: sel, hash, bytes, delivered_at: new Date(previa.at).toISOString() };
        const marcador = Buffer.byteLength(JSON.stringify(ref));
        const ahorro = Math.max(0, bytes - marcador);
        e.contadores.reference_hits += 1; e.contadores.saved_bytes += ahorro;
        res = { ...base, status: 'REFERENCIA', content: null, ref, saved_bytes: ahorro };
        anotar(root, opts.task_id, { kind: 'cache_hit', role: opts.role, sprint_id: opts.sprint_id, original_bytes: bytes, delivered_bytes: marcador, detail: 'referencia ' + r.relReal }, opts);
      }
    } else {
      // El hash cambió: JAMÁS referencia. Delta si es corto y la base es conocida; si no, la versión nueva completa.
      e.contadores.invalidations += 1; e.contadores.changed_reads += 1;
      const anterior = ent.versiones[previa.hash];
      let delta = null;
      if (s.lineas && anterior && s.lineas.length <= LIMITES.max_lineas_delta) delta = deltaPorHashes(anterior.lineas, s.lineas, previa.hash, hash);
      guardarVersion();
      ent.entregas[recip] = { hash, at: ahora };
      const deltaBytes = delta ? Buffer.byteLength(JSON.stringify(delta)) : Infinity;
      if (delta && deltaBytes < bytes * LIMITES.delta_max_ratio) {
        res = { ...base, status: 'CAMBIADO', content: null, delta, previous_hash: previa.hash, delta_bytes: deltaBytes, nota: 'aplica el delta a la versión que ya tienes; si no coincide, pide la versión completa' };
        anotar(root, opts.task_id, { kind: 'file_read', role: opts.role, sprint_id: opts.sprint_id, original_bytes: bytes, delivered_bytes: deltaBytes, detail: 'delta ' + r.relReal }, opts);
      } else {
        res = { ...base, status: 'CAMBIADO', content: s.texto, previous_hash: previa.hash, nota: 'versión nueva completa' };
        anotar(root, opts.task_id, { kind: 'file_read', role: opts.role, sprint_id: opts.sprint_id, original_bytes: bytes, delivered_bytes: bytes, detail: 'nueva versión ' + r.relReal }, opts);
      }
      anotar(root, opts.task_id, { kind: 'cache_invalidation', role: opts.role, sprint_id: opts.sprint_id, detail: 'cambió el hash de ' + r.relReal }, opts);
    }
    ent.last_used = ahora;
    acotar(e, ahora);
    guardar(root, e);
    return res;
  } catch (err) {
    return falla('REUSE_FAILED', err && err.message);
  }
}

/** El receptor perdió su contexto (reinicio/compactación): todo lo que se le entregó deja de contar como "ya lo tiene". */
function olvidarReceptor(root, recipient, { prefijo = false } = {}) {
  const e = cargar(root);
  let n = 0;
  for (const ent of Object.values(e.lecturas)) {
    for (const r of Object.keys(ent.entregas)) {
      if (prefijo ? r.startsWith(recipient) : r === recipient) { delete ent.entregas[r]; n++; }
    }
  }
  for (const c of Object.values(e.contextos)) {
    for (const r of Object.keys(c.entregas || {})) if (prefijo ? r.startsWith(recipient) : r === recipient) { delete c.entregas[r]; n++; }
  }
  guardar(root, e);
  return { ok: true, olvidadas: n };
}

// ─── contexto por revisión ───────────────────────────────────────────────────

/**
 * Revisión de la memoria de CONOCIMIENTO (best-effort, solo lectura): cambia al añadir, quitar,
 * cambiar de estado o editar nodos. NO cambia con los contadores de uso ni con el registro de
 * consumo (no se usa la huella del archivo de la base, que se mueve con cualquier escritura).
 */
function revisionMemoria(root) {
  try {
    const core = require('./memory-core.cjs');
    const db = core.abrir(root);
    if (!db) return 'sin-base';
    try {
      if (core.tablasFaltantes(db, ['nodos']).length) return 'sin-nodos';
      const f = db.get("SELECT count(*) AS n, COALESCE(max(id),0) AS mx, COALESCE(sum(length(contenido)),0) AS l, COALESCE(sum(length(titulo)),0) AS t, COALESCE(sum(CASE WHEN estado = 'ACTIVO' THEN 1 ELSE 0 END),0) AS a, COALESCE(max(fecha_update),'') AS fu FROM nodos");
      return sha([f.n, f.mx, f.l, f.t, f.a, f.fu].join('|')).slice(0, 16);
    } finally { db.close(); }
  } catch { return 'ilegible'; }
}

/** Revisión del código que importa a este contexto: hash de contenido de cada archivo (no mtime). */
function revisionCodigo(root, paths) {
  const partes = [];
  for (const p of [...new Set((paths || []).map(normRel))].sort()) {
    let h = 'ausente';
    try { const r = resolverArchivo(root, p); if (r.ok) h = sha(fs.readFileSync(r.real)).slice(0, 16); else if (r.code === 'PRIVATE_NOT_DELIVERED') h = 'privado'; } catch { /* ausente */ }
    partes.push(p + ':' + h);
  }
  return sha(partes.join('\n')).slice(0, 16);
}

/**
 * Contexto de una tarea para un receptor. spec:
 *   task_id, role, recipient (obligatorios), paths[], policy_version, extra (texto que distingue variantes),
 *   memory_revision? (si no, se calcula), build: () => objeto | Promise<objeto>, now
 * Devuelve { status: 'NUEVO'|'REUTILIZADO'|'REFERENCIA'|'NO_CACHEABLE', context | context_ref, invalidado[] }.
 */
async function contexto(root, spec) {
  try {
    if (!spec || !spec.task_id || !spec.role || !spec.recipient || typeof spec.build !== 'function') return falla('SPEC_INVALIDA', 'task_id, role, recipient y build son obligatorios');
    const canon = require('./memory-core.cjs').canonicalRoot(root);
    const rm = spec.memory_revision != null ? String(spec.memory_revision) : revisionMemoria(root);
    const rc = revisionCodigo(root, spec.paths);
    const pv = String(spec.policy_version != null ? spec.policy_version : '-');
    const key = sha([canon, spec.task_id, spec.role, rm, rc, pv, spec.extra || ''].join('|'));
    const ahora = nowMs(spec);
    const e = cargar(root);
    const hit = e.contextos[key];
    const recip = String(spec.recipient);
    if (hit) {
      hit.last_used = ahora;
      const lo_tiene = hit.entregas && hit.entregas[recip] && hit.entregas[recip].body_hash === hit.body_hash;
      if (lo_tiene && !spec.necesario) {
        const ref = { kind: 'CONTEXT_ALREADY_DELIVERED', key: key.slice(0, 16), body_hash: hit.body_hash, bytes: hit.bytes, delivered_at: new Date(hit.entregas[recip].at).toISOString() };
        const marcador = Buffer.byteLength(JSON.stringify(ref));
        e.contadores.context_hits += 1; e.contadores.saved_bytes += Math.max(0, hit.bytes - marcador);
        guardar(root, e);
        anotar(root, spec.task_id, { kind: 'cache_hit', role: spec.role, original_bytes: hit.bytes, delivered_bytes: marcador, detail: 'contexto ya entregado' }, spec);
        return { ok: true, status: 'REFERENCIA', context_ref: ref, saved_bytes: Math.max(0, hit.bytes - marcador) };
      }
      hit.entregas = hit.entregas || {};
      hit.entregas[recip] = { body_hash: hit.body_hash, at: ahora };
      e.contadores.context_hits += 1;
      guardar(root, e);
      anotar(root, spec.task_id, { kind: 'context_pack', role: spec.role, original_bytes: hit.bytes, delivered_bytes: hit.bytes, detail: 'contexto reutilizado' }, spec);
      return { ok: true, status: 'REUTILIZADO', context: hit.body, body_hash: hit.body_hash, bytes: hit.bytes };
    }
    // No hay entrada para ESTA combinación de revisiones: lo anterior de la misma tarea+rol queda invalidado, con su motivo.
    const invalidado = [];
    for (const [k, c] of Object.entries(e.contextos)) {
      if (c.task_id !== spec.task_id || c.role !== spec.role) continue;
      const motivos = [];
      if (c.memory_rev !== rm) motivos.push('memory_revision');
      if (c.code_rev !== rc) motivos.push('code_revision');
      if (c.policy_version !== pv) motivos.push('policy_version');
      if (motivos.length) { invalidado.push({ key: k.slice(0, 16), motivos }); delete e.contextos[k]; }
    }
    if (invalidado.length) { e.contadores.invalidations += invalidado.length; anotar(root, spec.task_id, { kind: 'cache_invalidation', role: spec.role, detail: 'contexto invalidado: ' + invalidado.map((i) => i.motivos.join('+')).join(',') }, spec); }
    const cuerpo = await spec.build();
    const texto = JSON.stringify(cuerpo);
    const bytes = Buffer.byteLength(texto);
    const body_hash = sha(texto);
    e.contadores.context_builds += 1;
    let status = 'NUEVO';
    if (bytes <= LIMITES.max_body_bytes) {
      e.contextos[key] = { task_id: spec.task_id, role: spec.role, memory_rev: rm, code_rev: rc, policy_version: pv, paths: [...new Set((spec.paths || []).map(normRel))], body: cuerpo, body_hash, bytes, created: ahora, last_used: ahora, entregas: { [recip]: { body_hash, at: ahora } } };
    } else status = 'NO_CACHEABLE';
    acotar(e, ahora);
    guardar(root, e);
    anotar(root, spec.task_id, { kind: 'context_pack', role: spec.role, original_bytes: bytes, delivered_bytes: bytes, detail: 'contexto nuevo' }, spec);
    return { ok: true, status, context: cuerpo, body_hash, bytes, invalidado, revisiones: { memory: rm, code: rc, policy: pv } };
  } catch (err) {
    return falla('REUSE_FAILED', err && err.message);
  }
}

/**
 * Un evento externo cambió esos archivos (restauración, checkout, otro agente): se descartan los
 * contextos que los usaban y las lecturas dejan de dar por entregado su contenido anterior.
 */
function invalidarPorCambio(root, { paths = [], reason = 'CODE_CHANGED', task_id } = {}) {
  const e = cargar(root);
  const set = new Set(paths.map((p) => { const x = normRel(p); try { const r = resolverArchivo(root, x); return r.ok ? r.relReal : x; } catch { return x; } }));
  let ctx = 0; let lec = 0;
  for (const [k, c] of Object.entries(e.contextos)) if ((c.paths || []).some((p) => set.has(p))) { delete e.contextos[k]; ctx++; }
  for (const ent of Object.values(e.lecturas)) if (set.has(ent.rel)) { ent.entregas = {}; lec++; }
  e.contadores.invalidations += ctx + lec;
  guardar(root, e);
  if (ctx + lec) anotar(root, task_id, { kind: 'cache_invalidation', detail: reason + ': ' + [...set].slice(0, 5).join(',') });
  return { ok: true, contextos_invalidados: ctx, lecturas_invalidadas: lec, reason };
}

function estadisticas(root) {
  const e = cargar(root);
  return { ok: true, ...e.contadores, lecturas: Object.keys(e.lecturas).length, contextos: Object.keys(e.contextos).length, limits: { ...LIMITES } };
}

function limpiar(root, opts = {}) {
  const e = cargar(root);
  const antes = Object.keys(e.lecturas).length + Object.keys(e.contextos).length;
  acotar(e, nowMs(opts));
  guardar(root, e);
  return { ok: true, eliminadas: antes - (Object.keys(e.lecturas).length + Object.keys(e.contextos).length) };
}

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  const opt = {}; const libres = [];
  for (const a of rest) { const m = /^--([^=]+)(?:=(.*))?$/s.exec(a); if (m) opt[m[1]] = m[2] === undefined ? true : m[2]; else libres.push(a); }
  const out = (x) => console.log(JSON.stringify(x, null, 2));
  if (cmd === 'stats') out(estadisticas(process.cwd()));
  else if (cmd === 'limpiar') out(limpiar(process.cwd()));
  else if (cmd === 'leer') out(leer(process.cwd(), libres[0], { recipient: opt.recipient, task_id: opt.task, role: opt.rol, necesario: !!opt.necesario, selector: opt.desde ? { line_from: Number(opt.desde), line_to: Number(opt.hasta) } : undefined }));
  else console.log('Uso: node context-reuse.cjs stats | limpiar | leer <ruta> --recipient=T-1:builder:ses [--task= --rol= --necesario --desde=N --hasta=M]');
}

module.exports = {
  LIMITES, leer, olvidarReceptor, contexto, invalidarPorCambio, estadisticas, limpiar,
  revisionMemoria, revisionCodigo, calcularDelta, aplicarDelta, resolverArchivo,
};
