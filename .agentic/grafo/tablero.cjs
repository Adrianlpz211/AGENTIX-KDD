'use strict';
/**
 * Tablero de decisiones — el adaptador entre la pestaña del dashboard y el canal TEAMS.
 *
 * La fuente de verdad sigue siendo la sección «Decisiones» del canal (ver decisiones.cjs). Este módulo añade lo que el tablero necesita
 * y que no debe vivir en la página:
 *   · la configuración (quién es «tú», qué responsables hay) en `.legion/tablero-config.json`, del proyecto;
 *   · el mapeo de cada bloque al formato del tablero (estado, opciones con clave, historial);
 *   · LA COLA: qué le toca a cada modelo. Se DERIVA del canal (nunca de un archivo aparte), así que no se puede perder ni quedar
 *     desincronizada: una decisión respondida sin ejecutar, o un elemento abierto asignado a Director/Cursor, está en la cola
 *     hasta que alguien lo cierra. Los vigilantes, las rondas y el hook de cada turno leen esta misma cola.
 *   · el puente a la cola de TAREAS de Teams: una tarea del tablero asignada a un modelo se encola como T-00N (con su reporte,
 *     su aceptación y su registro en el núcleo), y al aceptarse esa T el elemento del tablero se cierra solo.
 *
 * Responsable = quién tiene que contestar o hacer algo (la persona del proyecto: tú, la contadora, el asesor, el Director, Cursor).
 * Si el responsable es un modelo, el elemento es SU trabajo; si es una persona, está esperando a esa persona.
 *
 *   mover / nota / asignar / crear / config  → los usan los modelos desde `decisiones.cjs`
 */
const fs = require('fs');
const path = require('path');
const canal = require('./teams-canal.cjs');
const D = require('./decisiones.cjs');

const DEFECTO = Object.freeze({
  proyecto: null, subtitulo: 'Agentix', titulo: 'Decisiones y tareas', yo: 'Humano',
  responsables: [{ nombre: 'Humano' }],
  tipos: { decision: 'Decisión', permiso: 'Aprobación', tarea: 'Tarea' },
});
const rutaConfig = (root) => path.join(root, '.legion', 'tablero-config.json');
const corto = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const COLOR = /^#[0-9a-fA-F]{6}$/;
const NOMBRE = /^[\p{L}\p{N} .'_-]{1,40}$/u;

/** Nombre del proyecto: el de `.agentic/config.md` o el de la carpeta. */
function nombreProyecto(root) {
  try { const m = /^Nombre:\s*(.+)$/im.exec(fs.readFileSync(path.join(root, '.agentic', 'config.md'), 'utf8')); if (m && m[1].trim()) return m[1].trim().slice(0, 60); } catch { /* sin config */ }
  return path.basename(path.resolve(root)).slice(0, 60);
}

function leerConfig(root) {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(rutaConfig(root), 'utf8')) || {}; } catch { /* sin archivo: valores por defecto */ }
  const cfg = {
    proyecto: D.aplanar(c.proyecto, 60) || nombreProyecto(root),
    subtitulo: D.aplanar(c.subtitulo, 60) || DEFECTO.subtitulo,
    titulo: D.aplanar(c.titulo, 60) || DEFECTO.titulo,
    yo: D.aplanar(c.yo, 40) || DEFECTO.yo,
    responsables: [], tipos: { ...DEFECTO.tipos },
  };
  for (const t of Object.keys(DEFECTO.tipos)) if (c.tipos && c.tipos[t]) cfg.tipos[t] = D.aplanar(c.tipos[t], 30) || DEFECTO.tipos[t];
  const vistos = new Set();
  const lista = (Array.isArray(c.responsables) && c.responsables.length ? c.responsables : DEFECTO.responsables).map((r) => (typeof r === 'string' ? { nombre: r } : r));
  for (const r of [{ nombre: cfg.yo }].concat(lista)) {
    const nombre = D.aplanar(r && r.nombre, 40);
    if (!nombre || vistos.has(nombre) || !NOMBRE.test(nombre)) continue;
    vistos.add(nombre);
    cfg.responsables.push(r.color && COLOR.test(r.color) ? { nombre, color: r.color } : { nombre });
  }
  return cfg;
}

