'use strict';

/**
 * Incorporación del constructor y arranque de la campaña (spec §4).
 *
 *   conectar-builder   El constructor (Cursor) registra su session_id, confirma proyecto, protocolo y capacidades, y —cuando ya
 *                      activó sus dos vigilantes— responde READY. Es una incorporación SEPARADA de `teams: activar`: no cambia
 *                      session_generation ni reactiva TEAMS. Un registro por CLI no demuestra que el agente esté vivo: solo deja
 *                      constancia de lo que declara; lo que se pueda comprobar (canal, ACK) se comprueba aparte.
 *   ejecutar           Valida primer lote + incorporación + vigilancia + verificador y recién entonces corre el scheduler con el
 *                      verificador REAL. Repetirlo reconoce la ejecución existente: no duplica nada. El controlador "persistente"
 *                      es la secuencia de pases (run) que dispara el loop del host; este módulo no finge ser un agente.
 */

const path = require('path');
const tm = require('./teams-manager.cjs');
const U = require('./teams-util.cjs');

const I = tm._i;
const PROTOCOLOS = ['v2', '2'];

/** Modo de vigilancia que el constructor DECLARA (no se verifica desde aquí): es lo que decide si se puede hablar de autonomía. */
function modoVigilancia(w) {
  if (!w || (w.loop == null && w.watch == null)) return { modo: 'NO_DECLARADO', autonomia: 'DESCONOCIDA' };
  const loop = w.loop === true;
  const watch = w.watch === true;
  if (loop && watch) return { modo: 'DOBLE', autonomia: 'LOOP_Y_WATCH_DECLARADOS', nota: 'declarado por el constructor; el despertar real se prueba aparte (EVENT_WAKE no verificado por este registro)' };
  if (loop) return { modo: 'SOLO_LOOP', autonomia: 'EVENT_WAKE_UNSUPPORTED', nota: 'sin watch: la latencia es el intervalo del loop' };
  if (watch) return { modo: 'SOLO_WATCH', autonomia: 'SIN_RESPALDO_DE_LOOP', nota: 'sin loop de respaldo: si el watch falla en silencio nadie despierta al constructor' };
  return { modo: 'MANUAL_ONLY', autonomia: 'MANUAL_ONLY', nota: 'sin loop ni watch: el constructor solo actúa cuando una persona lo invoca; no se anuncia autonomía' };
}

const mismaRuta = (a, b) => {
  const n = (p) => path.resolve(String(p)).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};

const bool = (v) => (v === true || /^(si|sí|true|1|yes)$/i.test(String(v)) ? true : (v === false || /^(no|false|0)$/i.test(String(v)) ? false : null));

function fila(b) {
  if (!b) return null;
  const w = I.pj(b.watchers, null);
  return { session_id: b.session_id, host: b.host, model: b.model, state: b.state, capabilities: I.pj(b.capabilities, {}), watchers: w, vigilancia: modoVigilancia(w),
    project: b.project, protocol: b.protocol, connected_at: b.connected_at, ready_at: b.ready_at, prev_session_id: b.prev_session_id };
}

/**
 * Registra (o actualiza) al constructor. `proyecto` debe ser la raíz de ESTE proyecto: dos proyectos con el mismo nombre no mezclan
 * sesiones ni despiertan al chat equivocado. `listo: true` además responde el READY de arranque (con sus vigilantes declarados).
 */
