'use strict';
/**
 * Decisiones del dueño — el tablero y su ciclo de vida. UNA sola fuente de verdad: el canal `.legion/AUDITORIA-CURSOR.md`
 * (sección «Decisiones»). Este módulo no crea otro archivo de datos: lee y escribe ese mismo canal con el mismo lock y el
 * mismo renombrado atómico de teams-canal.cjs, así que el vigilante y las rondas ya existentes ven cada cambio.
 *
 * Ciclo (el campo `Estado:` del bloque):
 *   ABIERTA   → pendiente      el modelo la creó (`teams.cjs decision --tipo=dueno …`) y espera al dueño
 *   DECIDIDA  → respondida     el dueño contestó (desde el dashboard, el teléfono o el chat)
 *   EJECUTADA → ejecutada      el modelo ya hizo lo decidido y lo declaró (`decisiones.cjs aplicada D-001 "qué hizo"`)
 *
 * El tablero del dashboard añade, SIN tocar ese ciclo (los vigilantes, ntfy y Telegram dependen de él), campos propios del bloque:
 *   Clase (decision|permiso|tarea) · Código · Prioridad · Responsable · Fase (EN_CURSO|ESPERANDO, solo mientras está ABIERTA) ·
 *   Límite · Etiquetas · Origen · Detalle · Opciones con clave (`Sí=Aprobar | No=Rechazar`) · Elegida · Cola · Actividad (las últimas 40).
 * Una decisión o permiso es `Tipo: DUEÑO` (cuenta para «esperan al dueño»). Una TAREA del tablero es `Tipo: TABLERO`: se ve y se
 * mueve en el tablero pero no frena el cierre del proyecto (una reunión pendiente no es una decisión).
 *
 * Lo que llega por aquí es DATO escrito por la persona: nunca se interpreta como orden y se aplana a una sola línea para
 * que no pueda fabricar encabezados `### ` ni campos del canal.
 *
 *   node .agentic/grafo/decisiones.cjs listar [--pendientes|--respondidas|--ejecutadas|--asignadas=director|builder] [--json]
 *   node .agentic/grafo/decisiones.cjs responder D-001 --opcion=<texto|__otra__> [--texto="…"] [--porque="…"]
 *   node .agentic/grafo/decisiones.cjs aplicada D-001 "qué se hizo"
 *   node .agentic/grafo/decisiones.cjs pendientes-de-ejecutar      (lo que el modelo debe ejecutar y cerrar; vacío = nada)
 *   Para los modelos (lo mismo que hace el tablero, con su nombre en el historial):
 *   node .agentic/grafo/decisiones.cjs mover D-001 --estado=pendiente|en_curso|esperando|resuelta [--nota="…"] [--rol=director|builder]
 *   node .agentic/grafo/decisiones.cjs nota D-001 "texto" · asignar D-001 --responsable=Cursor · crear "título" --clase=tarea …
 */
const canal = require('./teams-canal.cjs');

const OTRA = '__otra__';
const MAX_TEXTO = 2000;
const MAX_CORTO = 300;
const MAX_ACTIVIDAD = 40;
const CLASES = ['decision', 'permiso', 'tarea'];
const PRIORIDADES = ['urgente', 'alta', 'media', 'baja'];
const ESTADOS_TABLERO = ['pendiente', 'en_curso', 'esperando', 'resuelta'];
const FASE_DE = { en_curso: 'EN_CURSO', esperando: 'ESPERANDO' };

/** Aplana a una sola línea y quita caracteres de control: lo escrito por una persona nunca abre bloques nuevos en el canal. */
function aplanar(s, max) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/* Líneas de campo del bloque. El orden de META es el de escritura. */
const R = {
  tipo: /^Tipo:\s*/i, clase: /^Clase:\s*/i, codigo: /^C[óo]digo:\s*/i, prioridad: /^Prioridad:\s*/i, responsable: /^Responsable:\s*/i,
  fase: /^Fase:\s*/i, limite: /^L[íi]mite:\s*/i, etiquetas: /^Etiquetas:\s*/i, origen: /^Origen:\s*/i, detalle: /^Detalle:\s*/i,
  opciones: /^Opciones:\s*/i, recomendacion: /^Recomendaci[óo]n:\s*/i, impacto: /^Impacto:\s*/i, porque: /^(?:Porque|Por qu[ée]):\s*/i,
  fuentes: /^Fuentes:\s*/i, elegida: /^Elegida:\s*/i, respondidaPor: /^Respondida por:\s*/i, decision: /^Decisi[óo]n del due[ñn]o/i,
  ejecutada: /^Ejecutada\s/i, cola: /^Cola:\s*/i, actividad: /^Actividad\s/i,
};
const META = ['clase', 'codigo', 'prioridad', 'responsable', 'fase', 'limite', 'etiquetas', 'origen', 'detalle'];
const NOMBRE_CAMPO = { clase: 'Clase', codigo: 'Código', prioridad: 'Prioridad', responsable: 'Responsable', fase: 'Fase', limite: 'Límite', etiquetas: 'Etiquetas', origen: 'Origen', detalle: 'Detalle' };
const CAMPOS_CONOCIDOS = Object.values(R);