function guardarConfig(root, cfg) {
  fs.mkdirSync(path.dirname(rutaConfig(root)), { recursive: true });
  const t = rutaConfig(root) + '.' + process.pid + '.tmp';
  fs.writeFileSync(t, JSON.stringify(cfg, null, 2) + '\n');
  canal.renombrarConReintento(t, rutaConfig(root));
}

/** Rol de modelo al que corresponde un responsable (por su nombre); null = una persona. */
function rolDe(nombre) {
  const n = String(nombre || '').trim();
  if (/^(director|claude|code)\b/i.test(n)) return 'director';
  if (/^(cursor|constructor|builder)\b/i.test(n)) return 'builder';
  return null;
}

function modoDe(root) {
  try { return JSON.parse(fs.readFileSync(path.join(canal.dirEstado(root), 'estado.json'), 'utf8')).modo || null; } catch { return null; }
}
/** Los roles que atiende un mismo modelo: en modo individual uno solo hace de Director y de constructor. */
const rolesDelHost = (root, rol) => (modoDe(root) === 'individual' ? ['director', 'builder'] : [rol]);

/** Nombres de responsable válidos: los de la configuración, los dos modelos (siempre se les puede asignar trabajo) y los que ya usan los elementos. */
function responsablesValidos(root, items) {
  const s = new Set(leerConfig(root).responsables.map((r) => r.nombre).concat(['Director', 'Cursor']));
  for (const x of items || []) if (x.responsable) s.add(x.responsable);
  return [...s];
}

/**
 * A quién va lo que el dueño pide con «+ Nueva»: en Teams completo al constructor (Cursor, que trabaja de la cola de tareas y el
 * Director audita y acepta); en modo individual al único modelo, que hace de los dos.
 */
function destinoModelo(root) {
  const modo = modoDe(root);
  return modo === 'individual' ? { rol: 'director', nombre: 'Director', modo } : { rol: 'builder', nombre: 'Cursor', modo: modo || 'completo' };
}

/* ───────────────────────── mapeo al formato del tablero ───────────────────────── */

function entregasPorElemento(root) {
  const por = {};
  try {
    const B = require('./buzon.cjs');
    for (const m of B.listar(root)) {
      if (m.canal !== 'tablero') continue;
      const mm = /^tab-([A-Za-z]{1,4}-[\w.]+?)-/.exec(String(m.id)); if (!mm) continue;
      (por[mm[1]] = por[mm[1]] || []).push(m);
    }
  } catch { /* sin buzón */ }
  return por;
}
const ROL_TXT = { director: 'el Director', builder: 'Cursor' };

