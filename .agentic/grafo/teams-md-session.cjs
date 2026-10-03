'use strict';

/**
 * Canal MD entre sesiones ya abiertas (C01). El director (Claude Code) y el
 * constructor (Cursor) trabajan en la misma carpeta; ninguna API inyecta
 * mensajes en el chat del IDE, pero las dos sesiones leen archivos y corren
 * node. Este canal aprovecha eso sin pedirle a la persona que pegue nada:
 *
 *   director → sesión   `.legion/AUDITORIA-CURSOR.md`, un solo escritor
 *                       (teams-manager.regenerarVistas) con envoltorios por rol
 *   sesión → director   `.legion/cola-<rol>.jsonl`, de solo agregar, una
 *                       línea por mensaje (ACK, RESULT, VISTO) con event_id
 *   registro           `.legion/sesiones/<rol>.json`, cada sesión el suyo
 *
 * El director consume la cola de forma idempotente: repetirla entera no
 * duplica transiciones (ACK y RESULT se deduplican en la base por entrega y
 * event_id). AVAILABLE exige las dos sesiones vivas y un ida y vuelta real
 * verificado (tarea → ACK → resultado → verificación del director). Un archivo
 * escrito o un binario detectado no es ACK. El host no se despierta desde
 * fuera: la sesión consume la señal en su siguiente pase, y eso se declara.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tm = require('./teams-manager.cjs');

const VIGENCIA_SESION_MS = 10 * 60 * 1000;
const ROLES = ['director', 'builder'];
const BLOQUE = /<<<AKDD-TEAMS v1\r?\n([\s\S]*?)\r?\nAKDD-TEAMS>>>/g;

const dirLegion = (root) => path.join(root, '.legion');
const archivoSesion = (root, rol) => path.join(dirLegion(root), 'sesiones', rol + '.json');
const archivoCola = (root, rol) => path.join(dirLegion(root), 'cola-' + rol + '.jsonl');
const archivoEstado = (root) => path.join(dirLegion(root), '_md-session', 'estado.json');
const leerJson = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } };

function escribirAtomico(f, contenido) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, contenido);
  fs.renameSync(tmp, f);
}

function leerCola(root, rol) {
  let txt = '';
  try { txt = fs.readFileSync(archivoCola(root, rol), 'utf8'); } catch { return []; }
  return txt.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/* ─── lado de la sesión (lo corre Cursor o Claude Code en su propio turno) ── */

/** La sesión se anuncia. Solo escribe su propio archivo. */
function registrar(root, { rol, host, session_id }) {
  if (!ROLES.includes(rol)) return { status: 'ROL_DESCONOCIDO', rol };
  const id = session_id || ('ses-' + crypto.randomUUID().slice(0, 8));
  const previo = leerJson(archivoSesion(root, rol), null);
  const ahora = new Date().toISOString();
  escribirAtomico(archivoSesion(root, rol), JSON.stringify({ rol, host: host || null, session_id: id, registrada_at: previo && previo.session_id === id ? previo.registrada_at : ahora, latido_at: ahora }, null, 2));
  return { status: 'OK', session_id: id };
}

function latido(root, { rol, session_id }) {
  const s = leerJson(archivoSesion(root, rol), null);
  if (!s || s.session_id !== session_id) return { status: 'SESION_DESCONOCIDA' };
  s.latido_at = new Date().toISOString();
  escribirAtomico(archivoSesion(root, rol), JSON.stringify(s, null, 2));
  return { status: 'OK' };
}

function encolar(root, rol, msg) {
  const f = archivoCola(root, rol);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const linea = Object.assign({ event_id: msg.event_id || ('ev-' + crypto.randomUUID()), at: new Date().toISOString() }, msg);
  fs.appendFileSync(f, JSON.stringify(linea) + '\n');
  return linea;
}