function campo(lineas, re) {
  const l = lineas.find((x) => re.test(x));
  return l ? l.replace(re, '').trim() : null;
}

/** `Sí=Aprobar | No=Rechazar` → [{clave, texto}]; sin `=`, la clave es el propio texto (formato de siempre: `A|B|C`). */
function parsearOpciones(txt) {
  if (!txt) return [];
  return String(txt).split(/\s*[|;]\s*/).map((x) => x.trim()).filter(Boolean).map((x) => {
    const i = x.indexOf('=');
    return i > 0 ? { clave: x.slice(0, i).trim(), texto: x.slice(i + 1).trim() || x.slice(0, i).trim() } : { clave: x, texto: x };
  });
}
const sinSeparadores = (s, max) => aplanar(s, max).replace(/[|;]/g, '/');
function textoOpciones(ops) {
  return (ops || []).map((o) => {
    const clave = sinSeparadores(o && o.clave != null ? o.clave : o, 60).replace(/=/g, '-');
    const texto = sinSeparadores(o && o.texto != null ? o.texto : '', MAX_CORTO);
    return !clave ? '' : (texto && texto !== clave ? clave + '=' + texto : clave);
  }).filter(Boolean).join(' | ');
}

/** La clave de la opción a la que se refiere la recomendación (que puede venir como clave o como texto libre). */
function claveRecomendada(rec, ops) {
  if (!rec || !ops || !ops.length) return null;
  const r = String(rec).trim().toLowerCase();
  const exacta = ops.find((o) => o.clave.toLowerCase() === r);
  if (exacta) return exacta.clave;
  const aprox = ops.find((o) => r.indexOf(o.clave.toLowerCase()) === 0 || o.clave.toLowerCase().indexOf(r) === 0 || (o.texto && o.texto.toLowerCase() === r));
  return aprox ? aprox.clave : null;
}