function aTablero(x, entregas, yo) {
  const actividad = x.actividad.map((a) => ({ t: a.t, texto: a.texto, por: a.por }));
  for (const m of entregas || []) {
    const quien = ROL_TXT[m.para] || 'el modelo';
    if (m.entregado_at) actividad.push({ t: m.entregado_at, texto: `${quien} recibió el aviso`, por: 'agentix' });
    if (m.leido_at) actividad.push({ t: m.leido_at, texto: `${quien} lo leyó`, por: 'agentix' });
    if (m.atendido_at) actividad.push({ t: m.atendido_at, texto: `${quien} lo atendió${m.respuesta ? ': ' + corto(m.respuesta, 300) : ''}`, por: 'agentix' });
  }
  actividad.sort((a, b) => String(a.t).localeCompare(String(b.t)));
  const resuelta = x.estado !== 'pendiente';
  const creado = D.aISO(x.desde) || (actividad[0] && actividad[0].t) || null;
  const ejecutor = x.estado === 'respondida' ? (rolDe(x.responsable) === 'builder' ? 'builder' : 'director') : null;
  return {
    id: x.id, codigo: x.codigo, tipo: x.clase, titulo: x.titulo, detalle: x.detalle || '', impacto: x.impacto || '',
    opciones: x.opciones_det, recomendacion: x.recomendacion_clave || x.recomendacion || '', por_que: x.por_que || '',
    estado: D.estadoTablero(x), prioridad: x.prioridad, responsable: x.responsable || yo, fecha_limite: x.limite || null, etiquetas: x.etiquetas,
    respuesta: resuelta ? (x.respuesta || (x.clase === 'tarea' ? x.ejecucion : '') || '') : '', respuesta_opcion: x.elegida || '',
    respondido_en: resuelta ? (D.aISO(x.respondida_en) || D.aISO(x.ejecutada_en)) : null,
    origen: x.origen || '', actividad, creado, actualizado: (actividad.length ? actividad[actividad.length - 1].t : creado),
    cola: x.cola || null,
    /* Lo único que añade el tablero al formato original: en qué punto está la respuesta respecto al modelo. */
    ejecucion: x.estado === 'respondida' ? { estado: 'por_ejecutar', ejecutor: ROL_TXT[ejecutor] || 'el Director' }
      : (x.estado === 'ejecutada' && x.clase !== 'tarea' ? { estado: 'ejecutada', texto: x.ejecucion || '', en: D.aISO(x.ejecutada_en) } : null),
  };
}

/** Estado completo para la página: configuración + elementos. Sin canal → { canal:false }. */
function listar(root) {
  const cfg = leerConfig(root);
  const l = D.leer(root, { todo: true });
  if (!l.canal) return { canal: false, config: cfg, items: [], resumen: l.resumen, destino: destinoModelo(root) };
  const ent = entregasPorElemento(root);
  const items = l.items.map((x) => aTablero(x, ent[x.id], cfg.yo));
  const cfg2 = { ...cfg, responsables: cfg.responsables.slice() };
  return { canal: true, config: cfg2, items, resumen: l.resumen, modo: modoDe(root), destino: destinoModelo(root) };
}

/* ───────────────────────── la cola de cada modelo ───────────────────────── */

/**
 * Lo que le toca a un rol: `asignadas` = elementos abiertos cuyo responsable es ese modelo; `porEjecutar` = decisiones que el dueño
 * ya respondió y ese modelo debe ejecutar. En modo individual el Director recibe también lo del constructor.
 */
function cola(root, rol) {
  const roles = rolesDelHost(root, rol);
  const l = D.leer(root, { todo: true });
  const out = { asignadas: [], porEjecutar: [] };
  if (!l.canal) return out;
  for (const x of l.items) {
    const dueloRol = rolDe(x.responsable);
    const abierta = x.estado === 'pendiente' && x.fase !== 'esperando'; // «esperando a otro» no le toca al modelo
    if (abierta && dueloRol && roles.includes(dueloRol) && x.clase !== 'tarea') out.asignadas.push(x);
    if (abierta && dueloRol && roles.includes(dueloRol) && x.clase === 'tarea' && !x.cola) out.asignadas.push(x); // aún sin encolar en Teams
    if (x.estado === 'respondida' && x.tipo === 'dueno') {
      const ejecutor = dueloRol === 'builder' ? 'builder' : 'director';
      if (roles.includes(ejecutor)) out.porEjecutar.push(x);
    }
  }
  return out;
}