/** Lo que el canal tiene para este rol, sin lo que esta sesión ya confirmó. */
function leerCanal(root, { rol }) {
  let txt = '';
  try { txt = fs.readFileSync(path.join(dirLegion(root), 'AUDITORIA-CURSOR.md'), 'utf8'); } catch { return { status: 'SIN_CANAL', eventos: [] }; }
  const propios = leerCola(root, rol);
  const ackeadas = new Set(propios.filter((m) => m.kind === 'ACK').map((m) => m.delivery_id));
  const visto = Math.max(0, ...propios.filter((m) => m.kind === 'VISTO').map((m) => Number(m.hasta_seq) || 0));
  const eventos = [];
  for (const m of txt.matchAll(BLOQUE)) {
    let e;
    try { e = JSON.parse(m[1]); } catch { continue; }
    if (e.kind !== 'EVENT' || e.rol !== rol || e.seq <= visto) continue;
    if (e.event_kind === 'TASK_ASSIGNED' && ackeadas.has(e.payload && e.payload.delivery_id)) continue;
    eventos.push(e);
  }
  return { status: 'OK', eventos };
}

/** La sesión acepta una tarea: queda escrito en su cola, no en el canal del director. */
function ackear(root, { rol = 'builder', session_id, owner_id, delivery_id, packet_revision, packet_hash, packet_state_hash }) {
  /* H02: el mismo ACK puede confirmar el paquete de contexto, identificando REVISIÓN y HASH recibidos. */
  const paquete = packet_revision != null && packet_revision !== true ? { packet_revision: Number(packet_revision), packet_hash, packet_state_hash } : {};
  return encolar(root, rol, { kind: 'ACK', delivery_id, owner_id, host_session_id: session_id, event_id: 'ack-' + delivery_id, ...paquete });
}

function entregar(root, { rol = 'builder', resultado }) {
  return encolar(root, rol, Object.assign({ kind: 'RESULT' }, resultado, { event_id: resultado.event_id || ('res-' + resultado.task_id + '-' + resultado.fencing) }));
}

/** La sesión confirma que leyó hasta `seq`: es su aceptación duradera para la vigilancia. */
function visto(root, { rol, hasta_seq }) {
  return encolar(root, rol, { kind: 'VISTO', hasta_seq: Number(hasta_seq), event_id: 'visto-' + rol + '-' + hasta_seq });
}

/**
 * Tras compactar el chat: la foto de continuidad, lo nuevo y lo que esta
 * sesión ya tiene en curso. Una tarea aceptada no se vuelve a ofrecer.
 */
function retomar(root, { rol, session_id }) {
  let continuidad = '';
  try { continuidad = fs.readFileSync(path.join(dirLegion(root), 'CONTINUIDAD.md'), 'utf8'); } catch { /* sin vista */ }
  const propios = leerCola(root, rol);
  const enCurso = propios.filter((m) => m.kind === 'ACK' && m.host_session_id === session_id).map((m) => m.delivery_id)
    .filter((d) => !propios.some((r) => r.kind === 'RESULT' && r.delivery_id === d));
  return { continuidad, nuevos: leerCanal(root, { rol }).eventos, en_curso: enCurso };
}

/* ─── lado del director ───────────────────────────────────────────────────── */

function estadoCanal(root) { return leerJson(archivoEstado(root), { consumidos: {}, roundtrip: null, acks: {} }); }
function guardarEstado(root, e) { escribirAtomico(archivoEstado(root), JSON.stringify(e, null, 2)); }

function sesiones(root, ahora = Date.now()) {
  const out = {};
  for (const rol of ROLES) {
    const s = leerJson(archivoSesion(root, rol), null);
    out[rol] = s ? Object.assign({}, s, { viva: ahora - Date.parse(s.latido_at) <= VIGENCIA_SESION_MS }) : null;
  }
  return out;
}

class AdapterMdSesion {
  constructor(root, { rol = 'builder', owner_id } = {}) {
    Object.assign(this, { root, rol, owner_id: owner_id || rol + '-md-session' });
  }

  capabilities() {
    const s = sesiones(this.root);
    const faltan = ROLES.filter((r) => !s[r] || !s[r].viva);
    const latencia = 'la sesión consume la señal en su siguiente pase: no se despierta sola desde fuera';
    if (faltan.length) {
      return {
        host: 'md-session', status: 'DEGRADED', transport: 'MD_SESSION', version: '1', latencia,
        motivo: 'SESION_AUSENTE', faltan,
        accion: faltan.map((r) => `en la sesión del ${r === 'builder' ? 'constructor' : 'director'} corre una vez: node .agentic/grafo/teams-md-session.cjs registrar --rol=${r} --host=<cursor|claude-code>`),
      };
    }
    const rt = estadoCanal(this.root).roundtrip;
    if (!rt || rt.session_id !== s.builder.session_id) {
      return { host: 'md-session', status: 'DEGRADED', transport: 'MD_SESSION', version: '1', latencia, motivo: 'HANDSHAKE_SIN_IDA_Y_VUELTA', accion: ['completar una tarea real: asignación → ACK de la sesión → resultado → verificación del director'] };
    }
    return { host: 'md-session', status: 'AVAILABLE', transport: 'MD_SESSION', version: '1', latencia, verificado: rt };
  }