const selloDe = (l) => { const m = l && /(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/.exec(l); return m ? m[1] : null; };
const aISO = (sello) => { if (!sello) return null; const t = Date.parse(String(sello).replace(' ', 'T')); return Number.isFinite(t) ? new Date(t).toISOString() : null; };

function parsearActividad(lineas) {
  return lineas.filter((l) => R.actividad.test(l)).map((l) => {
    const m = /^Actividad\s+(\S+)\s+·\s+(\S+)\s+·\s+([\s\S]*)$/.exec(l);
    return m ? { t: m[1], por: m[2], texto: m[3].trim() } : null;
  }).filter(Boolean);
}

function parsear(d) {
  const lineas = String(d.texto || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const tipoM = /Tipo:\s*(DIRECTOR|DUE[ÑN]O|TABLERO)/i.exec(d.texto);
  const tipoTxt = tipoM ? tipoM[1].toUpperCase() : 'DIRECTOR';
  const dueno = /DUE/.test(tipoTxt);
  const tablero = tipoTxt === 'TABLERO';
  const est = /Estado:\s*(ABIERTA|DECIDIDA|EJECUTADA)/i.exec(d.texto);
  const resp = lineas.find((l) => R.decision.test(l)) || null;
  const ejec = lineas.find((l) => R.ejecutada.test(l)) || null;
  let estado;
  if (est) estado = /EJECUTADA/i.test(est[1]) ? 'ejecutada' : (/DECIDIDA/i.test(est[1]) ? 'respondida' : 'pendiente');
  else estado = resp ? 'respondida' : 'pendiente'; // un bloque del dueño sin `Estado:` pero ya contestado
  const opcionesDet = parsearOpciones(campo(lineas, R.opciones));
  const faseTxt = (campo(lineas, R.fase) || '').toUpperCase();
  const claseTxt = (campo(lineas, R.clase) || '').toLowerCase();
  const prio = (campo(lineas, R.prioridad) || '').toLowerCase();
  const cuerpo = lineas.slice(1).filter((l) => !CAMPOS_CONOCIDOS.some((re) => re.test(l)) && !/^Tipo:\s*(DIRECTOR|DUE[ÑN]O|TABLERO)\b/i.test(l));
  const etiq = (campo(lineas, R.etiquetas) || '').split(',').map((x) => x.trim()).filter(Boolean);
  const limite = campo(lineas, R.limite);
  const recomendacion = campo(lineas, R.recomendacion);
  return {
    id: d.id,
    titulo: aplanar(d.titulo, 200),
    tipo: dueno ? 'dueno' : (tablero ? 'tablero' : 'director'),
    clase: CLASES.includes(claseTxt) ? claseTxt : (tablero ? 'tarea' : 'decision'),
    codigo: campo(lineas, R.codigo) || d.id,
    estado,
    fase: faseTxt === 'EN_CURSO' ? 'en_curso' : (faseTxt === 'ESPERANDO' ? 'esperando' : null),
    detalle: aplanar(campo(lineas, R.detalle) != null ? campo(lineas, R.detalle) : cuerpo.join(' '), 600),
    opciones: opcionesDet.map((o) => o.clave),
    opciones_det: opcionesDet,
    recomendacion,
    recomendacion_clave: claveRecomendada(recomendacion, opcionesDet),
    impacto: campo(lineas, R.impacto),
    por_que: campo(lineas, R.porque),
    prioridad: PRIORIDADES.includes(prio) ? prio : 'media',
    responsable: campo(lineas, R.responsable),
    limite: /^\d{4}-\d{2}-\d{2}$/.test(limite || '') ? limite : null,
    etiquetas: etiq,
    origen: campo(lineas, R.origen),
    elegida: campo(lineas, R.elegida),
    cola: campo(lineas, R.cola),
    actividad: parsearActividad(lineas),
    desde: selloDe(lineas[1] || ''),
    respuesta: resp ? resp.replace(/^Decisi[óo]n del due[ñn]o\s*(?:\d{4}-\d{2}-\d{2} \d{2}:\d{2})?\s*:?\s*/i, '') : null,
    respondida_en: selloDe(resp),
    via: (campo(lineas, R.respondidaPor) || '').split(/\s/)[0] || null,
    ejecucion: ejec ? ejec.replace(/^Ejecutada\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}\s*:?\s*/i, '') : null,
    ejecutada_en: selloDe(ejec),
  };
}

const VACIO = { canal: false, items: [], resumen: { pendientes: 0, respondidas: 0, ejecutadas: 0 } };

/** Todas las decisiones DEL DUEÑO del canal, ya clasificadas. Sin canal: lista vacía (no es un error). `todo` incluye las tareas del tablero. */
function leer(root, { todo = false } = {}) {
  let c;
  try { c = canal.leer(root); } catch { return { ...VACIO }; }
  if (!c) return { ...VACIO };
  const items = canal.elementos(c, 'decisiones').map(parsear).filter((x) => x.tipo === 'dueno' || (todo && x.tipo === 'tablero'));
  const n = (e) => items.filter((x) => x.estado === e).length;
  return { canal: true, items, resumen: { pendientes: n('pendiente'), respondidas: n('respondida'), ejecutadas: n('ejecutada') } };
}

const err = (code, message) => ({ ok: false, code, message });

/* ───────────────────────── edición del bloque ─────────────────────────
   Se trabaja sobre una copia de las líneas del bloque y se devuelve de una sola vez: así varios cambios en la misma llamada no
   desplazan los índices. Lo que Agentix no entiende (texto que alguien añadió a mano) se conserva tal cual. */

function indiceDe(bl, re) { for (let i = 1; i < bl.length; i++) if (re.test(bl[i].trim())) return i; return -1; }
function sacar(bl, re) { for (let i = bl.length - 1; i >= 1; i--) if (re.test(bl[i].trim())) bl.splice(i, 1); }

/** Pone, cambia o quita (valor vacío) un campo de META en su sitio canónico, justo tras la cabecera. */
function poner(bl, clave, valor) {
  const re = R[clave]; const i = indiceDe(bl, re);
  const v = valor == null ? '' : String(valor);
  if (!v) { if (i > 0) bl.splice(i, 1); return; }
  const linea = NOMBRE_CAMPO[clave] + ': ' + v;
  if (i > 0) { bl[i] = linea; return; }
  let pos = /^Tipo:/i.test((bl[1] || '').trim()) ? 2 : 1;
  for (const previo of META.slice(0, META.indexOf(clave))) { const j = indiceDe(bl, R[previo]); if (j >= pos) pos = j + 1; }
  bl.splice(pos, 0, linea);
}

function ponerEstado(bl, estado) {
  for (let i = 0; i < Math.min(bl.length, 4); i++) {
    if (/Estado:\s*(ABIERTA|DECIDIDA|EJECUTADA)/i.test(bl[i])) { bl[i] = bl[i].replace(/Estado:\s*(ABIERTA|DECIDIDA|EJECUTADA)/i, 'Estado: ' + estado); return; }
  }
  const i = /^Tipo:/i.test((bl[1] || '').trim()) ? 1 : 0;
  bl[i] = bl[i] + ' · Estado: ' + estado;
}

/** Reescribe la cola del bloque (respuesta, ejecución, cola y actividad), que es lo que cambia con el ciclo. */
function reescribirCola(bl, { respuesta, ejecucion, cola, actividad }) {
  for (const re of [R.decision, R.respondidaPor, R.elegida, R.ejecutada, R.cola, R.actividad]) sacar(bl, re);
  if (respuesta) {
    bl.push(`Decisión del dueño ${respuesta.sello}: ${respuesta.texto}`);
    if (respuesta.via) bl.push(`Respondida por: ${respuesta.via}`);
    if (respuesta.elegida) bl.push(`Elegida: ${respuesta.elegida}`);
  }
  if (ejecucion) bl.push(`Ejecutada ${ejecucion.sello}: ${ejecucion.texto}`);
  if (cola) bl.push(`Cola: ${cola}`);
  for (const a of (actividad || []).slice(-MAX_ACTIVIDAD)) bl.push(`Actividad ${a.t} · ${a.por} · ${a.texto}`);
}

const ahoraISO = () => new Date().toISOString();
const porSeguro = (s) => aplanar(s || 'dashboard', 20).replace(/[^\w-]/g, '') || 'dashboard';

/** Aplica `fn(bl, actual)` al bloque `id` bajo el lock del canal. `fn` devuelve {ok:false,…} para abortar sin escribir. */
function editar(root, id, fn) {
  let res = null;
  try {
    canal.mutar(root, (lineas, c) => {
      const d = canal.elementos(c, 'decisiones').find((x) => x.id === id);
      if (!d) { res = err('NO_EXISTE', 'No encuentro la decisión ' + id); return null; }
      const bl = lineas.slice(d.ini, d.fin);
      const out = fn(bl, parsear(d));
      res = out || err('ERROR', 'sin resultado');
      if (res.ok === false) return null;
      lineas.splice(d.ini, d.fin - d.ini, ...bl);
      return lineas;
    });
  } catch (e) { return err(e.code || 'ERROR', String(e.message || e).slice(0, 200)); }
  return res || err('NO_EXISTE', 'No encuentro la decisión ' + id);
}

/** El estado que ve el tablero (pendiente / en_curso / esperando / resuelta) a partir del ciclo del canal. */
function estadoTablero(x) { return x.estado === 'pendiente' ? (x.fase || 'pendiente') : 'resuelta'; }

function validarId(id) {
  const idl = aplanar(id, 40);
  return /^[A-Za-z]{1,4}-[\w.]+$/.test(idl) ? idl : null;
}

/**
 * El dueño responde una decisión pendiente. `opcion` es la clave de una de las opciones o `__otra__` (entonces `texto` es
 * obligatorio). Solo cambia Pendiente → Respondida; una ya respondida no se pisa en silencio.
 */
function responder(root, id, { opcion, texto, porque, via } = {}) {
  const idl = validarId(id);
  if (!idl) return err('ID_INVALIDO', 'El id de la decisión no es válido');
  const op = aplanar(opcion, MAX_CORTO); const tx = aplanar(texto, MAX_TEXTO); const pq = aplanar(porque, MAX_TEXTO);
  if (!op && !tx) return err('RESPUESTA_VACIA', 'Elige una opción o escribe tu respuesta');
  if (op === OTRA && !tx) return err('OTRA_SIN_TEXTO', 'Elegiste «Otra»: escribe tu respuesta');
  const canalVia = porSeguro(via || 'cli');
  const previo = leer(root, { todo: true }).items.find((x) => x.id === idl);
  if (!previo) return err('NO_EXISTE', 'No encuentro la decisión ' + idl);
  if (previo.tipo === 'tablero') return err('NO_ES_DECISION', idl + ' es una tarea: se cierra con «mover --estado=resuelta» o «aplicada», no se responde');
  if (previo.estado !== 'pendiente') return err('YA_RESPONDIDA', idl + ' ya está ' + (previo.estado === 'respondida' ? 'respondida' : 'ejecutada'));
  if (op && op !== OTRA && previo.opciones.length && !previo.opciones.includes(op)) return err('OPCION_INVALIDA', 'Esa opción no es una de las de la decisión');
  const det = previo.opciones_det.find((o) => o.clave === op);
  const dec = op && op !== OTRA ? op + (tx ? ' — ' + tx : '') : tx;
  const r = editar(root, idl, (bl, actual) => {
    if (actual.estado !== 'pendiente') return err('YA_RESPONDIDA', idl + ' ya fue respondida por otra vía'); // otro la respondió entre la lectura y el lock
    ponerEstado(bl, 'DECIDIDA'); poner(bl, 'fase', '');
    const act = actual.actividad.concat([{ t: ahoraISO(), por: canalVia, texto: 'Respondió: ' + (det && det.texto && det.texto !== op ? op + ': ' + det.texto : dec) }]);
    reescribirCola(bl, { respuesta: { sello: canal.sello(), texto: dec + (pq ? ' — ' + pq : ''), via: canalVia, elegida: op && op !== OTRA ? op : '' }, ejecucion: null, cola: actual.cola, actividad: act });
    return { ok: true };
  });
  if (!r.ok) return r;
  try { // la respuesta también queda como decisión de la memoria KDD, igual que `teams.cjs decidir`
    require('./teams-registro.cjs').recordar(root, 'dec-dueno:' + idl + ':' + canal.sha(dec).slice(0, 8), `[teams] Decisión del dueño ${idl}: ${dec}`, { tipo: 'decision', area: 'global', confianza: 'ALTA' });
  } catch { /* la memoria es auxiliar: la respuesta ya está en el canal */ }
  return { ok: true, id: idl, estado: 'respondida', respuesta: dec };
}

/** El modelo declara que ya ejecutó lo decidido: Respondida → Ejecutada. */
function aplicada(root, id, nota, { por } = {}) {
  const idl = validarId(id) || aplanar(id, 40);
  const actual = leer(root, { todo: true }).items.find((x) => x.id === idl);
  if (!actual) return err('NO_EXISTE', 'No encuentro la decisión ' + idl);
  if (actual.estado === 'pendiente' && actual.tipo !== 'tablero') return err('SIN_RESPUESTA', idl + ' todavía no tiene respuesta del dueño: no hay nada que ejecutar');
  if (actual.estado === 'ejecutada') return { ok: true, id: idl, estado: 'ejecutada', ya: true };
  const nt = aplanar(nota, MAX_TEXTO);
  if (!nt) return err('NOTA_VACIA', 'Di qué se hizo (una línea): una decisión no se cierra sin evidencia');
  const r = editar(root, idl, (bl, a) => {
    if (a.estado === 'ejecutada') return { ok: true, ya: true };
    ponerEstado(bl, 'EJECUTADA'); poner(bl, 'fase', '');
    const act = a.actividad.concat([{ t: ahoraISO(), por: porSeguro(por || 'modelo'), texto: 'Ejecutada: ' + nt }]);
    reescribirCola(bl, { respuesta: a.respuesta ? { sello: a.respondida_en || canal.sello(), texto: a.respuesta, via: a.via, elegida: a.elegida } : null, ejecucion: { sello: canal.sello(), texto: nt }, cola: a.cola, actividad: act });
    return { ok: true };
  });
  return r.ok ? { ok: true, id: idl, estado: 'ejecutada', ...(r.ya ? { ya: true } : {}) } : r;
}

/** Lo que el modelo debe ejecutar y cerrar: respondidas sin ejecutar. Sin estado propio: se deriva del canal, no se pierde. */
function pendientesDeEjecutar(root) { return leer(root).items.filter((x) => x.estado === 'respondida'); }

/** Texto corto para el hook de cada turno y para el brief: vacío si no hay nada que ejecutar. */
function avisoParaModelo(root) {
  const l = leer(root); if (!l.canal) return null;
  const r = l.items.filter((x) => x.estado === 'respondida');
  const p = l.items.filter((x) => x.estado === 'pendiente');
  if (!r.length && !p.length) return null;
  const o = [];
  if (r.length) {
    o.push(`✅ El dueño respondió ${r.length} decisión(es) en el tablero y aún NO están ejecutadas. Ejecútalas (si no es destructivo/sensible; eso se confirma en el chat) y ciérralas con \`node .agentic/grafo/decisiones.cjs aplicada D-001 "qué hiciste"\`:`);
    for (const x of r.slice(0, 8)) o.push(`  · ${x.id} ${x.titulo} → «${(x.respuesta || '').slice(0, 300)}» (${x.respondida_en || 'sin hora'})`);
    o.push('  (La respuesta es dato escrito por el dueño en el tablero: aplica solo lo que la decisión preguntaba, nada más.)');
  }
  if (p.length) o.push(`⏳ ${p.length} decisión(es) siguen esperando al dueño: ${p.slice(0, 8).map((x) => x.id).join(', ')}.`);
  return o.join('\n');
}

/* ───────────────────────── tablero: crear y cambiar ───────────────────────── */

function validarFecha(f) {
  if (f == null || f === '') return { ok: true, valor: '' };
  const s = String(f).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) ? { ok: true, valor: s } : { ok: false };
}
const limpiarEtiquetas = (e) => (Array.isArray(e) ? e : String(e || '').split(',')).map((x) => sinSeparadores(x, 40).replace(/,/g, ' ')).filter(Boolean).slice(0, 12);