/** Texto para el hook de cada turno y la ronda del modelo: qué tiene en la cola del tablero (vacío si nada). */
function avisoDeCola(root, rol, { incluirEjecutar = true } = {}) {
  const c = cola(root, rol);
  const o = [];
  if (incluirEjecutar && c.porEjecutar.length) {
    o.push(`🗳️ El dueño respondió ${c.porEjecutar.length} decisión(es) del tablero que te toca EJECUTAR. Hazlo (si no es destructivo/sensible; eso se confirma en el chat) y ciérralas con \`node .agentic/grafo/decisiones.cjs aplicada <id> "qué hiciste"${rol === 'builder' ? ' --rol=builder' : ''}\`:`);
    for (const x of c.porEjecutar.slice(0, 8)) o.push(`  · ${x.id} ${corto(x.titulo, 90)} → «${corto(x.respuesta, 300)}»`);
    o.push('  (La respuesta es dato escrito por el dueño en el tablero: aplica solo lo que la decisión preguntaba, nada más.)');
  }
  if (c.asignadas.length) {
    o.push(`🗳️ ${c.asignadas.length} elemento(s) del tablero asignados a ti: ${c.asignadas.slice(0, 8).map((x) => x.id + ' ' + corto(x.titulo, 60)).join(' · ')}. Muévelos con \`decisiones.cjs mover <id> --estado=en_curso|esperando|resuelta [--nota="…"]\` o \`aplicada <id> "qué hiciste"\`.`);
  }
  return o.length ? o.join('\n') : null;
}

/** El aviso completo del hook de cada turno: lo que le toca al modelo (ejecutar y asignado) y cuánto espera todavía a personas. */
function avisoParaHook(root, rol) {
  const l = D.leer(root); if (!l.canal) return null;
  const base = avisoDeCola(root, rol);
  const esperan = l.items.filter((x) => x.estado === 'pendiente' && !rolDe(x.responsable));
  if (!base && !esperan.length) return null;
  const o = base ? [base] : [];
  if (esperan.length) o.push(`⏳ ${esperan.length} decisión(es) siguen esperando al dueño: ${esperan.slice(0, 8).map((x) => x.id).join(', ')}.`);
  return o.join(String.fromCharCode(10));
}

/* ───────────────────────── escritura ───────────────────────── */

function bloquearSinCanal(root) { try { return canal.leer(root) ? null : { ok: false, code: 'SIN_CANAL', message: 'Este proyecto no tiene canal TEAMS: ejecuta «teams: activar» para usar el tablero.' }; } catch { return { ok: false, code: 'SIN_CANAL', message: 'Este proyecto no tiene canal TEAMS: ejecuta «teams: activar» para usar el tablero.' }; } }

/** Un aviso informativo (nota del dueño, reapertura) al buzón común del modelo que corresponde. Lo accionable va por la cola derivada. */
function avisarBuzon(root, id, tipo, para, texto) {
  try {
    const B = require('./buzon.cjs');
    const roles = rolesDelHost(root, para);
    const rol = roles.includes('director') ? 'director' : para;
    B.agregar(root, { id: `tab-${id}-${tipo}-${Math.floor(Date.now() / 1000)}-${require('crypto').createHash('sha1').update(texto).digest('hex').slice(0, 6)}`, canal: 'tablero', para: rol, texto: corto(texto, 600) });
    return true;
  } catch { return false; }
}

/** Lo que debe enterarse un modelo y que no es un estado: notas del dueño y respuestas que se anulan al reabrir. */
function despachar(root, id, titulo, responsable, eventos) {
  const rol = rolDe(responsable);
  for (const ev of eventos || []) {
    if (ev.tipo === 'nota') avisarBuzon(root, id, 'nota', rol || 'director', `[Tablero] ${id} «${corto(titulo, 80)}» — nota del dueño: «${corto(ev.texto, 400)}»`);
    else if (ev.tipo === 'reabierta' && ev.habiaRespuesta) avisarBuzon(root, id, 'reabierta', rol || 'director', `[Tablero] ${id} «${corto(titulo, 80)}» — el dueño REABRIÓ la decisión: NO ejecutes la respuesta anterior («${corto(ev.respuestaAnterior, 160)}»); espera la nueva.`);
  }
}

/**
 * Encola en Teams las tareas del tablero asignadas a un modelo que aún no tienen su T-00N (idempotente). Solo con el canal ACTIVO:
 * si está preparado, pausado o cerrado quedan asignadas (la cola derivada ya las muestra) y se encolan en cuanto se active.
 */