  /** Publica la asignación en el canal (único escritor). El ACK llega después por la cola de la sesión. */
  submitTask(asg) {
    tm.regenerarVistas(this.root);
    return { delivery_id: asg.delivery_id, host_session_id: null, accepted: false, ack_at: null, motivo: 'ESPERA_ACK_DE_LA_SESION' };
  }

  /** Lee la cola de la sesión: los ACK se aplican aquí; los resultados vuelven al scheduler. */
  readProgress() {
    const e = estadoCanal(this.root);
    const vistos = new Set(e.consumidos[this.rol] || []);
    const resultados = [];
    for (const m of leerCola(this.root, this.rol)) {
      if (vistos.has(m.event_id)) continue;
      if (m.kind === 'ACK') {
        const a = tm.ack(this.root, { delivery_id: m.delivery_id, owner_id: m.owner_id || this.owner_id, host_session_id: m.host_session_id });
        if (a.status === 'ACKED') e.acks[m.delivery_id] = { session_id: m.host_session_id, task_id: a.task_id || null };
        /* ACK del paquete de contexto (si la sesión lo trae): extiende el ACK de la entrega, no lo reemplaza. */
        if (m.packet_revision != null && a.status === 'ACKED' && a.task_id) {
          try { require('./teams-packets.cjs').ack(this.root, { task_id: a.task_id, recipient_role: this.rol, revision: m.packet_revision, hash: m.packet_hash, state_hash: m.packet_state_hash }); } catch { /* auxiliar */ }
        }
      } else if (m.kind === 'RESULT') {
        resultados.push(Object.assign({}, m, { owner_id: m.owner_id || this.owner_id }));
      }
      vistos.add(m.event_id);
    }
    e.consumidos[this.rol] = [...vistos];
    guardarEstado(this.root, e);
    return resultados;
  }

  /** Lo llama el scheduler tras verificar: un DONE_VERIFIED de una tarea aceptada por la sesión prueba el ida y vuelta. */
  alVerificar(res, v) {
    if (!v || v.status !== 'DONE_VERIFIED') return;
    const e = estadoCanal(this.root);
    const ack = Object.entries(e.acks).find(([, a]) => a.task_id === res.task_id);
    if (!ack) return;
    e.roundtrip = { task_id: res.task_id, delivery_id: ack[0], session_id: ack[1].session_id, at: new Date().toISOString() };
    guardarEstado(this.root, e);
  }

  /** Para la vigilancia (C02): acepta solo hasta lo que la sesión confirmó haber leído. */
  entregarEventos(eventos) {
    tm.regenerarVistas(this.root);
    const hasta = Math.max(0, ...leerCola(this.root, this.rol).filter((m) => m.kind === 'VISTO').map((m) => Number(m.hasta_seq) || 0));
    const aceptados = eventos.filter((ev) => ev.seq <= hasta);
    if (!aceptados.length) return { aceptado: false, motivo: 'SESION_AUN_NO_LEYO' };
    return { aceptado: true, hasta_seq: aceptados[aceptados.length - 1].seq };
  }

  cancelOwnedTask() { return { status: 'MANUAL', nota: 'la cancelación llega a la sesión por el canal' }; }
  resume() { return { status: 'OK' }; }
  health() { const c = this.capabilities(); return { status: c.status, transport: c.transport, motivo: c.motivo || null }; }
}

/* ─── ayudantes sin JSON (v2): reportar y ronda ───────────────────────────── */

const U = require('./teams-util.cjs');

/**
 * Reporte del constructor sin armar JSON: entrega de una tarea, de una corrección o una nota. Todo lo que dice es DATO: se
 * redacta y se acota, y el director lo verifica con sus propios gates; el reporte no cierra nada.
 *
 *   entrega     { tarea, archivos?, comprobaciones? ("tests=PASS,build=PASS"), sesion? }
 *               owner y fencing los toma del lease vigente de la tarea; si hay un constructor conectado, la sesión debe ser la suya.
 *   correccion  { id, archivos?, nota?, dueno?, fencing?, sesion? }
 *   nota        { texto }
 */