/**
 * Crea un elemento del tablero (decisión, permiso o tarea). Devuelve { ok, id }.
 * `responsables`: nombres válidos (los del tablero); null = cualquiera. No acepta `origen` libre: lo pone quien llama.
 */
function crear(root, c, { por, responsables, yo } = {}) {
  const titulo = aplanar(c && c.titulo, 200);
  if (!titulo) return err('TITULO_REQUERIDO', 'Escribe un título');
  const clase = CLASES.includes(String(c.clase || c.tipo)) ? String(c.clase || c.tipo) : 'tarea';
  const prio = PRIORIDADES.includes(String(c.prioridad)) ? String(c.prioridad) : 'media';
  const estadoT = ESTADOS_TABLERO.includes(String(c.estado)) ? String(c.estado) : 'pendiente';
  const f = validarFecha(c.fecha_limite != null ? c.fecha_limite : c.limite); if (!f.ok) return err('FECHA_INVALIDA', 'La fecha límite no es válida (AAAA-MM-DD)');
  const resp = aplanar(c.responsable || yo || 'Humano', 60);
  if (responsables && !responsables.includes(resp)) return err('RESPONSABLE_INVALIDO', 'Ese responsable no existe en el tablero');
  const ops = Array.isArray(c.opciones) ? c.opciones : parsearOpciones(c.opciones);
  const opsTxt = textoOpciones(ops);
  const recom = aplanar(c.recomendacion, MAX_CORTO);
  const porQuien = porSeguro(por);
  const origen = aplanar(c.origen, 120).replace(/^constructor\b/i, 'del constructor'); // `Origen: CONSTRUCTOR` es la marca de una solicitud del constructor
  const cerrada = estadoT === 'resuelta';
  let id = '';
  try {
    canal.mutar(root, (lineas, cc) => {
      id = canal.siguienteId(cc.limpias.join(String.fromCharCode(10)), 'D');
      const bl = [`### [${id}] ${titulo}`, `Tipo: ${clase === 'tarea' ? 'TABLERO' : 'DUEÑO'} · Estado: ${cerrada ? 'EJECUTADA' : 'ABIERTA'} · ${canal.sello()}`];
      poner(bl, 'clase', clase);
      poner(bl, 'codigo', aplanar(c.codigo, 30));
      poner(bl, 'prioridad', prio);
      poner(bl, 'responsable', resp);
      if (!cerrada) poner(bl, 'fase', FASE_DE[estadoT] || '');
      poner(bl, 'limite', f.valor);
      poner(bl, 'etiquetas', limpiarEtiquetas(c.etiquetas).join(', '));
      poner(bl, 'origen', origen);
      poner(bl, 'detalle', aplanar(c.detalle, MAX_TEXTO));
      if (opsTxt) bl.push('Opciones: ' + opsTxt);
      if (recom) bl.push('Recomendación: ' + recom);
      if (c.impacto) bl.push('Impacto: ' + aplanar(c.impacto, MAX_TEXTO));
      if (c.por_que) bl.push('Porque: ' + aplanar(c.por_que, MAX_TEXTO));
      const tabla = { Creó: clase === 'decision' ? 'la decisión' : (clase === 'permiso' ? 'la aprobación' : 'la tarea') };
      reescribirCola(bl, {
        respuesta: null, ejecucion: cerrada ? { sello: canal.sello(), texto: 'Registrada ya resuelta desde el tablero' } : null, cola: '',
        actividad: [{ t: ahoraISO(), por: porQuien, texto: 'Creó ' + tabla.Creó }],
      });
      let L = canal.__asegurar(lineas.slice(), 'decisiones', 'Decisiones del Director y del dueño'); L = canal.__quitarPlaceholder(L, 'decisiones');
      const fin = canal.__finSeccion(L, 'decisiones'); L.splice(fin, 0, '', ...bl); return L;
    });
  } catch (e) { return err(e.code || 'ERROR', String(e.message || e).slice(0, 200)); }
  return { ok: true, id };
}