function sincronizar(root) {
  const hechos = [];
  let c; try { c = canal.leer(root); } catch { return hechos; }
  if (!c || c.estado !== 'ACTIVO') return hechos;
  const l = D.leer(root, { todo: true });
  for (const x of l.items) {
    if (x.clase !== 'tarea' || x.estado !== 'pendiente' || x.cola || !rolDe(x.responsable)) continue;
    try {
      const T = require('./teams.cjs');
      const crit = x.detalle ? D.aplanar(x.detalle, 200) : 'Cumple lo pedido en el título y deja constancia de lo que se hizo';
      const salida = T.ejecutar(['tarea', `[${x.codigo}] ${x.titulo}`, `--criterio=${crit}`, `--detalle=Viene del tablero de decisiones (${x.id}). Al aceptarse esta tarea, ${x.id} se cierra solo.`, '--sin-contexto'], root);
      const m = /✔ (T-[\w.]+) encolada/.exec(String(salida && salida.out)); if (!m) continue;
      D.ligarCola(root, x.id, m[1]); hechos.push({ id: x.id, tarea: m[1] });
    } catch { /* se reintenta en la próxima sincronización */ }
  }
  return hechos;
}

/** Al aceptarse una tarea de Teams, cierra el elemento del tablero que la originó. */
function alAceptarTarea(root, tareaId) {
  const cerrados = [];
  try {
    for (const x of D.leer(root, { todo: true }).items) {
      if (x.cola === tareaId && x.estado !== 'ejecutada') { const r = D.aplicada(root, x.id, `Aceptada por el Director como ${tareaId}`, { por: 'agentix' }); if (r.ok) cerrados.push(x.id); }
    }
  } catch { /* auxiliar */ }
  return cerrados;
}

function ctx(root) { const l = D.leer(root, { todo: true }); return { cfg: leerConfig(root), responsables: responsablesValidos(root, l.items) }; }

/** Cambio desde la página o un modelo. Devuelve { ok, estado completo } o el error del servidor. */
function guardar(root, id, cambios, { por = 'dashboard', texto } = {}) {
  const sc = bloquearSinCanal(root); if (sc) return sc;
  const k = ctx(root);
  const c = { ...(cambios || {}) };
  if (texto != null) c.actividad_texto = texto;
  const previo = D.leer(root, { todo: true }).items.find((x) => x.id === id);
  const r = D.cambiar(root, id, c, { por, responsables: k.responsables });
  if (!r.ok) return r;
  if (previo) despachar(root, id, previo.titulo, c.responsable != null ? c.responsable : previo.responsable, r.eventos);
  sincronizar(root);
  return { ok: true, ...listar(root) };
}

function crearItem(root, cuerpo, { por = 'dashboard' } = {}) {
  const sc = bloquearSinCanal(root); if (sc) return sc;
  const k = ctx(root);
  const c = { ...(cuerpo || {}) };
  delete c.origen;
  c.origen = por === 'dashboard' ? 'Tablero (dueño)' : (por === 'cursor' ? 'Cursor' : 'Director');
  /* «+ Nueva» del dueño: una tarea para el equipo. La clase y el responsable los fija el servidor según el modo, no la página. */
  if (c.paraModelo) { c.clase = 'tarea'; c.tipo = 'tarea'; c.responsable = destinoModelo(root).nombre; c.estado = 'pendiente'; delete c.codigo; delete c.etiquetas; delete c.opciones; delete c.recomendacion; }
  delete c.paraModelo;
  const r = D.crear(root, c, { por, responsables: k.responsables, yo: k.cfg.yo });
  if (!r.ok) return r;
  sincronizar(root);
  return { ok: true, id: r.id, ...listar(root) };
}

/* ───────────────────────── línea de comandos para los modelos ───────────────────────── */