function reportar(root, o = {}) {
  const tipo = String(o.tipo || '').toLowerCase();
  const I = tm._i;
  const sesionOk = () => I.lectura2(root, (db) => {
    const b = db && db.get('SELECT session_id FROM teams_builder WHERE id = 1');
    if (!b || !b.session_id) return null;
    return o.sesion && o.sesion === b.session_id ? null : { status: 'SESION_NO_REGISTRADA', detalle: 'la sesión no es el constructor conectado (conectar-builder)' };
  });
  if (tipo === 'entrega') {
    const t = tm.leerTarea(root, o.tarea);
    if (!t) return { status: 'TAREA_DESCONOCIDA', tarea: o.tarea };
    const mala = sesionOk();
    if (mala) return mala;
    if (t.state !== 'RUNNING') return { status: 'TRANSICION_INVALIDA', estado: t.state, detalle: 'solo se reporta una tarea en curso (RUNNING)' };
    const act = tm.actividadConstructor(root).find((x) => x.task_id === t.id);
    const archivos = U.lista(o.archivos).map(U.normRel);
    const permitidos = new Set(t.allowed_files.map(tm.normalizarRecurso));
    const fuera = archivos.filter((f) => !permitidos.has(tm.normalizarRecurso(f)));
    if (fuera.length) return { status: 'FUERA_DE_ALCANCE', fuera, detalle: 'tocaste archivos fuera del alcance de la tarea: no se reporta como entrega' };
    const files = archivos.length ? archivos : t.allowed_files;
    const evidence = U.lista(o.comprobaciones);
    const hash = U.hashArchivos(root, files);
    const event_id = 'res-' + t.id + '-' + (act ? act.fencing : 0) + '-' + hash.slice(0, 8);
    entregar(root, { rol: 'builder', resultado: { task_id: t.id, event_id, owner_id: t.owner_id, fencing: act ? act.fencing : null, expected_revision: t.revision, subject_hash: hash, files, evidence } });
    /* El aviso por la base despierta al director (vigilantes): la cola es transporte, el evento es la señal. */
    I.tx(root, (db, desp) => { I.publicar(db, desp, { kind: 'BUILDER_REPORT', producer: 'builder', target: 'director', task_id: t.id, payload: { tipo: 'entrega', event_id } }); });
    return { status: 'REPORTADO', tipo: 'entrega', event_id, subject_hash: hash, archivos: files, comprobaciones: evidence.length };
  }
  if (tipo === 'correccion') {
    const mala = sesionOk();
    if (mala) return mala;
    return require('./teams-correcciones.cjs').entregar(root, { id: o.id, owner_id: o.dueno, fencing: o.fencing != null ? o.fencing : null, session_id: o.sesion || null, files: o.archivos, nota: o.nota, event_id: o.evento || null, actor: 'builder' });
  }
  if (tipo === 'nota') {
    const texto = U.limpiar(root, o.texto || '', 300);
    if (!texto) return { status: 'SIN_TEXTO' };
    I.tx(root, (db, desp) => { I.publicar(db, desp, { kind: 'BUILDER_NOTE', producer: 'builder', target: 'director', payload: { texto } }); });
    return { status: 'REPORTADO', tipo: 'nota' };
  }
  return { status: 'TIPO_DESCONOCIDO', validos: ['entrega', 'correccion', 'nota'] };
}

/**
 * Lo que un rol hace en CADA despertar, en una sola llamada: correcciones primero, luego la ejecución pendiente; sin trabajo no
 * inventa nada (accion ESPERAR). Es una lectura: no cambia estado. La cola de eventos del canal se atiende con `visto` aparte.
 */