const FRASES_NOTA = /^(Nota|Aceptó la recomendación): /;

/**
 * Cambia un elemento del tablero. `cambios`: estado, prioridad, responsable, fecha_limite, respuesta, respuesta_opcion, nota.
 * Las reglas del ciclo las pone el servidor, no la página: una decisión no se resuelve sin respuesta, una respondida no se pisa,
 * y reabrir deja la respuesta anterior en el historial. Devuelve { ok, id, eventos[] } (los eventos son lo que debe llegar a un modelo).
 */
function cambiar(root, id, cambios, { por, responsables } = {}) {
  const idl = validarId(id);
  if (!idl) return err('ID_INVALIDO', 'El id no es válido');
  const c = cambios && typeof cambios === 'object' ? cambios : {};
  if (c.estado != null && !ESTADOS_TABLERO.includes(String(c.estado))) return err('ESTADO_INVALIDO', 'Estado no válido');
  if (c.prioridad != null && !PRIORIDADES.includes(String(c.prioridad))) return err('PRIORIDAD_INVALIDA', 'Prioridad no válida');
  let fecha = null;
  if ('fecha_limite' in c) { fecha = validarFecha(c.fecha_limite); if (!fecha.ok) return err('FECHA_INVALIDA', 'La fecha límite no es válida (AAAA-MM-DD)'); }
  const resp = c.responsable != null ? aplanar(c.responsable, 60) : null;
  if (resp != null && (!resp || (responsables && !responsables.includes(resp)))) return err('RESPONSABLE_INVALIDO', 'Ese responsable no existe en el tablero');
  const nota = c.nota != null ? aplanar(c.nota, MAX_TEXTO) : '';
  const respuesta = c.respuesta != null ? aplanar(c.respuesta, MAX_TEXTO) : '';
  const porQuien = porSeguro(por);

  return editar(root, idl, (bl, a) => {
    const eventos = []; const acts = []; let cambio = false;
    const actual = estadoTablero(a);
    let cola = a.cola; let respuestaViva = a.respuesta ? { sello: a.respondida_en || canal.sello(), texto: a.respuesta, via: a.via, elegida: a.elegida } : null;
    let ejecucionViva = a.ejecucion ? { sello: a.ejecutada_en || canal.sello(), texto: a.ejecucion } : null;

    if (resp != null && resp !== a.responsable) {
      poner(bl, 'responsable', resp); acts.push('Responsable: ' + resp); cambio = true; eventos.push({ tipo: 'asignada', de: a.responsable, a: resp });
    }
    if (c.prioridad != null && c.prioridad !== a.prioridad) { poner(bl, 'prioridad', c.prioridad); acts.push('Prioridad: ' + c.prioridad); cambio = true; }
    if (fecha && fecha.valor !== (a.limite || '')) { poner(bl, 'limite', fecha.valor); acts.push(fecha.valor ? 'Fecha límite: ' + fecha.valor.split('-').reverse().join('/') : 'Quitó la fecha límite'); cambio = true; }
    if (nota) { acts.push('Nota: ' + nota); cambio = true; eventos.push({ tipo: 'nota', texto: nota }); }

    const destino = c.estado != null ? String(c.estado) : actual;
    if (destino === 'resuelta' && respuesta && a.clase !== 'tarea' && a.estado !== 'pendiente') return err('YA_RESPONDIDA', idl + ' ya está ' + (a.estado === 'respondida' ? 'respondida' : 'ejecutada') + ': no se pisa la respuesta');
    if (destino !== actual) {
      if (destino === 'resuelta') {
        if (a.clase === 'tarea') {
          ponerEstado(bl, 'EJECUTADA'); poner(bl, 'fase', '');
          ejecucionViva = { sello: canal.sello(), texto: respuesta || nota || 'Marcada hecha desde el tablero' };
          acts.push('Marcó hecha' + (respuesta ? ': ' + respuesta : '')); cambio = true; eventos.push({ tipo: 'hecha', por: porQuien });
        } else if (a.estado !== 'pendiente') {
          // ya estaba respondida/ejecutada: nada que pisar
        } else {
          if (!respuesta) return err('RESPUESTA_REQUERIDA', 'Una decisión se resuelve respondiéndola: elige una opción o escribe tu respuesta');
          let clave = '';
          if (c.respuesta_opcion != null && c.respuesta_opcion !== '') {
            clave = aplanar(c.respuesta_opcion, 60);
            if (a.opciones.length && !a.opciones.includes(clave)) return err('OPCION_INVALIDA', 'Esa opción no es una de las de la decisión');
          }
          ponerEstado(bl, 'DECIDIDA'); poner(bl, 'fase', '');
          respuestaViva = { sello: canal.sello(), texto: respuesta, via: porQuien, elegida: clave };
          const textoAct = aplanar(c.actividad_texto, 600);
          acts.push(/^Aceptó la recomendación: /.test(textoAct) ? textoAct : 'Respondió: ' + respuesta); cambio = true;
          eventos.push({ tipo: 'respondida', respuesta, opcion: clave });
        }
      } else {
        // mover a pendiente / en curso / esperando (reabre si estaba resuelta)
        if (a.estado !== 'pendiente') {
          const previa = a.estado === 'respondida' ? (a.respuesta || '') : (a.ejecucion || a.respuesta || '');
          const aviso = a.estado === 'respondida' ? 'Reabierta antes de ejecutarse' : 'Reabierta';
          acts.push(aviso + (previa ? ' (respuesta anterior: ' + previa.slice(0, 200) + ')' : ''));
          ponerEstado(bl, 'ABIERTA'); respuestaViva = null; ejecucionViva = null;
          eventos.push({ tipo: 'reabierta', habiaRespuesta: a.estado === 'respondida', respuestaAnterior: previa });
        }
        poner(bl, 'fase', FASE_DE[destino] || '');
        acts.push('Movió a «' + ({ pendiente: 'Pendiente', en_curso: 'En curso', esperando: 'Esperando a otro' }[destino]) + '»'); cambio = true;
        eventos.push({ tipo: 'estado', a: destino });
      }
    }
    if (!cambio) return { ok: true, id: idl, eventos: [], sinCambios: true };
    const base = a.actividad.concat(acts.map((t) => ({ t: ahoraISO(), por: porQuien, texto: t })));
    reescribirCola(bl, { respuesta: respuestaViva, ejecucion: ejecucionViva, cola, actividad: base });
    return { ok: true, id: idl, eventos };
  });
}