function conectar(root, { session_id, host = 'cursor', model = null, proyecto = null, protocolo = 'v2', loop = null, watch = null, capacidades = {}, listo = false }) {
  if (!session_id || !/^[\w.:-]{4,80}$/.test(String(session_id))) return { status: 'SESSION_ID_INVALIDO', detalle: 'el constructor aporta el identificador real de su sesión (4-80 caracteres)' };
  if (!proyecto) return { status: 'FALTA_PROYECTO', detalle: 'confirma la ruta absoluta del proyecto en el que trabajas (--proyecto)' };
  if (!mismaRuta(proyecto, root)) return { status: 'PROYECTO_DISTINTO', esperado: path.resolve(root), recibido: String(proyecto).slice(0, 200), detalle: 'esta sesión apunta a otro proyecto: no se mezcla' };
  if (!PROTOCOLOS.includes(String(protocolo).toLowerCase())) return { status: 'PROTOCOLO_NO_SOPORTADO', soportados: ['v2'] };
  const w = { loop: bool(loop), watch: bool(watch) };
  const caps = Object.fromEntries(Object.entries(capacidades || {}).slice(0, 20).map(([k, v]) => [String(k).slice(0, 40), typeof v === 'boolean' ? v : U.limpiar(root, v, 80)]));
  const r = I.tx2(root, (db, despertar) => {
    const s = I.sesion(db);
    if (!s || !s.enabled) return { status: 'DESACTIVADO', detalle: 'TEAMS no está activo (teams: activar)' };
    const previo = db.get('SELECT * FROM teams_builder WHERE id = 1');
    const misma = previo && previo.session_id === session_id;
    const estado = listo ? 'READY' : (misma && previo.state === 'READY' ? 'READY' : 'CONECTADO');
    const ahora = I.ahoraIso();
    /* Si esta llamada no declara vigilantes y es la misma sesión, se conserva lo que ya había declarado. */
    const wJson = (w.loop == null && w.watch == null) ? (misma ? previo.watchers : null) : I.js(w);
    db.run(`INSERT INTO teams_builder (id, session_id, host, model, state, capabilities, watchers, project, protocol, connected_at, ready_at, updated_at, prev_session_id)
      VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET session_id = excluded.session_id, host = excluded.host, model = excluded.model, state = excluded.state, capabilities = excluded.capabilities,
      watchers = excluded.watchers, project = excluded.project, protocol = excluded.protocol, connected_at = excluded.connected_at, ready_at = excluded.ready_at,
      updated_at = excluded.updated_at, prev_session_id = excluded.prev_session_id`,
    session_id, String(host).slice(0, 40), model ? String(model).slice(0, 80) : null, estado, I.js(caps), wJson,
    path.resolve(root), 'v2', misma ? previo.connected_at : ahora, listo ? ahora : (misma ? previo.ready_at : null), ahora, misma ? previo.prev_session_id : (previo ? previo.session_id : null));
    I.publicar(db, despertar, { kind: listo ? 'BUILDER_READY' : 'BUILDER_CONNECTED', producer: 'builder', target: 'director', payload: { session_id, host: String(host).slice(0, 40), vigilancia: modoVigilancia(w).modo, reconectado: !!(previo && !misma) } });
    return { status: listo ? 'BUILDER_READY' : 'BUILDER_CONECTADO', session_id, state: estado, reconectado: !!(previo && !misma), vigilancia: modoVigilancia(w), session_generation: s.session_generation };
  });
  /* Misma carpeta, mismo canal: la sesión también queda registrada para el transporte por MD (solo su propio archivo). */
  if (r.session_id) { try { require('./teams-md-session.cjs').registrar(root, { rol: 'builder', host, session_id }); } catch { /* el registro en la base es la fuente de verdad */ } }
  return r;
}

/** READY de arranque (o actualización de vigilantes) de la sesión ya conectada. */
function listo(root, { session_id, loop = null, watch = null }) {
  return I.tx2(root, (db, despertar) => {
    const b = db.get('SELECT * FROM teams_builder WHERE id = 1');
    if (!b) return { status: 'BUILDER_NO_CONECTADO', comando: 'akdd teams conectar-builder' };
    if (b.session_id !== session_id) return { status: 'SESION_NO_REGISTRADA', detalle: 'no es la sesión del constructor conectado' };
    const w = { loop: bool(loop), watch: bool(watch) };
    db.run("UPDATE teams_builder SET state = 'READY', watchers = ?, ready_at = ?, updated_at = ? WHERE id = 1", I.js(w), I.ahoraIso(), I.ahoraIso());
    I.publicar(db, despertar, { kind: 'BUILDER_READY', producer: 'builder', target: 'director', payload: { session_id, vigilancia: modoVigilancia(w).modo } });
    return { status: 'BUILDER_READY', session_id, vigilancia: modoVigilancia(w) };
  });
}

function estadoBuilder(db) {
  if (!I.tieneEsquemaV2(db)) return null;
  return fila(db.get('SELECT * FROM teams_builder WHERE id = 1'));
}

/** Lo que `ejecutar` comprueba antes de arrancar. `faltan` bloquea; `advertencias` solo se declara. */
function validarArranque(root) {
  return I.lectura2(root, (db) => {
    if (!db) return { ok: false, faltan: [{ code: 'MIGRACION_PENDIENTE' }], advertencias: [], validaciones: {} };
    const faltan = [];
    const advertencias = [];
    const s = I.sesion(db);
    if (!s || !s.enabled) faltan.push({ code: 'DESACTIVADO' });
    else if (s.paused) faltan.push({ code: 'PAUSADO' });
    const tareas = I.tareas(db);
    const primerLote = tareas.filter((t) => t.state === 'READY').map((t) => t.id);
    const enMarcha = tareas.some((t) => ['RUNNING', 'VERIFYING', 'DONE_VERIFIED'].includes(t.state));
    if (!tareas.length) faltan.push({ code: 'SIN_PLAN', detalle: 'teams: plan <objetivo> primero' });
    else if (!primerLote.length && !enMarcha) faltan.push({ code: 'SIN_PRIMER_LOTE', detalle: 'ninguna tarea está lista: el primer lote debe existir ANTES de arrancar al constructor' });
    const b = estadoBuilder(db);
    if (!b) faltan.push({ code: 'BUILDER_NO_CONECTADO', comando: 'akdd teams conectar-builder --sesion=<id> --proyecto=<ruta> --listo' });
    else if (b.state !== 'READY') faltan.push({ code: 'BUILDER_NO_LISTO', comando: 'akdd teams builder-listo --sesion=' + b.session_id });
    const vig = b ? b.vigilancia : { modo: 'NO_DECLARADO', autonomia: 'DESCONOCIDA' };
    if (['MANUAL_ONLY', 'NO_DECLARADO', 'SOLO_LOOP', 'SOLO_WATCH'].includes(vig.modo)) advertencias.push({ code: 'VIGILANCIA_' + vig.modo, detalle: vig.nota || 'vigilancia no declarada' });
    const R = require('./teams-revision.cjs');
    const regs = R.revisores(db);
    for (const r of R.ROLES) if (!regs[r]) advertencias.push({ code: 'REVISOR_NO_REGISTRADO', role: r });
    let verificador = 'REAL';
    try { require('./teams-verificador.cjs'); } catch { verificador = 'AUSENTE'; faltan.push({ code: 'SIN_VERIFICADOR' }); }
    return { ok: !faltan.length, faltan, advertencias, validaciones: { primer_lote: primerLote, builder: b ? b.state : 'AUSENTE', vigilancia: vig, verificador, revisores: Object.fromEntries(R.ROLES.map((r) => [r, regs[r] ? regs[r].modality : 'FALTA'])) } };
  });
}