function ronda(root, { rol = 'builder', owner_id = null } = {}) {
  const e = tm.estado(root);
  if (!e.inicializado) return { status: 'SIN_TEAMS', accion: 'ESPERAR' };
  if (!e.enabled) return { status: 'DESACTIVADO', accion: 'ESPERAR', detalle: 'TEAMS está desactivado: un MD viejo no lo reactiva' };
  const base = { status: 'OK', rol, revision_canal: e.ultimo_seq, campana: e.campana ? e.campana.estado : null, pausa: e.paused };
  if (!e.v2) return Object.assign(base, { accion: 'MIGRACION_PENDIENTE', comando: 'akdd teams init --aprobar-migracion' });
  const corr = require('./teams-correcciones.cjs');
  const cierre = e.cierre && e.cierre.state === 'REQUESTED' ? { close_id: e.cierre.close_id, revision: e.cierre.revision, final_status: e.cierre.final_status } : null;
  if (rol === 'builder') {
    const compacta = (f) => ({ id: f.id, severity: f.severity, state: f.state, task_id: f.task_id, ubicacion: f.location, criterio: f.criterion, solucion: f.proposal, aceptacion: f.acceptance, revision: f.revision, prioridad: Math.round(f.prioridad) });
    const lista = corr.listar(root, { activas: true }).filter((f) => ['IN_PROGRESS', 'REOPENED', 'ASSIGNED'].includes(f.state)).map(compacta);
    const enCurso = e.tareas.find((t) => t.state === 'RUNNING' && (!owner_id || t.owner_id === owner_id)) || null;
    const susp = corr.suspendidas(root);
    const nuevos = leerCanal(root, { rol: 'builder' }).eventos.filter((x) => x.event_kind === 'TASK_ASSIGNED');
    let accion = 'ESPERAR';
    if (cierre) accion = 'CIERRE_ACK';
    else if (lista.length) accion = 'CORRECCION';
    else if (susp.length) accion = 'REANUDAR';
    else if (enCurso) accion = 'CONTINUAR_TAREA';
    else if (nuevos.length) accion = 'TAREA_NUEVA';
    return Object.assign(base, { accion, correcciones: lista, tarea_en_curso: enCurso && { id: enCurso.id, fase: enCurso.fase || null }, suspendidas: susp, asignaciones_nuevas: nuevos.map((x) => x.task_id), cierre,
      nota: accion === 'ESPERAR' ? 'sin trabajo: no inventes tareas ni gastes turnos de modelo; la próxima señal o el loop te despiertan' : null });
  }
  const verificar = e.tareas.filter((t) => t.state === 'VERIFYING').map((t) => t.id);
  const implementadas = corr.listar(root, { estado: 'IMPLEMENTED_PENDING_REVIEW' }).map((f) => ({ id: f.id, origen: f.origin, resolved_hash: f.resolved_hash }));
  const porTriar = corr.listar(root, { estado: 'OPEN' }).filter((f) => f.actionable).map((f) => f.id);
  const rev = require('./teams-revision.cjs').pendientes(root);
  let accion = 'ESPERAR';
  if (porTriar.length) accion = 'TRIAR_HALLAZGOS';
  else if (implementadas.length) accion = 'VERIFICAR_CORRECCIONES';
  else if (verificar.length) accion = 'VERIFICAR_ENTREGAS';
  else if (e.campana && e.campana.estado === 'WAITING_FINAL_AUDIT') accion = 'REVISION_FINAL_O_CIERRE';
  else if (rev.disponible && rev.pendientes.some((x) => x.aplica)) accion = 'ESPERAR_REVISORES';
  return Object.assign(base, { accion, entregas_por_verificar: verificar, correcciones_por_verificar: implementadas, hallazgos_por_triar: porTriar,
    revisiones_pendientes: rev.disponible ? rev.pendientes.length : null, cierre, avance: e.avance ? e.avance.porcentaje : null });
}

/**
 * Activación inicial: prepara archivos y explica qué falta. No migra la base:
 * eso es `teams: activar` con aprobación explícita, y se muestra aparte.
 */