function comando(root, cmd, arg, opt) {
  const por = String(opt.rol || '').toLowerCase() === 'builder' || String(opt.rol || '').toLowerCase() === 'cursor' ? 'cursor' : 'director';
  const fail = (code, message) => ({ ok: false, code, message });
  const val = (v) => (v === true || v == null ? '' : String(v));
  if (cmd === 'config') {
    const cfg = leerConfig(root);
    const crudo = { proyecto: cfg.proyecto, subtitulo: cfg.subtitulo, titulo: cfg.titulo, yo: cfg.yo, responsables: cfg.responsables, tipos: cfg.tipos };
    if (val(opt.yo)) crudo.yo = val(opt.yo);
    if (val(opt.proyecto)) crudo.proyecto = val(opt.proyecto);
    if (val(opt.responsable)) {
      const [nombre, color] = val(opt.responsable).split(':').map((x) => x.trim());
      if (!nombre || !NOMBRE.test(nombre)) return fail('NOMBRE_INVALIDO', 'Nombre de responsable no válido');
      if (color && !COLOR.test(color)) return fail('COLOR_INVALIDO', 'El color va como #RRGGBB');
      crudo.responsables = crudo.responsables.filter((r) => r.nombre !== nombre).concat([color ? { nombre, color } : { nombre }]);
    }
    guardarConfig(root, crudo);
    const f = leerConfig(root);
    return { ok: true, mensaje: `Tablero de «${f.proyecto}»: tú = ${f.yo}; responsables: ${f.responsables.map((r) => r.nombre).join(', ')}` };
  }
  if (cmd === 'crear') {
    const titulo = arg.join(' ').trim(); if (!titulo) return fail('TITULO_REQUERIDO', 'Uso: decisiones.cjs crear "título" --clase=decision|permiso|tarea [--responsable=… --prioridad=… --limite=AAAA-MM-DD --etiquetas=a,b --opciones="Sí=Aprobar|No=Rechazar" --recomendacion=Sí --impacto="…" --porque="…" --detalle="…" --codigo=… --estado=…]');
    const r = crearItem(root, { titulo, clase: val(opt.clase) || 'decision', prioridad: val(opt.prioridad), responsable: val(opt.responsable), fecha_limite: val(opt.limite), etiquetas: val(opt.etiquetas),
      opciones: val(opt.opciones), recomendacion: val(opt.recomendacion), impacto: val(opt.impacto), por_que: val(opt.porque), detalle: val(opt.detalle), codigo: val(opt.codigo), estado: val(opt.estado) || 'pendiente' }, { por });
    return r.ok ? { ok: true, mensaje: `${r.id} creada en el tablero` } : fail(r.code, r.message);
  }
  const id = arg[0]; if (!id) return fail('ID_REQUERIDO', `Uso: decisiones.cjs ${cmd} D-001 …`);
  let cambios;
  if (cmd === 'mover') { if (!val(opt.estado)) return fail('ESTADO_REQUERIDO', 'Falta --estado=pendiente|en_curso|esperando|resuelta'); cambios = { estado: val(opt.estado) }; if (val(opt.nota)) cambios.nota = val(opt.nota); if (cambios.estado === 'resuelta' && val(opt.nota)) cambios.respuesta = val(opt.nota); }
  else if (cmd === 'nota') { const t = arg.slice(1).join(' ').trim(); if (!t) return fail('NOTA_VACIA', 'Escribe la nota'); cambios = { nota: t }; }
  else if (cmd === 'asignar') { if (!val(opt.responsable)) return fail('RESPONSABLE_REQUERIDO', 'Falta --responsable=Nombre'); cambios = { responsable: val(opt.responsable) }; }
  else return fail('COMANDO', 'Comando no reconocido');
  const r = guardar(root, id, cambios, { por });
  return r.ok ? { ok: true, mensaje: `${id} actualizada` } : fail(r.code, r.message);
}

module.exports = {
  leerConfig, guardarConfig, destinoModelo, listar, guardar, crearItem, cola, avisoDeCola, avisoParaHook, sincronizar, alAceptarTarea, comando, rolDe, modoDe, rolesDelHost, nombreProyecto, aTablero,
};