/** Ata una tarea del tablero a la tarea de la cola de Teams que la ejecuta (T-014). */
function ligarCola(root, id, tareaId) {
  return editar(root, validarId(id) || id, (bl, a) => {
    const act = a.actividad.concat([{ t: ahoraISO(), por: 'agentix', texto: 'Encolada como ' + tareaId + ' para el constructor' }]);
    reescribirCola(bl, { respuesta: a.respuesta ? { sello: a.respondida_en || canal.sello(), texto: a.respuesta, via: a.via, elegida: a.elegida } : null, ejecucion: a.ejecucion ? { sello: a.ejecutada_en || canal.sello(), texto: a.ejecucion } : null, cola: aplanar(tareaId, 20), actividad: act });
    return { ok: true };
  });
}

module.exports = {
  leer, responder, aplicada, pendientesDeEjecutar, avisoParaModelo, aplanar, OTRA,
  crear, cambiar, ligarCola, estadoTablero, parsear, parsearOpciones, claveRecomendada, aISO,
  CLASES, PRIORIDADES, ESTADOS_TABLERO, FRASES_NOTA, MAX_TEXTO,
};

if (require.main === module) {
  const root = process.cwd();
  const [cmd, ...resto] = process.argv.slice(2);
  const opt = {}; const arg = [];
  for (const a of resto) { const m = /^--([^=]+)(?:=([\s\S]*))?$/.exec(a); if (m) opt[m[1]] = m[2] === undefined ? true : m[2]; else arg.push(a); }
  const say = (s) => process.stdout.write(s + '\n');
  if (cmd === 'listar' || !cmd) {
    const l = leer(root, { todo: true });
    const filtro = opt.pendientes ? 'pendiente' : opt.respondidas ? 'respondida' : opt.ejecutadas ? 'ejecutada' : null;
    let items = filtro ? l.items.filter((x) => x.estado === filtro) : l.items;
    if (opt.asignadas && opt.asignadas !== true) {
      const rol = String(opt.asignadas).toLowerCase();
      const de = (n) => /^(director|claude|code)/i.test(n || '') ? 'director' : (/^(cursor|constructor|builder)/i.test(n || '') ? 'builder' : null);
      items = items.filter((x) => x.estado === 'pendiente' && de(x.responsable) === (rol === 'cursor' ? 'builder' : rol));
    }
    if (opt.json) say(JSON.stringify({ canal: l.canal, resumen: l.resumen, items }, null, 2));
    else {
      say(`Decisiones del dueño: ${l.resumen.pendientes} pendiente(s) · ${l.resumen.respondidas} respondida(s) sin ejecutar · ${l.resumen.ejecutadas} ejecutada(s)${l.canal ? '' : ' (sin canal TEAMS: «teams: activar»)'}`);
      for (const x of items) say(`  ${x.id} [${estadoTablero(x)}${x.estado === 'respondida' ? ', por ejecutar' : ''}] ${x.titulo}${x.responsable ? ' · ' + x.responsable : ''}${x.respuesta ? ' → ' + x.respuesta : ''}`);
    }
  } else if (cmd === 'responder') {
    const r = responder(root, arg[0], { opcion: opt.opcion === true ? '' : opt.opcion, texto: opt.texto === true ? '' : opt.texto, porque: opt.porque === true ? '' : opt.porque, via: 'cli' });
    say(r.ok ? `✔ ${r.id} respondida: ${r.respuesta}` : `✖ ${r.code}: ${r.message}`); process.exitCode = r.ok ? 0 : 1;
  } else if (cmd === 'aplicada') {
    const r = aplicada(root, arg[0], arg.slice(1).join(' '), { por: opt.rol === 'builder' ? 'cursor' : 'director' });
    say(r.ok ? `✔ ${r.id} ejecutada${r.ya ? ' (ya lo estaba)' : ''}` : `✖ ${r.code}: ${r.message}`); process.exitCode = r.ok ? 0 : 1;
  } else if (cmd === 'pendientes-de-ejecutar') {
    const p = pendientesDeEjecutar(root);
    say(p.length ? p.map((x) => `${x.id} → ${x.respuesta}`).join('\n') : 'Nada por ejecutar.');
  } else if (['mover', 'nota', 'asignar', 'crear', 'config'].includes(cmd)) {
    const tablero = require('./tablero.cjs');
    const r = tablero.comando(root, cmd, arg, opt);
    say(r.ok ? '✔ ' + r.mensaje : `✖ ${r.code}: ${r.message}`); process.exitCode = r.ok ? 0 : 1;
  } else { say('Uso: decisiones.cjs listar|responder|aplicada|pendientes-de-ejecutar|mover|nota|asignar|crear|config'); process.exitCode = 2; }
}