function preparar(root, { mecanica = 'INVERTIDA' } = {}) {
  const e = tm.estado(root);
  const roles = mecanica === 'INVERTIDA' ? { director: 'claude-code', builder: 'cursor' } : { director: 'cursor', builder: 'claude-code' };
  const instr = `# Roles TEAMS por canal MD (${mecanica})\n\n`
    + `- Director: ${roles.director}. Constructor: ${roles.builder}.\n`
    + '- Constructor, en cada pase: `node .agentic/grafo/teams-md-session.cjs canal --rol=builder` → aceptar con `ack` → implementar → `resultado` → `visto`.\n'
    + '- Director: `akdd teams run` consume la cola del constructor y verifica.\n'
    + '- Tras compactar el chat: `node .agentic/grafo/teams-md-session.cjs retomar --rol=<rol> --session=<id>`.\n'
    + '- Esquema v2: constructor, en cada despertar: `node .agentic/grafo/teams-md-session.cjs ronda --rol=builder` (correcciones PRIMERO; sin trabajo = ESPERAR, no inventes tareas). '
    + 'Corrección: `akdd teams correcciones tomar --sesion=<id> --siguiente-paso="..."` → editar → `correcciones entregar --sesion=<id> --fencing=N --archivos=a,b` → `correcciones reanudar`. '
    + 'Entrega de tarea: `teams-md-session.cjs reportar entrega --tarea=ID --archivos=a,b --comprobaciones=tests=PASS --sesion=<id>`. Cierre: `akdd teams cerrar-ack --close=ID --revision=N --sesion=<id> --vigilantes=apagados`.\n'
    + '- Director: `teams-md-session.cjs ronda --rol=director` dice qué atender (triar hallazgos, verificar correcciones, esperar revisores, cierre). Los revisores informan con `akdd teams revision informar`; solo el director publica correcciones.\n'
    + '- El canal no despierta a nadie: cada sesión lo lee en su siguiente pase.\n';
  escribirAtomico(path.join(dirLegion(root), 'ROLES-MD.md'), instr);
  const primerLote = e.inicializado ? e.tareas.filter((t) => t.state === 'READY').map((t) => t.id) : [];
  return {
    status: 'PREPARADO', archivos: ['.legion/ROLES-MD.md'], roles,
    migracion: e.inicializado ? { requerida: false } : { requerida: true, como: 'teams: activar (crea las tablas de TEAMS en la base con respaldo; pide aprobación explícita)' },
    primer_lote: primerLote, aviso: primerLote.length ? null : 'sin tareas listas: falta un plan con `teams: plan <objetivo>`',
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; }));
  const cmd = args.find((a) => !a.startsWith('--')) || 'estado';
  const root = process.cwd();
  let r;
  if (cmd === 'registrar') r = registrar(root, { rol: opt.rol, host: opt.host, session_id: opt.session });
  else if (cmd === 'latido') r = latido(root, { rol: opt.rol, session_id: opt.session });
  else if (cmd === 'canal') r = leerCanal(root, { rol: opt.rol || 'builder' });
  else if (cmd === 'ack') r = ackear(root, { rol: opt.rol || 'builder', session_id: opt.session, owner_id: opt.owner, delivery_id: opt.delivery, packet_revision: opt['packet-revision'], packet_hash: opt['packet-hash'], packet_state_hash: opt['packet-state-hash'] });
  else if (cmd === 'resultado') r = entregar(root, { rol: opt.rol || 'builder', resultado: JSON.parse(fs.readFileSync(path.resolve(root, opt.archivo), 'utf8')) });
  else if (cmd === 'visto') r = visto(root, { rol: opt.rol || 'builder', hasta_seq: opt.seq });
  else if (cmd === 'retomar') r = retomar(root, { rol: opt.rol || 'builder', session_id: opt.session });
  else if (cmd === 'preparar') r = preparar(root, { mecanica: opt.mecanica });
  else if (cmd === 'reportar') {
    const sub = args.filter((a) => !a.startsWith('--'))[1];
    r = reportar(root, { tipo: sub, tarea: opt.tarea, archivos: opt.archivos, comprobaciones: opt.comprobaciones, sesion: opt.sesion, id: opt.id, nota: opt.nota, dueno: opt.dueno, fencing: opt.fencing, evento: opt.evento, texto: opt.texto });
    if (r && r.status === 'REPORTADO' || r && r.status === 'IMPLEMENTADA_PENDIENTE_REVISION') require('./teams-canal.cjs').refrescar(root);
  }
  else if (cmd === 'ronda') r = ronda(root, { rol: opt.rol || 'builder', owner_id: opt.dueno || null });
  else r = new AdapterMdSesion(root, { rol: opt.rol || 'builder' }).capabilities();
  console.log(JSON.stringify(r, null, 2));
}

module.exports = { AdapterMdSesion, registrar, latido, leerCanal, ackear, entregar, visto, retomar, preparar, sesiones, reportar, ronda, VIGENCIA_SESION_MS };