/**
 * `teams: ejecutar`. Con todo validado corre UN pase del scheduler con el verificador real y lo registra en la campaña; repetirlo
 * devuelve la misma ejecución (run_id) sin duplicar supervisores ni revisores. El loop del host vuelve a invocarlo en cada despertar.
 */
function ejecutar(root, { adapters = null, verificador = null } = {}) {
  const v = validarArranque(root);
  if (!v.ok) return { status: 'NO_LISTO', faltan: v.faltan, advertencias: v.advertencias, validaciones: v.validaciones };
  const ad = require('./teams-adapters.cjs');
  const builder = adapters || ad.adaptersDe(root).builder;
  const ver = verificador || require('./teams-verificador.cjs').verificadorReal(root);
  const registro = I.tx2(root, (db) => {
    const c = db.get('SELECT * FROM teams_campaign WHERE id = 1');
    if (c) return { run_id: c.run_id, ya_en_ejecucion: true };
    const run_id = 'R-' + require('crypto').randomUUID().slice(0, 8);
    db.run('INSERT INTO teams_campaign (id, run_id, started_at, ticks, mode) VALUES (1,?,?,0,?)', run_id, I.ahoraIso(), v.validaciones.vigilancia.modo);
    return { run_id, ya_en_ejecucion: false };
  });
  const pasos = ad.tick(root, { builder, verificador: ver });
  I.tx2(root, (db) => { db.run('UPDATE teams_campaign SET ticks = ticks + 1, last_tick_at = ?, mode = ? WHERE id = 1', I.ahoraIso(), v.validaciones.vigilancia.modo); });
  // Lo encolado por los cierres se registra ahora (acotado): un fallo queda MEMORY_PENDING/dead-letter y NO detiene tareas independientes.
  let memoria = null; try { memoria = require('./teams-puente.cjs').procesar(root, { max: 5 }); } catch { /* auxiliar */ }
  return { status: 'EJECUTANDO', memoria: memoria && { listo_para_cierre: memoria.listo_para_cierre, reflejados: memoria.reflejados && memoria.reflejados.length }, run_id: registro.run_id, ya_en_ejecucion: registro.ya_en_ejecucion, modo: v.validaciones.vigilancia, verificador: 'REAL', capabilities: builder.capabilities(), advertencias: v.advertencias, pasos };
}

module.exports = { modoVigilancia, conectar, listo, estadoBuilder, validarArranque, ejecutar };

// ─── CLI: akdd teams conectar-builder | builder-listo ────────────────────────
if (require.main === module) {
  const { opt, pos } = U.parseArgs(process.argv.slice(2));
  const root = process.cwd();
  let r;
  try {
    if (pos[0] === 'listo') r = listo(root, { session_id: opt.sesion, loop: opt.loop, watch: opt.watch });
    else if (pos[0] === 'validar') r = validarArranque(root);
    else r = conectar(root, { session_id: opt.sesion, host: opt.host || 'cursor', model: opt.modelo || null, proyecto: opt.proyecto, protocolo: opt.protocolo || 'v2', loop: opt.loop, watch: opt.watch, listo: !!opt.listo });
  } catch (e) { r = { status: e.code || 'ERROR', detalle: e.message }; }
  if (pos[0] !== 'validar') require('./teams-canal.cjs').refrescar(root);
  console.log(JSON.stringify(r, null, 2));
  if (r && /INVALIDO|FALTA|DISTINTO|NO_SOPORTADO|ERROR|DESACTIVADO|NO_CONECTADO|NO_REGISTRADA|MIGRACION_PENDIENTE/.test(String(r.status || ''))) process.exitCode = 1;
}
