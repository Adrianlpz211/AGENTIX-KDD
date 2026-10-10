#!/usr/bin/env node
'use strict';
/**
 * TEAMS v4 — Claude Code dirige, Cursor construye, un solo canal MD. `akdd teams …` y `teams: …` en el chat.
 *
 * Es el protocolo manual del dueño (carpeta «Protocolo-TEAMS») hecho comando, conectado al núcleo de Agentix.
 * Diseño: Agentix OBSERVA y ayuda, no manda. No hay máquina de estados, ni compuertas, ni fencing: el avance lo
 * decide el Director en el canal, y nada de lo que se mide aquí lo frena (la auditoría nunca gatea el avance).
 *
 *   FLUJO DEL DUEÑO:  activar → modo completo|individual → plan → (en Cursor) constructor → iniciar → pausa / continuar
 *   activar | init            modo completo|individual [--extra="nombre: enfoque"]      plan "resumen" [--docs=a,b]
 *   constructor (Cursor)      iniciar                       pausa                       continuar [--rol=builder|director]
 *   estado [--json]            ronda --rol=builder|director [--cierre]        revisar  (= ronda --rol=director)
 *   tarea "t" [--criterio=…]   corregir "t" [--sev=] [--archivo=] [--tarea=]  resolver C-001 "qué se hizo"
 *   reportar T-001 --estado=HECHO|PARCIAL|NO_HECHO --detalle=… [--verif=] [--archivos=]
 *   auditar T-001              cancelar T-001 "motivo"   aceptar T-001 [--verifico=] [--tests=N] [--aprendizaje="…" [--tipo=decision|patron|error]]        observar
 *   decision "p" --tipo=director|dueno …      decidir D-001 "decisión"       heredar
 *   reporte                    avance                                          cerrar [--forzar] | reabrir
 *   esperar --rol=… [--despertar]   comprobar   prompt director|builder|individual [--guardar]
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const canal = require('./teams-canal.cjs');
const reg = require('./teams-registro.cjs');
const P = require('./teams-prompts.cjs');

const SONDEO_MS = 10000;
const MAX_ESPERA_MS = 105 * 60 * 1000;
const OCIOSO_MS = 6 * 60 * 1000;
const OCIO_RONDAS = 3;          // rondas seguidas SIN nada que hacer (~9 min con el loop de 3 min) → el constructor le pide trabajo al Director
const OCIO_RONDAS_CON_PENDIENTE = 8;  // con pendientes que no se mueven (sin reportar ni resolver nada) esperamos más antes de preguntar
const DORMIDO_MS = 10 * 60 * 1000;    // el constructor tiene trabajo, su vigilante está muerto y no hace rondas desde hace tanto → se lo decimos al Director (y por él, al dueño)
const OCIO_ARCHIVOS_MS = 8 * 60 * 1000;   // pendientes + ningún archivo tocado en este tiempo = no está trabajando: se pregunta a las 3 rondas, no a las 8
const OCIO_ESPACIO_MS = 90 * 1000;     // dos llamadas a `ronda` pegadas (ronda + ronda --cierre) cuentan como UNA ronda
const REPETIR_MS = 10 * 60 * 1000; // un aviso de «nadie tiene nada» se repite cada tanto mientras siga igual
const PARCIAL_MS = 10 * 60 * 1000; // un PARCIAL sin avance pasa a ser decisión del Director
const LOOP_MS = Number(process.env.AKDD_TEAMS_LOOP_MS) || 3 * 60 * 1000;     // cadencia del loop de respaldo; una ronda más espaciada que ~2 ciclos = el loop no está activo
const REVISION_MS = 8 * 60 * 1000; // una entrega sin revisar se recuerda al Director cada tanto

// ───────────────────────────── utilidades ───────────────────────────────────

function parseArgs(argv) {
  const opt = {}; const libres = [];
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/s.exec(a);
    if (!m) { libres.push(a); continue; }
    const v = m[2] === undefined ? true : m[2];
    if (opt[m[1]] === undefined) opt[m[1]] = v; else opt[m[1]] = [].concat(opt[m[1]], v);
  }
  return { opt, libres };
}
const VIEJO_CMD = /teams-watch|teams-md-session|teams-vigilancia/;

/** Procesos del motor TEAMS anterior que siguen vivos EN ESTE proyecto (siguen reescribiendo el canal con su formato). */
function procesosViejos(root) {
  const out = [];
  try {
    const fragmento = path.resolve(root).toLowerCase().replace(/\\/g, '/');
    let filas = [];
    if (process.platform === 'win32') {
      const r = spawnSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { '{0}|{1}' -f $_.ProcessId, $_.CommandLine }"], { encoding: 'utf8', timeout: 20000, windowsHide: true });
      filas = String(r.stdout || '').split(/\r?\n/).filter(Boolean);
    } else {
      const r = spawnSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8', timeout: 20000 });
      filas = String(r.stdout || '').split(/\r?\n/).map((l) => l.trim().replace(/^(\d+)\s+/, '$1|'));
    }
    for (const l of filas) {
      const i = l.indexOf('|'); if (i < 0) continue;
      const pid = Number(l.slice(0, i)); const cmd = l.slice(i + 1);
      if (pid && pid !== process.pid && VIEJO_CMD.test(cmd) && cmd.toLowerCase().replace(/\\/g, '/').includes(fragmento)) out.push({ pid, cmd: cmd.slice(0, 200) });
    }
  } catch { /* sin lista de procesos: no se puede comprobar */ }
  return out;
}

/** Un canal escrito por el motor anterior (vista generada, sobres AKDD-TEAMS) no se adopta: se archiva y se empieza limpio. */
const esCanalViejo = (txt) => /Vista generada por akdd teams|<<<AKDD-TEAMS v1|^## 2\. Control de campaña/m.test(String(txt));

/** Brief previo de Agentix para una tarea: corre el context-enricher del proyecto (el de `aa:`). null si no hay o falla. */
function briefAgentix(root, texto) {
  try {
    const script = path.join(root, '.agentic', 'grafo', 'context-enricher.cjs');
    if (!fs.existsSync(script)) return null;
    const r = spawnSync(process.execPath, [script, String(texto).slice(0, 600)], { cwd: root, encoding: 'utf8', timeout: 45000, windowsHide: true });
    if (r.status !== 0) return null;
    const out = String(r.stdout || '');
    const riesgo = (/Riesgo estimado:\*{0,2}\s*(\w+)/i.exec(out) || [])[1] || null;
    const lineas = out.split(/\r?\n/).filter((l) => /^\s*-\s+\S/.test(l)).filter((l) => !/Grafo al día/.test(l)).slice(0, 12)
      .map((l) => l.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim().slice(0, 230));
    return { riesgo, lineas };
  } catch { return null; }
}

/** ¿Hay un vigilante vivo de este rol? (su archivo + proceso vivo + latido reciente). */
function vigilanteVivo(root, rol) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(canal.dirEstado(root), 'vigilantes', rol + '.json'), 'utf8'));
    process.kill(v.pid, 0);
    return Date.now() - Date.parse(v.latido) < Math.max(60000, (v.sondeo_s || 10) * 4000);
  } catch { return false; }
}

/** Valor de texto de una opción; ojo: `opt.constructor` heredado de Object NO es una opción. */
const nombreOpt = (opt, k, d) => (Object.prototype.hasOwnProperty.call(opt, k) && typeof opt[k] === 'string' && opt[k] ? opt[k] : d);
const lista = (v) => (v === undefined || v === true ? [] : [].concat(v).map(String));

const estadoPath = (root) => path.join(canal.dirEstado(root), 'estado.json');
function leerEstado(root) { try { return JSON.parse(fs.readFileSync(estadoPath(root), 'utf8')); } catch { return { seen: {}, wakes: [], aceptaciones: [], nivel: 'normal' }; } }
function guardarEstado(root, e) {
  fs.mkdirSync(path.dirname(estadoPath(root)), { recursive: true });
  const tmp = estadoPath(root) + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(e, null, 2)); canal.renombrarConReintento(tmp, estadoPath(root));
}
const iso = () => new Date().toISOString();
const corto = (s, n = 160) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

// ───────────────────────────── cálculo del estado ───────────────────────────

const ESTADOS_DEVUELTA = new Set(['NO_HECHO', 'BLOQUEADO']);

function aceptacionesDetalle(c) {
  const out = {};
  const s = c.secciones.auditoria;
  if (!s) return out;
  for (let i = s.ini + 1; i < s.fin; i++) {
    const l = c.limpias[i];
    if (!canal.ACEPTADA.test(l)) continue;
    const f = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/.exec(l);
    const t = /tests?:\s*(\d+)/i.exec(l);
    for (const m of l.matchAll(/\b(T-[\w.]+)\b/g)) out[m[1]] = { fecha: f ? f[1] : '', tests: t ? Number(t[1]) : 0, linea: l.trim() };
  }
  return out;
}

function calcular(root, opts = {}) {
  let c = canal.leer(root);
  if (!c) return null;
  // Escritura pisada (medinet, 2 veces): una tarea quedó en el estado de TEAMS pero no en el archivo del canal porque el editor del
  // constructor guardó una copia vieja encima. Si la última escritura de Agentix tenía un bloque que ahora falta, se repone.
  let recuperados = [];
  if (!opts.sinRecuperar && c.estado === 'ACTIVO') {
    recuperados = canal.recuperarPerdidos(root);
    if (recuperados.length) { registrarEvento(root, { rol: 'sistema', cmd: 'CANAL_RECUPERADO', objetivo: recuperados.join(',') }); c = canal.leer(root) || c; }
  }
  const ahora = opts.ahora || Date.now();
  const rep = canal.reportes(c);
  const acept = canal.aceptadas(c);
  const detAcept = aceptacionesDetalle(c);

  const correcciones = canal.elementos(c, 'correcciones').map((e) => ({ ...e, sev: canal.severidad(e.titulo), detalle: canal.detalleResuelto(e.texto) }));
  const tareas = canal.elementos(c, 'tareas').map((t) => {
    const r = rep[t.id] || null;
    const completa = t.casillas.total > 0 && t.casillas.hechas === t.casillas.total;
    const hechaBuilder = t.hecho || completa || (r && r.estado === 'HECHO');
    let estado = 'PENDIENTE';
    if (t.cancelada) estado = 'CANCELADA';
    else if (t.heredada) estado = 'HEREDADA';
    else if (acept.has(t.id)) estado = 'ACEPTADA';
    else if (r && ESTADOS_DEVUELTA.has(r.estado) && !completa) estado = 'DEVUELTA';
    // PARCIAL que lleva > PARCIAL_MS sin un reporte nuevo: casi siempre está bloqueado por algo que el constructor no puede resolver
    // (entorno, credenciales, una decisión). Medido en glowly: dos tareas PARCIAL por Docker caído dejaron al constructor ocioso
    // una hora y el Director sin enterarse. Pasa a «devuelta»: el Director decide (aceptar así, reformular, desbloquear, cancelar).
    // Pero si el constructor SIGUE tocando archivos (menos de PARCIAL_MS), no está bloqueado: está trabajando esa misma tarea (H-006, glowly 05/10/2026).
    else if (r && r.estado === 'PARCIAL' && !completa && r.at && (ahora - r.at) > (opts.parcialMs || PARCIAL_MS) && !trabajoReciente(root, opts.parcialMs || PARCIAL_MS)) estado = 'DEVUELTA';
    else if (hechaBuilder) estado = 'HECHA_SIN_ACEPTAR';
    const estancada = estado === 'DEVUELTA' && r && r.estado === 'PARCIAL';
    return { ...t, estado, reporte: r, completa, estancada, aceptacion: detAcept[t.id] || null };
  });

  const omisiones = [];
  for (const t of tareas) {
    if (t.generado || ['CANCELADA', 'HEREDADA', 'ACEPTADA'].includes(t.estado)) continue; // aceptada: el Director ya la contrastó
    const r = t.reporte;
    if ((t.completa || t.hecho) && !r) omisiones.push({ codigo: 'SIN_REPORTE', id: t.id, texto: `${t.id} tiene todas sus casillas marcadas pero no hay línea de reporte para ella` });
    if (r && r.estado === 'HECHO' && t.casillas.total > 0 && !t.completa) omisiones.push({ codigo: 'HECHO_CON_CASILLAS_ABIERTAS', id: t.id, texto: `${t.id} reportada HECHO pero quedan ${t.casillas.total - t.casillas.hechas} casilla(s) sin marcar` });
    if (r && ['PARCIAL', 'NO_HECHO', 'BLOQUEADO'].includes(r.estado) && corto(r.detalle).length < 8) omisiones.push({ codigo: 'SIN_MOTIVO', id: t.id, texto: `${t.id} reportada ${r.estado} sin decir qué falta ni por qué` });
    if (r && !r.estado && !t.completa && t.estado !== 'ACEPTADA') omisiones.push({ codigo: 'REPORTE_SIN_ESTADO', id: t.id, texto: `${t.id} se menciona en el reporte sin estado (HECHO / PARCIAL / NO_HECHO)` });
  }
  for (const k of correcciones) if (k.resuelto && corto(k.detalle).length < 3) omisiones.push({ codigo: 'RESUELTO_SIN_DETALLE', id: k.id, texto: `${k.id} marcada RESUELTA sin decir qué se hizo` });

  const decisiones = canal.elementos(c, 'decisiones').map((d) => {
    const tipo = /Tipo:\s*(DIRECTOR|DUE[ÑN]O)/i.exec(d.texto);
    const dueno = tipo ? /DUE/i.test(tipo[1]) : false;
    const abierta = /Estado:\s*ABIERTA/i.test(d.texto) || (dueno && !/Estado:\s*DECIDIDA/i.test(d.texto) && !/Decisi[óo]n del due[ñn]o/i.test(d.texto));
    const solicitud = !dueno && /Origen:\s*CONSTRUCTOR/i.test(d.texto);
    return { ...d, dueno, abierta, solicitud };
  });

  const corrPend = correcciones.filter((k) => !k.resuelto);
  const tareasPend = tareas.filter((t) => t.estado === 'PENDIENTE');
  const hechasSinAceptar = tareas.filter((t) => t.estado === 'HECHA_SIN_ACEPTAR');
  const devueltas = tareas.filter((t) => t.estado === 'DEVUELTA');
  const aceptadasN = tareas.filter((t) => t.estado === 'ACEPTADA').length;
  const vivas = tareas.filter((t) => t.estado !== 'CANCELADA' && t.estado !== 'HEREDADA').length;
  const constructorSinTrabajo = !corrPend.length && !tareasPend.length;
  const listo = vivas > 0 && constructorSinTrabajo && !hechasSinAceptar.length && !devueltas.length;
  let mtime = 0; try { mtime = fs.statSync(c.ruta).mtimeMs; } catch { /* sin mtime */ }
  const ocioso = constructorSinTrabajo && !listo && (ahora - mtime) > (opts.ociosoMs || OCIOSO_MS);

  return {
    c, root, canal: c.estado, mecanica: c.mecanica, ahora, mtime,
    rondas: (() => { try { return leerEstado(root).rondas || {}; } catch { return {}; } })(), modo: (() => { try { return leerEstado(root).modo || null; } catch { return null; } })(),
    correcciones, corrPend, tareas, tareasPend, hechasSinAceptar, devueltas, omisiones, decisiones,
    solicitudes: decisiones.filter((d) => d.solicitud && d.abierta), decisionesDueno: decisiones.filter((d) => d.dueno && d.abierta), decididasDueno: decisiones.filter((d) => d.dueno && !d.abierta && !/Estado:\s*EJECUTADA/i.test(d.texto)),
    aceptadas: aceptadasN, total: vivas, avance: vivas ? Math.round((aceptadasN / vivas) * 100) : null,
    constructorSinTrabajo, listo, ocioso, recuperados,
    ...segmentosYFin({ tareas, corrPend, omisiones, decisiones, hechasSinAceptar, tareasPend, devueltas, ahora, root, parcialMs: opts.parcialMs || PARCIAL_MS }),
  };
}

/**
 * La barra de avance en 4 tramos (vale igual con TEAMS que en modo individual: son las mismas tareas del canal):
 *   verde    terminadas y aceptadas
 *   azul     en curso (el constructor las está haciendo, o entregadas esperando la aceptación)
 *   naranja  parciales: les faltan cosas y quedan pendientes (devueltas, estancadas, bloqueadas por una decisión del dueño)
 *   rojo     lo que falta: todavía sin empezar
 * Y el estado de FIN. Solo se declara fin tras RECORRER todo: ninguna tarea sin hacer, nada por revisar, ninguna corrección ni omisión.
 * Que haya una decisión del dueño sin responder o una parcial NO frena el recorrido de las demás (no se para en la primera):
 * se anotan y se sigue; solo cuando ya no queda nada accionable se declara el fin.
 *   TERMINADO     todo verde y sin decisiones abiertas
 *   ESPERA_DUENO  solo quedan parciales / decisiones que dependen del dueño
 */
function segmentosYFin({ tareas, corrPend, omisiones, decisiones, hechasSinAceptar, tareasPend, devueltas, ahora, root, parcialMs }) {
  const vivas = tareas.filter((t) => t.estado !== 'CANCELADA' && t.estado !== 'HEREDADA');
  const verde = vivas.filter((t) => t.estado === 'ACEPTADA').length;
  const naranja = vivas.filter((t) => t.estado === 'DEVUELTA').length;
  // Una pendiente con reporte PARCIAL reciente, o con casillas ya marcadas, la está haciendo el constructor ahora mismo: azul.
  const enCurso = (t) => t.estado === 'HECHA_SIN_ACEPTAR' || (t.estado === 'PENDIENTE' && ((t.reporte && t.reporte.estado === 'PARCIAL') || (t.casillas && t.casillas.hechas > 0)));
  const azul = vivas.filter(enCurso).length;
  const rojo = vivas.filter((t) => t.estado === 'PENDIENTE' && !enCurso(t)).length;
  const total = vivas.length;
  const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
  const decAbiertas = decisiones.filter((d) => d.dueno && d.abierta).length;
  const recorrido = total > 0 && !tareasPend.length && !hechasSinAceptar.length && !corrPend.length && !omisiones.length;
  let fin = null;
  if (recorrido && !naranja && !decAbiertas) fin = 'TERMINADO';
  else if (recorrido && (naranja || decAbiertas)) fin = 'ESPERA_DUENO';
  return { segmentos: { verde, azul, naranja, rojo, total, pct: { verde: pct(verde), azul: pct(azul), naranja: pct(naranja), rojo: pct(rojo) } }, fin };
}

/** Qué le toca a cada rol, y su huella: si la huella no cambió desde la última ronda que el rol hizo, no hay despertar. */
function puenteTelefono() { try { return require('./ntfy-bridge.cjs'); } catch { return null; } }
function buzonDelDueno() { try { return require('./buzon.cjs'); } catch { return null; } }
/** Mensajes del dueño (ntfy / Telegram) sin leer para un rol, como razones de despertar. En modo individual el Director también atiende los del constructor. */
function razonesDeBuzon(e, rol, razones, claves) {
  const B = buzonDelDueno(); if (!B) return;
  const roles = rol === 'director' && (leerEstado(e.root).modo === 'individual') ? ['director', 'builder'] : [rol];
  const vistos = new Set();
  for (const r of roles) for (const m of B.sinLeer(e.root, r)) {
    if (vistos.has(m.id)) continue; vistos.add(m.id);
    if (vistos.size > 5) break;
    razones.push('MENSAJE DEL DUEÑO desde ' + (m.canal === 'telegram' ? 'Telegram' : 'el teléfono') + ' [' + m.id + ']' + (m.para === 'builder' ? ' (para el constructor)' : '') + ': «' + corto(m.texto, 300) + '» — es una indicación del dueño por un canal protegido con secreto: léela y actúa; lo destructivo o sensible se confirma en el chat. Márcala leída: `node .agentic/grafo/buzon.cjs leer ' + m.id + '` y, al atenderla, responde: `node .agentic/grafo/buzon.cjs responder ' + m.id + ' "qué hiciste"` (le llega por donde escribió)');
    claves.push('M:' + m.id);
  }
}

function accionable(e, rol) {
  const razones = []; const claves = [];
  if (e.canal !== 'ACTIVO') return { razones, digest: '' }; // preparado, pausado o cerrado: nadie es despertado
  if (rol === 'builder') {
    for (const k of e.corrPend) { razones.push(`CORRECCION ${k.id} (${k.sev}): ${corto(k.titulo, 110)}`); claves.push('C:' + k.id + ':' + canal.sha(k.texto).slice(0, 8)); }
    for (const t of e.tareasPend) { razones.push(`TAREA ${t.id}: ${corto(t.titulo, 110)}`); claves.push('T:' + t.id + ':' + canal.sha(t.texto).slice(0, 8)); }
    for (const o of e.omisiones) { razones.push(`OMISION ${o.codigo}: ${o.texto}`); claves.push('O:' + o.codigo + ':' + o.id); }
    razonesDeBuzon(e, 'builder', razones, claves);
  } else {
    // Fin del recorrido: el Director se entera UNA vez (la huella no cambia mientras el estado sea el mismo) y no inventa trabajo.
    if (e.fin === 'TERMINADO') { razones.push('TODO VERDE: las ' + e.segmentos.total + ' tareas están aceptadas y no queda ninguna decisión abierta — corre `cerrar` (reporte final al dueño); los vigilantes terminan solos'); claves.push('F:TERMINADO'); }
    else if (e.fin === 'ESPERA_DUENO') { razones.push('RECORRIDO COMPLETO: ya se hizo todo lo que no depende del dueño (' + e.segmentos.verde + ' verdes de ' + e.segmentos.total + '). Quedan ' + e.decisionesDueno.length + ' decisión(es) del dueño y ' + e.segmentos.naranja + ' parcial(es) — resúmeselo al dueño y detente: NO inventes trabajo; cuando responda, el vigilante te despierta'); claves.push('F:ESPERA:' + e.decisionesDueno.map((d) => d.id).join(',') + ':' + e.devueltas.map((t) => t.id).join(',')); }
    if (e.recuperados && e.recuperados.length) { razones.push(`CANAL PISADO: el archivo del canal perdió ${e.recuperados.join(', ')} (otro editor guardó una copia vieja encima); Agentix ya lo repuso — avísale al constructor que no guarde copias viejas del canal`); claves.push('P:' + e.recuperados.join(',')); }
    for (const t of e.hechasSinAceptar) {
      razones.push(`ENTREGA ${t.id} por revisar: ${corto(t.titulo, 90)}`); claves.push('E:' + t.id + ':' + canal.sha((t.reporte ? t.reporte.detalle + t.reporte.estado : '') + t.casillas.hechas).slice(0, 8));
      // Recordatorio: una entrega sin aceptar ni corregir NO se queda dormida. Cada REVISION_MS que pasa sin revisarla, el aviso se repite (huella nueva).
      const edad = t.reporte && t.reporte.at ? e.ahora - t.reporte.at : 0;
      if (edad >= REVISION_MS) { razones.push(`ENTREGA SIN REVISAR hace ${Math.round(edad / 60000)} min: ${t.id} — audítala (auditar ${t.id}) y acéptala o corrígela; el constructor no puede avanzar su cierre sin tu veredicto`); claves.push('R:' + t.id + ':' + Math.floor(edad / REVISION_MS)); }
    }
    for (const t of e.devueltas) { razones.push(t.estancada
        ? `PARCIAL ESTANCADA ${t.id} (sin avance hace ${Math.round((e.ahora - t.reporte.at) / 60000)} min): ${corto(t.reporte.detalle, 140)} — el constructor no puede avanzarla solo: decide (aceptarla así anotando lo que queda, desbloquear lo que falta, reformular o cancelar)`
        : `DEVUELTA ${t.id} (${t.reporte.estado}): ${corto(t.reporte.detalle, 100)} — decide: reformular, desbloquear o cancelar`); claves.push('V:' + t.id + ':' + canal.sha(t.reporte.detalle).slice(0, 8)); }
    for (const o of e.omisiones) { razones.push(`OMISION del constructor ${o.codigo}: ${o.texto}`); claves.push('O:' + o.codigo + ':' + o.id); }
    // El constructor tiene trabajo pero lleva rato sin rondas y sin vigilante: nadie lo va a despertar salvo el dueño (caso glowly, 05/10/2026).
    if (e.modo !== 'individual' && (e.corrPend.length || e.tareasPend.length || e.omisiones.length)) {
      const ultRonda = e.rondas && e.rondas.builder; const sinRonda = ultRonda ? e.ahora - ultRonda : 0;
      if (sinRonda > DORMIDO_MS && !vigilanteVivo(e.root, 'builder') && evidenciaConstructor(e.root, e).veredicto !== 'TRABAJANDO') { const min = Math.round(sinRonda / 60000); razones.push(`CONSTRUCTOR_DORMIDO: lleva ~${min} min sin hacer rondas, su vigilante NO está vivo y tiene trabajo esperando — probablemente Cursor se quedó parado. Díselo al dueño: solo él puede despertarlo escribiéndole en su chat (\`teams: continuar\`)`); claves.push('DORM:' + Math.floor(min / 10)); }
    }
    // Mensajes que el dueño dejó desde el teléfono (puente ntfy): son una indicación suya y el vigilante del Director se despierta con ellos.
    razonesDeBuzon(e, 'director', razones, claves);
    for (const d of e.solicitudes) { const evid = /Evidencia:\s*([^\n]+)/.exec(d.texto); razones.push(`SOLICITUD DEL CONSTRUCTOR ${d.id}: ${corto(d.titulo, 90)}${evid ? ' [' + corto(evid[1], 260) + ']' : ''} — está parado sin trabajo: encola el siguiente lote (\`tarea\`), cierra si todo está listo (\`cerrar\`) o dile qué esperar`); claves.push('S:' + d.id); }
    for (const d of e.decididasDueno) { razones.push(`DECISION DEL DUEÑO ${d.id} contestada: ${corto(d.titulo, 90)} — léela con: node .agentic/grafo/decisiones.cjs listar --respondidas · ejecútala y ciérrala con: node .agentic/grafo/decisiones.cjs aplicada ${d.id} "qué hiciste"`); claves.push('D:' + d.id); }
    // OCIOSO y LISTO se repiten cada REPETIR_MS mientras la condición persista: si el Director atiende el aviso y no actúa, no se acaba el aviso
    // (el caso «los dos esperando al otro» que dejó glowly parado).
    const quieto = Math.max(0, e.ahora - e.mtime);
    if (e.ocioso) { razones.push(`CONSTRUCTOR_OCIOSO: la cola está vacía y no hay correcciones (canal quieto ${Math.round(quieto / 60000)} min) — pon el siguiente lote, o decide cerrar`); claves.push('OCIOSO:' + Math.floor(quieto / REPETIR_MS)); }
    if (e.listo) { razones.push('LISTO_PARA_CERRAR: todo aceptado, sin correcciones y sin más lotes — ejecuta `cerrar` (publica el reporte final y detiene a los vigilantes)'); claves.push('LISTO:' + Math.floor(Math.max(0, e.ahora - e.mtime) / REPETIR_MS)); }
  }
  return { razones, digest: claves.length ? canal.sha(claves.sort().join('|')).slice(0, 16) : '' };
}

// ───────────────────── ocio del constructor: 3 rondas iguales → pide trabajo al Director ─────────────────────
// Caso real (glowly, 05/10/2026): el Director ya no tenía nada que revisar, el constructor repetía «el canal sigue sin tareas
// nuevas» ronda tras ronda y los dos se quedaron esperándose ~20 min hasta que el dueño intervino. Ahora el constructor, a la
// tercera ronda idéntica, deja una SOLICITUD en el canal; el vigilante del Director lo despierta con ella.
/* Carpetas que escriben las HERRAMIENTAS (el propio Agentix, Claude Code, Cursor, git, el editor), no el constructor. Caso medinet (10/10/2026): el temporizador
   de Claude Code movía `.claude/scheduled_tasks.lock` cada pocos minutos y eso hacía creer que Cursor «trabajaba» durante 41 h mientras estaba parado. */
const RUIDO_DE_HERRAMIENTAS = /^(\.agentic|\.legion|_output|\.claude|\.cursor|\.git|\.vscode|\.idea|\.next|\.turbo|node_modules)\//;
/** Último cambio en archivos del proyecto: { t, archivo } (t = 0 si no hay nada sin guardar en git); null = no se puede saber (sin git). */
function cambioReciente(root) {
  if (process.env.AKDD_TEAMS_ULTIMO_CAMBIO) { const t = Number(process.env.AKDD_TEAMS_ULTIMO_CAMBIO); return t ? { t, archivo: 'archivo de prueba' } : null; }
  try {
    if (!fs.existsSync(path.join(root, '.git'))) return null;
    const r = require('child_process').spawnSync('git', ['-c', 'safe.directory=*', 'status', '--porcelain', '-uall'], { cwd: root, encoding: 'utf8', timeout: 8000, maxBuffer: 16 * 1024 * 1024 });
    if (r.status !== 0) return null;
    let max = 0, quien = '';
    for (const l of String(r.stdout).split(String.fromCharCode(10))) {
      const p = l.slice(3).replace(/^"|"$/g, '').replace(/.* -> /, ''); if (!p || RUIDO_DE_HERRAMIENTAS.test(p)) continue;
      try { const m = fs.statSync(path.join(root, p)).mtimeMs; if (m > max) { max = m; quien = p; } } catch { /* borrado o ilegible */ }
    }
    return { t: max, archivo: quien };
  } catch { return null; }
}
/** ¿Se tocó algún archivo del proyecto en los últimos `ms`? Caché de 15 s: calcular() se llama mucho y git status no es gratis. Sin git: false. */
const _trabajoCache = new Map();
function trabajoReciente(root, ms) {
  const k = root, ahora = Date.now(), h = _trabajoCache.get(k);
  let c; if (h && ahora - h.en < 15000 && !process.env.AKDD_TEAMS_ULTIMO_CAMBIO) c = h.c; else { c = cambioReciente(root); _trabajoCache.set(k, { en: ahora, c }); }
  return !!(c && c.t && ahora - c.t < ms);
}
function ultimoCambioArchivos(root) { const c = cambioReciente(root); return c === null ? null : c.t; }

/** Lo que se puede comprobar en el disco sobre si el constructor trabaja: archivos tocados, reportes y rondas. Es lo que el Director hacía a mano. */
function evidenciaConstructor(root, e) {
  const ahora = Date.now(), c = cambioReciente(root);
  const ev = leerEventos(root, 400).filter((x) => x.rol === 'builder');
  const ult = (cmd) => { const x = ev.filter((y) => y.cmd === cmd).pop(); return x ? Date.parse(x.t) : null; };
  const rond = (e && e.rondas && e.rondas.builder) || ult('ronda'), rep = ult('reportar');
  const min = (t) => Math.max(0, Math.round((ahora - t) / 60000));
  const partes = [
    c === null ? 'sin git: no se puede ver si toca archivos' : c.t ? 'último archivo tocado hace ' + min(c.t) + ' min (' + corto(c.archivo, 60) + ')' : 'ningún archivo modificado sin guardar',
    rep ? 'último reporte suyo hace ' + min(rep) + ' min' : 'sin reportes suyos',
    rond ? 'última ronda hace ' + min(rond) + ' min' : 'sin rondas',
  ];
  const sinArchivos = c !== null && (!c.t || (ahora - c.t) >= OCIO_ARCHIVOS_MS), sinReporte = !rep || (ahora - rep) >= OCIO_ARCHIVOS_MS;
  const veredicto = c === null ? 'SIN_DATOS' : (sinArchivos && sinReporte ? 'PARADO' : 'TRABAJANDO');
  let empujon = null;
  const t = e && e.tareasPend && e.tareasPend[0], k = e && e.corrPend && e.corrPend[0];
  if (t) empujon = 'Continúa con ' + t.id + ': ' + corto(t.titulo, 90) + '. Después sigue con el resto de la cola. No te detengas a resumir: termina este turno con archivos tocados o con un reporte (si algo te frena, reportar --estado=BLOQUEADO).';
  else if (k) empujon = 'Resuelve ' + k.id + ' y márcala con resolver. No te detengas a resumir: termina este turno con archivos tocados o con un reporte.';
  return { texto: partes.join(' · '), veredicto, empujon };
}

function seguimientoOcio(root, e, est) {
  est.sinNovedad = est.sinNovedad || {}; const ahora = Date.now();
  const razones = accionable(e, 'builder').razones;
  const huella = canal.sha(razones.join('|') + '#' + e.hechasSinAceptar.map((t) => t.id).join(',')).slice(0, 12);
  const prevAt = (est.rondas && est.rondas.builder) || 0;
  const hizo = leerEventos(root, 300).some((ev) => ev.rol === 'builder' && ['reportar', 'resolver', 'decision'].includes(ev.cmd) && Date.parse(ev.t) > prevAt);
  const ultCambio = razones.length ? ultimoCambioArchivos(root) : null;
  const trabajando = ultCambio === null || (ahora - ultCambio) < OCIO_ARCHIVOS_MS;   // sin git no se puede saber: se asume trabajo
  const umbral = razones.length && trabajando ? OCIO_RONDAS_CON_PENDIENTE : OCIO_RONDAS;
  const evi = evidenciaConstructor(root, e);
  let s = est.sinNovedad.builder;
  if (s && s.pedido && (hizo || s.huella !== huella)) atenderSolicitudes(root, 'el constructor volvió a avanzar (reportó o cambió su cola)');
  if (!s || s.huella !== huella || hizo) { s = est.sinNovedad.builder = { huella, n: 1, desde: ahora, ultimo: ahora, pedido: null, umbral }; return { s, aviso: null }; }
  s.umbral = umbral; s.evidencia = evi.texto; s.veredicto = evi.veredicto; s.empujon = evi.empujon;
  if (ahora - s.ultimo >= OCIO_ESPACIO_MS) { s.n++; s.ultimo = ahora; }
  const min = Math.round((ahora - s.desde) / 60000);
  if (s.n === 2 && !trabajando && !s.avisoSilencio && e.tareasPend.length) {
    s.avisoSilencio = true; const t = e.tareasPend[0];
    return { s, aviso: `⚠ LLEVAS 2 RONDAS VIENDO ${t.id} SIN EMPEZARLA y no hay archivos tocados. NO esperes en silencio: si algo te frena (un gate, una duda, un archivo crítico, el orden, un permiso), repórtalo AHORA: \`${P.CMD} reportar ${t.id} --estado=BLOQUEADO --detalle="qué te frena y qué necesitas"\`. Si no hay nada que te frene, EMPIEZA ${t.id} ya. Una tarea parada sin reporte es lo único que el Director no puede ver.` };
  }
  if (s.n < umbral || e.listo) return { s, aviso: null };
  if (!s.pedido) {
    let id = '';
    canal.mutar(root, (lineas, c) => {
      id = canal.siguienteId(c.limpias.join(String.fromCharCode(10)), 'D');
      const b = [`### [${id}] Constructor sin trabajo hace ~${min} min (${s.n} rondas iguales)`, `Tipo: DIRECTOR · Estado: ABIERTA · Origen: CONSTRUCTOR · ${canal.sello()}`,
        razones.length ? `El constructor tiene ${razones.length} pendiente(s) que no avanzan desde hace ${s.n} rondas: ¿hay un bloqueo?` : 'El constructor no tiene tareas, correcciones ni omisiones y lleva ' + s.n + ' rondas con el mismo estado.',
        'Evidencia: ' + evi.texto + ' → ' + evi.veredicto + '.',
        'Director: encola el siguiente lote (`tarea`), cierra si todo está listo (`cerrar`) o dile qué esperar.'];
      let L = canal.__asegurar(lineas.slice(), 'decisiones', 'Decisiones del Director y del dueño'); L = canal.__quitarPlaceholder(L, 'decisiones');
      const fin = canal.__finSeccion(L, 'decisiones'); L.splice(fin, 0, '', ...b); return L;
    });
    s.pedido = id; s.pedido_at = ahora; s.evidencia = evi.texto; s.veredicto = evi.veredicto; s.empujon = evi.empujon;
    registrarEvento(root, { cmd: 'solicitud', rol: 'builder', arg: id });
    return { s, aviso: `⏱ LLEVAS ${s.n} RONDAS (~${min} min) SIN TRABAJO. Ya le pedí tareas al Director en ${id}: su vigilante lo despierta con eso. No esperes en silencio: mantén tu loop y atiende lo que llegue.` };
  }
  if (s.n >= umbral * 2 && !s.escalado) { s.escalado = true; return { s, aviso: `⏱ ${s.n} RONDAS (~${min} min) y el Director no respondió a ${s.pedido}. Díselo al dueño: el Director puede estar dormido y solo él puede despertarlo escribiéndole en su chat.` }; }
  return { s, aviso: null };
}

/** El Director encoló algo: las solicitudes abiertas del constructor quedan atendidas. */
function atenderSolicitudes(root, texto) {
  try {
    canal.mutar(root, (lineas, c) => {
      const abiertas = canal.elementos(c, 'decisiones').filter((d) => !/Tipo:\s*DUE/i.test(d.texto) && /Origen:\s*CONSTRUCTOR/i.test(d.texto) && /Estado:\s*ABIERTA/i.test(d.texto));
      if (!abiertas.length) return null;
      for (const d of abiertas.slice().reverse()) {
        for (let i = d.ini; i < d.fin; i++) lineas[i] = lineas[i].replace(/Estado:\s*ABIERTA/i, 'Estado: DECIDIDA');
        lineas.splice(d.fin, 0, `Atendida ${canal.sello()}: ${texto}`);
      }
      return lineas;
    });
  } catch { /* la solicitud es auxiliar */ }
}

// ───────────────────────────── salida de las rondas ─────────────────────────

function textoRondaBuilder(e) {
  const o = [];
  o.push(`RONDA builder — canal ${e.canal} · ${canal.sello()}`);
  if (e.canal === 'CERRADO') return o.concat(['CANAL CERRADO: no hay nada pendiente. No relances vigilantes; informa al dueño y detente.']).join('\n');
  if (e.canal === 'PAUSADO') return o.concat(['CANAL PAUSADO por el Director. NO trabajes, NO relances tu vigilante y CANCELA tu loop de respaldo (así no gastas tokens consultando).', 'Para volver: el dueño escribe `teams: continuar` en tu chat; entonces relanzas vigilante y loop.']).join('\n');
  if (e.canal === 'PREPARADO') return o.concat(['CANAL PREPARADO: el Director todavía no dio la orden de iniciar. Estás listo y a la espera: NO hay nada que construir aún.', 'Deja lanzado tu vigilante (`esperar --rol=builder --despertar`) y tu loop de respaldo; te despertarán cuando el Director escriba `teams: iniciar` y encole el primer lote.']).join('\n');
  if (e.corrPend.length) {
    o.push('', `CORRECCIONES PENDIENTES (${e.corrPend.length}) — prioridad absoluta, aunque estés a mitad de otra tarea:`);
    for (const k of e.corrPend) o.push('', k.crudo);
  }
  if (e.tareasPend.length) {
    o.push('', `TAREAS PENDIENTES (${e.tareasPend.length}):`);
    for (const t of e.tareasPend) o.push('', t.crudo);
  }
  if (e.omisiones.length) {
    o.push('', `OMISIONES TUYAS (${e.omisiones.length}) — corrígelas antes de cerrar la ronda:`);
    for (const x of e.omisiones) o.push(`  · [${x.codigo}] ${x.texto}`);
  }
  if (e.devueltas.length) {
    o.push('', `EN ESPERA DE DECISIÓN DEL DIRECTOR (${e.devueltas.length}) — NO las rehagas a ciegas; ya están en su mesa:`);
    for (const t of e.devueltas) o.push(`  · ${t.id} ${t.reporte ? t.reporte.estado : ''}: ${corto(t.reporte ? t.reporte.detalle : t.titulo, 120)}`);
  }
  if (!e.corrPend.length && !e.tareasPend.length && !e.omisiones.length) o.push('', e.devueltas.length ? 'Sin trabajo propio ahora: lo tuyo está esperando decisión del Director. NO inventes trabajo; tu vigilante te despertará cuando cambie algo.' : 'Nada nuevo. NO inventes trabajo: cierra la ronda.');
  return o.join('\n');
}

function textoRondaDirector(e) {
  const a = accionable(e, 'director');
  const o = [`REVISAR (director) — canal ${e.canal} · ${canal.sello()} · avance ${e.avance === null ? 'n/d' : e.avance + '%'} (${e.aceptadas}/${e.total} aceptadas)`];
  if (e.canal === 'CERRADO') return o.concat(['CANAL CERRADO. Nada que dirigir; los vigilantes deben haber terminado.']).join('\n');
  if (e.canal === 'PAUSADO') return o.concat(['CANAL PAUSADO. Nadie está trabajando ni consultando. Para seguir: `teams: continuar` (relanza tus vigilantes) y pídele al dueño que escriba `teams: continuar` en el chat del constructor.']).join('\n');
  if (e.canal === 'PREPARADO') return o.concat(['CANAL PREPARADO: aún no iniciado. Cuando tengas el plan asimilado y el constructor conectado, el dueño escribe `teams: iniciar`.']).join('\n');
  if (a.razones.length) { o.push('', 'LO QUE TE TOCA:'); for (const r of a.razones) o.push('  · ' + r); } else o.push('', 'Nada nuevo para ti. Tu trabajo ahora: ir 1–2 lotes por delante (investigar y encolar el siguiente).');
  if (e.corrPend.length) { o.push('', `Correcciones que el constructor aún no resuelve: ${e.corrPend.length} (${e.corrPend.map((k) => k.id).join(', ')}).`); }
  if (e.tareasPend.length) o.push(`En cola del constructor: ${e.tareasPend.length} tarea(s) (${e.tareasPend.map((t) => t.id).join(', ')}).`);
  if (e.decisionesDueno.length) o.push(`Decisiones abiertas del dueño: ${e.decisionesDueno.map((d) => d.id).join(', ')} (el trabajo independiente continúa).`);
  return o.join('\n');
}

// ───────────────────────────── continuidad / reporte ────────────────────────

function ritmo(root) {
  const a = leerEstado(root).aceptaciones || [];
  if (a.length < 3) return 'sin dato todavía (se calcula con 3 o más aceptaciones)';
  const t = a.map((x) => Date.parse(x.at)).filter(Number.isFinite).sort((x, y) => x - y);
  const gaps = []; for (let i = 1; i < t.length; i++) gaps.push((t[i] - t[i - 1]) / 60000);
  return `una aceptación cada ~${Math.round(gaps.reduce((s, x) => s + x, 0) / gaps.length)} min (${a.length} aceptaciones medidas)`;
}

function escribirContinuidad(root, e) {
  const f = path.join(root, canal.DIR, 'CONTINUIDAD.md');
  const ac = e.tareas.filter((t) => t.estado === 'ACEPTADA');
  const txt = [
    '# Continuidad — foto del momento', '',
    'Se reescribe sola cada vez que el Director revisa. No es un log: el historial está en el canal y en la memoria KDD.', '',
    `**Canal:** \`.legion/AUDITORIA-CURSOR.md\` · estado ${e.canal} · mecánica ${e.mecanica || 'n/d'}`, '',
    '## Cerrado y verificado',
    ...(ac.length ? ac.slice(-15).map((t) => `- [${t.id}] ${corto(t.titulo, 100)}`) : ['_Nada aceptado todavía._']), '',
    '## Corriendo ahora',
    `- **Constructor**: ${e.tareasPend.length ? e.tareasPend.slice(0, 3).map((t) => t.id + ' ' + corto(t.titulo, 60)).join('; ') : (e.corrPend.length ? 'resolviendo correcciones' : 'sin tareas en cola')}`,
    `- **Director**: ${e.hechasSinAceptar.length ? 'revisando ' + e.hechasSinAceptar.map((t) => t.id).join(', ') : 'adelantando el siguiente lote'}`, '',
    '## Correcciones pendientes', ...(e.corrPend.length ? e.corrPend.map((k) => `- ${k.id} (${k.sev}) ${corto(k.titulo, 100)}`) : ['_Ninguna._']), '',
    '## Preguntas sin responder (dueño)', ...(e.decisionesDueno.length ? e.decisionesDueno.map((d) => `- ${d.id} ${corto(d.titulo, 120)}`) : ['_Ninguna._']), '',
    '## Backlog pendiente', ...(e.tareasPend.length ? e.tareasPend.map((t) => `- [${t.id}] ${corto(t.titulo, 100)}`) : ['_Cola vacía._']), '',
    '## Ritmo real observado', ritmo(root), '',
    '## Última actualización real', canal.sello() + ' (reloj del sistema)', '',
  ].join('\n');
  fs.writeFileSync(f, txt);
}

function escribirReporte(root, e, final) {
  const L = [];
  const r = reg.resumen(root);
  L.push(`# Reporte de TEAMS — ${canal.sello()}${final ? ' · FINAL' : ''}`, '');
  L.push(`**Avance medido:** ${e.avance === null ? 'sin tareas' : e.avance + ' %'} (${e.aceptadas} de ${e.total} tareas aceptadas por el Director). Canal ${e.canal}.`, '');
  L.push('## Hecho y aceptado');
  const ac = e.tareas.filter((t) => t.estado === 'ACEPTADA');
  L.push(...(ac.length ? ac.map((t) => `- [${t.id}] ${corto(t.titulo, 120)}${t.reporte && t.reporte.detalle ? ' — ' + corto(t.reporte.detalle, 140) : ''}`) : ['_Nada todavía._']), '');
  L.push('## Hecho por el constructor, sin aceptar aún');
  L.push(...(e.hechasSinAceptar.length ? e.hechasSinAceptar.map((t) => `- [${t.id}] ${corto(t.titulo, 120)}`) : ['_Ninguna._']), '');
  L.push('## NO implementado (y por qué)');
  const noh = e.tareas.filter((t) => t.reporte && ['NO_HECHO', 'PARCIAL', 'BLOQUEADO'].includes(t.reporte.estado) && t.estado !== 'ACEPTADA' && t.estado !== 'CANCELADA');
  L.push(...(noh.length ? noh.map((t) => `- [${t.id}] ${t.reporte.estado}: ${corto(t.reporte.detalle, 160)}`) : ['_Nada reportado como no hecho._']), '');
  L.push('## Pendiente');
  L.push(...(e.tareasPend.length ? e.tareasPend.map((t) => `- [${t.id}] ${corto(t.titulo, 120)}`) : ['_Cola vacía._']));
  if (e.corrPend.length) L.push('', 'Correcciones sin resolver:', ...e.corrPend.map((k) => `- ${k.id} (${k.sev}) ${corto(k.titulo, 120)}`));
  L.push('', '## Decisiones tuyas abiertas');
  L.push(...(e.decisionesDueno.length ? e.decisionesDueno.map((d) => `- ${d.id} ${corto(d.titulo, 140)}`) : ['_Ninguna._']), '');
  L.push('## Qué probar');
  const probar = ac.flatMap((t) => (t.texto.match(/^\s*[-*]\s*\[[xX]\]\s*(.+)$/gm) || []).map((x) => `- [${t.id}] ${x.replace(/^\s*[-*]\s*\[[xX]\]\s*/, '')}`));
  L.push(...(probar.length ? probar.slice(0, 40) : ['_Sin criterios marcados._']), '');
  L.push('## Registro en Agentix');
  L.push(`Ciclos registrados con origen teams: ${r.registradas} · pendientes de registro: ${r.pendientes}${r.abandonadas ? ' · abandonados tras reintentos: ' + r.abandonadas : ''} · entradas a la memoria KDD: ${r.memoria}.`, '');
  const f = path.join(root, canal.DIR, 'REPORTE.md');
  fs.writeFileSync(f, L.join('\n'));
  return { ruta: f, texto: L.join('\n') };
}

// ───────────────────────────── instalación ──────────────────────────────────

const MARCA_SNIPPET = '## PROTOCOLO TEAMS — recuperación de contexto';

/** Versiones 3.21–3.22.1 de `activar` escribían un bloque de recuperación en INSTRUCCIONES-PROYECTO.md y CLAUDE.md (y por eso `akdd update` veía
 *  «cambios propios» en CLAUDE.md y lo dejaba sin actualizar). Esa regla ya viaja en el CLAUDE.md que gestiona Agentix: se retira el bloque viejo. */
function retirarBloqueViejo(f) {
  try {
    const txt = fs.readFileSync(f, 'utf8'); const crlf = txt.includes('\r\n'); const t = txt.replace(/\r\n/g, '\n');
    const i = t.indexOf(MARCA_SNIPPET); if (i < 0) return false;
    let fin = t.indexOf('\n## ', i + 5); if (fin < 0) fin = t.length;
    const bloque = t.slice(i, fin);
    if (!bloque.includes('.legion/AUDITORIA-CURSOR.md')) return false; // no es el nuestro: no se toca
    const nuevo = (t.slice(0, i).replace(/\n+$/, '\n') + t.slice(fin).replace(/^\n+/, '')).replace(/\n{3,}/g, '\n\n');
    fs.writeFileSync(f, crlf ? nuevo.replace(/\n/g, '\r\n') : nuevo);
    return true;
  } catch { return false; }
}

function activar(root, opt) {
  const out = []; const dir = path.join(root, canal.DIR);
  fs.mkdirSync(dir, { recursive: true });
  // 0. El motor TEAMS anterior: sus vigilantes siguen vivos tras un `akdd update` (el código ya cargado no se descarga) y
  //    reescriben el canal con su formato. Se paran ANTES de tocar el canal; si no, pisan el nuevo.
  for (const p of procesosViejos(root)) {
    try { process.kill(p.pid); out.push(`✔ detenido un proceso del TEAMS anterior (pid ${p.pid}) que seguía reescribiendo el canal`); } catch (e) { out.push(`⚠ no pude detener el proceso del TEAMS anterior pid ${p.pid} (${e.code || e.message}): ciérralo a mano o reinicia el IDE`); }
  }
  let existente = fs.existsSync(canal.rutaCanal(root));
  if (existente) {
    let txt = ''; try { txt = fs.readFileSync(canal.rutaCanal(root), 'utf8'); } catch { /* ilegible */ }
    if (esCanalViejo(txt)) {
      let destino = path.join(dir, 'ANTIGUO-v3-vista.md'); let n = 1;
      while (fs.existsSync(destino)) destino = path.join(dir, `ANTIGUO-v3-vista.${++n}.md`);
      fs.renameSync(canal.rutaCanal(root), destino);
      existente = false;
      out.push(`✔ el canal era del TEAMS anterior (formato incompatible): archivado como .legion/${path.basename(destino)} — pásalo como documento fuente en \`teams: plan\` si quieres reutilizar su plan`);
    }
  }
  const fecha = new Date().toISOString().slice(0, 10);
  if (!existente) { canal.olvidarInstantanea(root);
    fs.writeFileSync(canal.rutaCanal(root), P.canalPlantilla({ mecanica: 'POR DEFINIR', constructor: nombreOpt(opt, 'constructor', 'Cursor'), director: nombreOpt(opt, 'director', 'Claude Code'), fecha }));
    out.push('✔ canal creado: .legion/AUDITORIA-CURSOR.md (estado PREPARADO, modo por definir)');
  } else {
    // Un canal que ya venía trabajando (sin marca de estado) sigue ACTIVO; uno con marca conserva la suya.
    if (!/ESTADO DEL CANAL:/i.test(fs.readFileSync(canal.rutaCanal(root), 'utf8'))) canal.fijarEstado(root, 'ACTIVO');
    out.push('✔ canal existente ADOPTADO sin tocar su contenido: .legion/AUDITORIA-CURSOR.md');
    const d = calcular(root);
    if (d) {
      out.push(`  Lo que veo vivo en tu canal: ${d.corrPend.length} corrección(es) sin resolver · ${d.tareasPend.length} tarea(s) en cola · ${d.hechasSinAceptar.length} hecha(s) sin aceptar.`);
      for (const k of d.corrPend.slice(0, 8)) out.push(`    · corrección ${k.id}: ${corto(k.titulo, 90)}`);
      for (const t of d.tareasPend.slice(0, 8)) out.push(`    · tarea ${t.id}: ${corto(t.titulo, 90)}`);
      if (d.corrPend.length + d.tareasPend.length) out.push('  Si algo de eso YA está hecho en tu historial y solo falta la marca, ejecuta `teams: heredar` (marca ✅ lo vivo ahora como heredado) para que el constructor no lo reciba como pendiente.');
    }
  }
  for (const [nombre, texto] of [['METODOLOGIA.md', P.metodologia()]]) {
    const f = path.join(dir, nombre);
    if (!fs.existsSync(f)) { fs.writeFileSync(f, texto); out.push('✔ ' + nombre + ' creado'); } else out.push('· ' + nombre + ' ya existía: se respeta');
  }
  const e = calcular(root);
  if (e) escribirContinuidad(root, e);
  const retirados = [path.join(root, '.agentic', 'INSTRUCCIONES-PROYECTO.md'), path.join(root, 'CLAUDE.md')].filter((f) => retirarBloqueViejo(f));
  if (retirados.length) out.push('✔ retirado el bloque de recuperación que versiones anteriores escribían en ' + retirados.map((f) => path.basename(f)).join(' y ') + ' (ahora viaja en el CLAUDE.md de Agentix; así `akdd update` no lo ve como cambio propio)');
  // La regla que le enseña a Cursor los comandos `teams:` viaja con Agentix (.cursor/rules/teams.mdc); sin ella Cursor no reconoce `teams: constructor`.
  if (!fs.existsSync(path.join(root, '.cursor', 'rules', 'teams.mdc'))) out.push('⚠ Falta .cursor/rules/teams.mdc (la regla que le enseña a Cursor los comandos `teams:`): ejecuta `akdd update` o Cursor no sabrá qué es `teams: constructor`.');
  else out.push('✔ regla de Cursor presente: .cursor/rules/teams.mdc');
  const est = leerEstado(root); guardarEstado(root, est);
  const modo = est.modo || null;
  out.push('');
  if (!modo) {
    out.push('PARA EL AGENTE (Claude Code): ahora asimila el protocolo y PREGUNTA al dueño, en el chat, el modo de trabajo (no lo elijas tú):',
      '  A) COMPLETO — tú eres el Director con tus 3 sub-agentes auditores (frontend/UI-UX, backend, negocio) y Cursor es el constructor.',
      '  B) INDIVIDUAL — tú asumes también el rol de constructor (sin Cursor, sin vigilantes).',
      '  Pregunta además si quiere un agente auditor EXTRA (y con qué enfoque).',
      `Con su respuesta ejecuta: node .agentic/grafo/teams.cjs modo completo|individual [--extra="nombre: enfoque"]`,
      `Antes de preguntar, lee tu protocolo: node .agentic/grafo/teams.cjs prompt director`);
  } else out.push(`Modo ya definido: ${modo.toUpperCase()}${(est.extras || []).length ? ' (+ ' + est.extras.length + ' auditor extra)' : ''}. Siguiente: \`teams: plan …\` y luego \`teams: iniciar\`.`);
  return out.join('\n');
}

/** Reescribe en el canal la mecánica y la «Dirección de esta sesión» según el modo elegido. */
function fijarModoEnCanal(root, mecanica, opt) {
  canal.mutar(root, (lineas) => {
    let cambio = false;
    for (let i = 0; i < lineas.length; i++) {
      if (/^#\s+Canal de trabajo/.test(lineas[i])) { const n = lineas[i].replace(/MEC[ÁA]NICA:\s*(?:BASE|INVERTIDA|INDIVIDUAL|POR DEFINIR)/i, 'MECÁNICA: ' + mecanica); if (n !== lineas[i]) { lineas[i] = n; cambio = true; } }
      if (/^\*\*Dirección de esta sesión:\*\*/.test(lineas[i])) { lineas[i] = P.lineaDireccion(mecanica, { constructor: nombreOpt(opt, 'constructor', 'Cursor'), director: nombreOpt(opt, 'director', 'Claude Code') }); cambio = true; }
    }
    return cambio ? lineas : null;
  });
}

// ───────────────────────────── comandos ─────────────────────────────────────

const SIN_CANAL = 'No hay canal TEAMS en este proyecto. Ejecuta `teams: activar` (o `node .agentic/grafo/teams.cjs activar`).';

function observar(root, e, say, forzar = false) {
  const detalles = aceptacionesDetalle(e.c);
  const res = [];
  const est = leerEstado(root);
  const aceps = (est.aceptaciones || []).map((a) => ({ id: a.id, at: Date.parse(a.at) })).filter((a) => Number.isFinite(a.at));
  // Lo que figura REGISTRADA sin haberse comprobado se contrasta con la base: si el ciclo no está, vuelve a PENDIENTE (antes no se miraba).
  try { reg.reverificar(root); } catch { /* el registro es auxiliar */ }
  const presupuesto = { restantes: reg.PRESUPUESTO_RONDA }; // cada registro corre los tests de la tarea: la ronda no lanza un aluvión
  for (const t of e.tareas.filter((x) => x.estado === 'ACEPTADA')) {
    const ac = detalles[t.id] || { fecha: '', tests: 0 };
    // Inicio del ciclo = cuando el constructor quedó libre para ella: lo último entre «se encoló» y «se aceptó la anterior».
    // Sin ninguno de los dos datos NO se inventa (el ciclo queda «sin dato», como manda el reloj de hierro).
    const creada = Date.parse((est.creadas || {})[t.id]);
    const miAcept = aceps.filter((a) => a.id === t.id).map((a) => a.at).sort((x, y) => x - y)[0];
    const previa = Math.max(0, ...aceps.filter((a) => a.id !== t.id && (!miAcept || a.at < miAcept)).map((a) => a.at));
    const inicio = Number.isFinite(creada) ? Math.max(creada, previa) : null;
    const r = reg.registrarTarea(root, t, { fecha: ac.fecha, tests: ac.tests, reporte: t.reporte, inicio, forzar }, { presupuesto });
    res.push({ id: t.id, ...r });
  }
  try { reg.descartarObsoletas(root, e.tareas.filter((x) => x.estado === 'ACEPTADA').map((x) => x.id)); } catch { /* el registro es auxiliar */ }
  const nuevos = res.filter((x) => !['YA_REGISTRADA', 'EN_ESPERA'].includes(x.estado) && x.causa !== 'PRESUPUESTO_DE_RONDA');
  if (say) for (const x of nuevos) say(x.estado === 'REGISTRADA' ? `  ✔ ${x.id} registrada en el núcleo (ciclo ${x.ciclo}, área ${x.area}, ${x.archivos} archivo(s))` : `  ⚠ ${x.id} ${x.estado}${x.causa ? ': ' + x.causa : ''} — no frena nada; se reintenta en la próxima revisión`);
  return res;
}

/** Si esta tarea es (casi) la misma que el Director canceló hace poco, devuelve cuál y hace cuánto. */
function reencolaCancelada(root, titulo) {
  try {
    const norm = (t) => String(t || '').toLowerCase().replace(/\[[^\]]+\]/g, '').replace(/\s*[—-]\s*lote\s+\S+/g, '').replace(/[^a-z0-9áéíóúñ ]+/g, ' ').replace(/\s+/g, ' ').trim();
    const e = calcular(root); if (!e) return null; const nuevo = norm(titulo).slice(0, 48); if (nuevo.length < 12) return null;
    const ahora = Date.now();
    for (const ev of leerEventos(root, 200).filter((x) => x.cmd === 'cancelar' && x.arg).reverse()) {
      const min = (ahora - Date.parse(ev.t)) / 60000; if (min > 90) break;
      const t = e.tareas.find((x) => x.id === ev.arg); if (t && norm(t.titulo).slice(0, 48) === nuevo) return { id: t.id, min: Math.round(min) };
    }
  } catch { /* el aviso es auxiliar */ }
  return null;
}

// ───────────────────── bitácora de eventos (alimenta la oficina 3D del tablero) ─────────────────────
// Cada comando que MUEVE algo deja una línea: quién (rol), qué y sobre qué. Es solo para mostrar en vivo
// lo que pasa; nada del flujo depende de ella y un fallo al escribirla jamás rompe el comando.
const EVENTOS_ARCHIVO = 'eventos.jsonl';
const ROL_DE_COMANDO = {
  activar: 'director', init: 'director', adoptar: 'director', modo: 'director', plan: 'director', objetivo: 'director', tarea: 'director',
  corregir: 'director', resolver: 'builder', auditar: 'director', aceptar: 'director', revisar: 'director', decidir: 'director', decision: 'director',
  heredar: 'director', cancelar: 'director', cerrar: 'director', reabrir: 'director', iniciar: 'director', observar: 'director',
  constructor: 'builder', builder: 'builder', conectar: 'builder', ronda: 'builder', reportar: 'builder', pausa: 'ambos', continuar: 'ambos',
};
function registrarEvento(root, ev) {
  try {
    const f = path.join(canal.dirEstado(root), EVENTOS_ARCHIVO);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify({ t: iso(), ...ev }) + '\n');
    if (Math.random() < 0.05) { // recorte ocasional: la bitácora nunca crece sin tope
      const lineas = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
      if (lineas.length > 400) fs.writeFileSync(f, lineas.slice(-200).join('\n') + '\n');
    }
  } catch { /* la bitácora es opcional */ }
}
function leerEventos(root, n = 40) {
  try {
    return fs.readFileSync(path.join(canal.dirEstado(root), EVENTOS_ARCHIVO), 'utf8').split('\n').filter(Boolean).slice(-n)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function ejecutar(argv, root) {
  const r = ejecutarCmd(argv, root);
  try {
    const { opt, libres } = parseArgs(argv);
    const cmd = libres[0] || '';
    if (ROL_DE_COMANDO[cmd] && !(r && r.code > 0 && cmd !== 'activar')) {
      const rol = (cmd === 'continuar' && ['director', 'builder'].includes(opt.rol)) ? opt.rol : (cmd === 'ronda' && opt.rol === 'director') ? 'director' : ROL_DE_COMANDO[cmd];
      const a = libres[1] ? String(libres[1]).slice(0, 80) : undefined;
      registrarEvento(root, { cmd: cmd === 'builder' || cmd === 'conectar' ? 'constructor' : cmd === 'objetivo' ? 'plan' : cmd, rol, ...(a ? { arg: a } : {}) });
    }
  } catch { /* nunca rompe el comando */ }
  return r;
}

function ejecutarCmd(argv, root) {
  const { opt, libres } = parseArgs(argv);
  const cmd = libres[0] || 'ayuda';
  const arg = libres.slice(1);
  const out = []; const say = (...x) => out.push(x.join(' '));
  const salida = (code = 0) => ({ code, out: out.join('\n') });
  const necesitaCanal = () => { const e = calcular(root); if (!e) { say(SIN_CANAL); return null; } return e; };

  if (['activar', 'init', 'adoptar'].includes(cmd)) { say(activar(root, opt)); return salida(); }

  if (cmd === 'prompt') {
    const rol = arg[0] === 'director' ? 'director' : arg[0] === 'individual' ? 'individual' : arg[0] === 'builder' || arg[0] === 'constructor' ? 'builder' : null;
    if (!rol) { say('Uso: teams.cjs prompt director|builder|individual [--guardar]'); return salida(2); }
    const est = leerEstado(root);
    const txt = P.prompt(rol, { objetivo: est.nivel === 'objetivo' });
    if (opt.guardar) { fs.mkdirSync(path.join(root, canal.DIR), { recursive: true }); const f = path.join(root, canal.DIR, 'PROMPT-' + rol + '.md'); fs.writeFileSync(f, txt); say('Guardado en ' + path.relative(root, f)); } else say(txt);
    return salida();
  }

  if (cmd === 'estado') {
    const e = necesitaCanal(); if (!e) return salida(1);
    if (opt.json) {
      say(JSON.stringify({ canal: e.canal, mecanica: e.mecanica, segmentos: e.segmentos, fin: e.fin, avance: e.avance, aceptadas: e.aceptadas, total: e.total, correcciones_pendientes: e.corrPend.map((k) => k.id), tareas_pendientes: e.tareasPend.map((t) => t.id), por_aceptar: e.hechasSinAceptar.map((t) => t.id), devueltas: e.devueltas.map((t) => t.id), omisiones: e.omisiones.map((o) => o.codigo + ':' + o.id), decisiones_dueno_abiertas: e.decisionesDueno.map((d) => d.id), listo_para_cerrar: e.listo, constructor_ocioso: e.ocioso, registro: reg.resumen(root) }, null, 2));
      return salida();
    }
    const est0 = leerEstado(root);
    say(`Canal ${e.canal} · modo ${est0.modo ? est0.modo.toUpperCase() : 'POR DEFINIR'}${(est0.extras || []).length ? ' (+' + est0.extras.length + ' auditor extra)' : ''} · plan ${est0.plan ? 'guardado' : 'sin plan'}${est0.modo === 'completo' ? ' · constructor ' + (est0.builder ? 'conectado' : 'NO conectado') : ''}`);
    say(`Mecánica ${e.mecanica || 'n/d'} · avance ${e.avance === null ? 'n/d' : e.avance + ' %'} (${e.aceptadas}/${e.total} aceptadas)`);
    if (e.segmentos && e.segmentos.total) { const g = e.segmentos; say(`Barra: 🟩 ${g.verde} terminadas (${g.pct.verde}%) · 🟦 ${g.azul} en curso (${g.pct.azul}%) · 🟧 ${g.naranja} parciales (${g.pct.naranja}%) · 🟥 ${g.rojo} faltan (${g.pct.rojo}%)${e.fin ? ' · FIN: ' + (e.fin === 'TERMINADO' ? 'todo verde' : 'solo queda lo que depende del dueño') : ''}`); }
    say(`Correcciones pendientes: ${e.corrPend.length} · Tareas en cola: ${e.tareasPend.length} · Por aceptar: ${e.hechasSinAceptar.length} · Devueltas: ${e.devueltas.length} · Omisiones: ${e.omisiones.length}`);
    say(`Decisiones del dueño abiertas: ${e.decisionesDueno.length} · Listo para cerrar: ${e.listo ? 'SÍ' : 'no'}${e.ocioso ? ' · CONSTRUCTOR OCIOSO' : ''}`);
    const r = reg.resumen(root); say(`Registro en Agentix: ${r.registradas} ciclo(s) · pendientes ${r.pendientes}${r.abandonadas ? ' · abandonados ' + r.abandonadas : ''} · memoria KDD ${r.memoria}`);
    return salida();
  }

  if (cmd === 'ronda' || cmd === 'revisar') {
    const rol = cmd === 'revisar' || opt.rol === 'director' ? 'director' : 'builder';
    const e = necesitaCanal(); if (!e) return salida(1);
    // Primera línea, siempre: sin vigilante vivo una corrección o una pausa que llegue mientras trabajas NO te despierta.
    // (Medido en glowly: ambos roles dejaron de relanzarlo tras el primer aviso y pasaron media hora sin él.)
    { // loop de respaldo: sus rondas periódicas dejan huella; una ronda muy espaciada = el loop no está activo
      const est1 = leerEstado(root); const prevR = est1.rondas && est1.rondas[rol];
      if (e.canal === 'ACTIVO' && est1.modo !== 'individual' && prevR && Date.now() - prevR > 2 * LOOP_MS + 60000) {
        say(`⚠ Tu ronda anterior fue hace ${Math.round((Date.now() - prevR) / 60000)} min. Si no estabas en una tarea larga, tu LOOP DE RESPALDO de ~3 min NO está activo: prográmalo ahora (CronCreate */3 * * * * o el loop de tu host) con este texto: «${P.LOOP_PROMPT(rol)}»`, '');
      }
    }
    if (e.canal === 'ACTIVO' && leerEstado(root).modo !== 'individual' && !vigilanteVivo(root, rol)) {
      say(`⚠ TU VIGILANTE (${rol}) NO ESTÁ VIVO. Relánzalo AHORA, ANTES de trabajar, como tarea en segundo plano:  ${P.CMD} esperar --rol=${rol} --despertar${rol === 'director' ? '   (Claude Code con Monitor: añade --continuo)' : ''}`, '');
    }
    { const B = buzonDelDueno(); if (B) { const roles = rol === 'director' && leerEstado(root).modo === 'individual' ? ['director', 'builder'] : [rol]; const aviso = B.avisoParaModelo(root, roles); if (aviso) say(aviso, ''); } }
    if (rol === 'director') {
      say(textoRondaDirector(e));
      const rs = observar(root, e, (x) => say(x)); void rs;
      try { escribirContinuidad(root, e); } catch { /* auxiliar */ }
    } else {
      say(textoRondaBuilder(e));
      if (e.canal === 'ACTIVO' && (e.tareasPend.length || e.corrPend.length)) say('', '▶ ESTE TURNO NO TERMINA CON UN RESUMEN. Tienes trabajo pendiente: hazlo ahora. Un turno que cierra con «sigo con…» o con la lista de lo que falta, sin archivos tocados ni `reportar`, es un turno perdido (el Director y el dueño lo ven como «constructor parado»).');
      if (e.canal === 'ACTIVO' && leerEstado(root).modo !== 'individual') { const est2 = leerEstado(root); const r = seguimientoOcio(root, e, est2); guardarEstado(root, est2); if (r.aviso) say('', r.aviso); }
    }
    if (opt.cierre && rol === 'builder' && e.canal === 'ACTIVO') {
      say('');
      const pend = e.corrPend.length + e.tareasPend.length + e.omisiones.length;
      if (!e.corrPend.length && !e.omisiones.length) say(e.tareasPend.length ? `RONDA_COMPLETA (quedan ${e.tareasPend.length} tarea(s) en cola: sigue directo con la siguiente).` : 'RONDA_COMPLETA');
      else say(`RONDA_INCOMPLETA: ${pend} cosa(s) sin cerrar — ${e.corrPend.length} corrección(es) sin resolver, ${e.omisiones.length} omisión(es). Trabaja lo listado arriba.`);
    }
    const est = leerEstado(root); est.seen = est.seen || {}; est.seen[rol] = accionable(e, rol).digest;
    est.rondas = est.rondas || {}; est.rondas[rol] = Date.now();
    est.rondas_hist = est.rondas_hist || {}; est.rondas_hist[rol] = (est.rondas_hist[rol] || []).concat(Date.now()).slice(-10);
    for (const w of (est.wakes || [])) if (w.rol === rol && !w.visto_at) w.visto_at = iso(); // la ronda lee TODO lo pendiente: todos los avisos quedan atendidos
    guardarEstado(root, est);
    return salida();
  }

  if (cmd === 'tarea') {
    if (!necesitaCanal()) return salida(1);
    const titulo = arg.join(' ').trim(); if (!titulo) { say('Uso: teams.cjs tarea "título" --criterio="…" [--criterio=…] [--archivos=a,b] [--detalle="…"] [--lote=L1]'); return salida(2); }
    const crit = lista(opt.criterio); let id = '';
    // Aviso previo de Agentix (el mismo cerebro de `aa:`): riesgo, lo que ya pasó en esto y su cura, avisos. Apunta además la
    // predicción de riesgo para calificarla al aceptar. Fail-soft; --sin-contexto lo omite.
    const brief = opt['sin-contexto'] ? null : briefAgentix(root, [titulo, ...crit].join('. '));
    canal.mutar(root, (lineas, c) => {
      id = canal.siguienteId(c.limpias.join(String.fromCharCode(10)), 'T');
      const bloque = [`### [${id}] ${titulo}${opt.lote && opt.lote !== true ? ' — lote ' + opt.lote : ''}`];
      if (opt.archivos && opt.archivos !== true) bloque.push('Archivos: ' + lista(opt.archivos).join(', '));
      if (brief && brief.lineas.length) bloque.push(`> 🧠 Contexto Agentix (riesgo ${brief.riesgo || 'n/d'}) — lo que el proyecto ya sabe sobre esto:`, ...brief.lineas.map((l) => '> ' + l));
      if (opt.detalle && opt.detalle !== true) bloque.push(String(opt.detalle));
      for (const k of crit) bloque.push('- [ ] ' + k);
      let L = lineas.slice(); L = canal.__asegurar(L, 'tareas', 'Tareas para el constructor'); L = canal.__quitarPlaceholder(L, 'tareas');
      const fin = canal.__finSeccion(L, 'tareas'); L.splice(fin, 0, '', ...bloque); return L;
    });
    say(`✔ ${id} encolada${crit.length ? ' con ' + crit.length + ' criterio(s)' : ''}`);
    if (brief) say(`  🧠 Aviso previo de Agentix: riesgo ${brief.riesgo || 'n/d'}${brief.lineas.length ? ' · ' + brief.lineas.length + ' dato(s) del proyecto anotados en la tarea' : ' · sin antecedentes'}${/ALTO/i.test(brief.riesgo || '') ? ' — RIESGO ALTO: revisa ese contexto antes de darla por buena' : ''}`);
    { const est = leerEstado(root); est.creadas = est.creadas || {}; est.creadas[id] = iso(); guardarEstado(root, est); }
    atenderSolicitudes(root, 'el Director encoló ' + id);
    { const rec = reencolaCancelada(root, titulo); if (rec) say('  ⚠ Estás reencolando «' + corto(titulo, 70) + '», que cancelaste hace ' + rec.min + ' min (' + rec.id + '). Reencolar NO reactiva a Cursor (glowly lo comprobó: no reaccionó). Si el problema es que no la toma, corre `' + P.CMD + ' diagnostico`; si dice PARADO, dale al dueño el mensaje que imprime. Reencola solo si cambiaste algo de fondo en la tarea.'); }
    for (const a of canal.lintTexto([titulo, ...crit, opt.detalle || ''].join('\n'))) say('  ⚠ ' + a);
    return salida();
  }

  if (cmd === 'corregir') {
    if (!necesitaCanal()) return salida(1);
    const texto = arg.join(' ').trim(); if (!texto) { say('Uso: teams.cjs corregir "qué corregir" [--sev=BLOQUEANTE|HALLAZGO|NOTA] [--archivo=src/a.ts:12] [--tarea=T-001] [--porque="…"]'); return salida(2); }
    const sev = ['BLOQUEANTE', 'HALLAZGO', 'NOTA'].includes(String(opt.sev || '').toUpperCase()) ? String(opt.sev).toUpperCase() : 'HALLAZGO';
    let id = '';
    canal.mutar(root, (lineas, c) => {
      id = canal.siguienteId(c.limpias.join(String.fromCharCode(10)), 'C');
      const bloque = [`### [${id}] ${sev}${opt.archivo && opt.archivo !== true ? ' — ' + opt.archivo : ''}${opt.tarea && opt.tarea !== true ? ' (' + opt.tarea + ')' : ''}`, texto];
      if (opt.porque && opt.porque !== true) bloque.push('Por qué: ' + opt.porque);
      let L = canal.__asegurar(lineas.slice(), 'correcciones', 'Correcciones pendientes'); L = canal.__quitarPlaceholder(L, 'correcciones');
      const fin = canal.__finSeccion(L, 'correcciones'); L.splice(fin, 0, '', ...bloque); return L;
    });
    say(`✔ ${id} (${sev}) escrita en Correcciones pendientes — el constructor la lee primero en su próxima ronda${sev === 'BLOQUEANTE' ? ' (BLOQUEANTE: solo si de verdad es datos/seguridad/producción)' : ' y NO frena su avance'}`);
    for (const a of canal.lintTexto(texto)) say('  ⚠ ' + a);
    return salida();
  }

  if (cmd === 'resolver') {
    if (!necesitaCanal()) return salida(1);
    const id = arg[0]; const que = arg.slice(1).join(' ').trim();
    if (!id || !que) { say('Uso: teams.cjs resolver C-001 "qué hiciste"'); return salida(2); }
    const e0 = calcular(root); const k = e0.correcciones.find((x) => x.id === id);
    if (!k) { say(`No encuentro la corrección ${id} en «Correcciones pendientes».`); return salida(1); }
    const ya = k.resuelto;
    canal.anadirLineaAlElemento(root, 'correcciones', id, `✅ RESUELTO ${canal.sello()} — ${que}`);
    say(`✔ ${id} marcada RESUELTA${ya ? ' (ya lo estaba: se añadió el detalle)' : ''}`);
    if (k.sev !== 'NOTA') {
      const m = reg.recordar(root, 'corr:' + id + ':' + canal.sha(k.titulo).slice(0, 8), `[teams] ${k.sev}: ${k.titulo.replace(/\[[^\]]+\]\s*/, '')}. ${corto(k.texto.split('\n').slice(1).join(' '), 300)} Corregido: ${corto(que, 300)}`, { tipo: 'error', area: 'global' });
      say(m.ok ? '  ✔ aprendizaje registrado en la memoria KDD' : '  · memoria KDD: pendiente (' + m.causa + ') — no frena nada');
    }
    return salida();
  }

  if (cmd === 'reportar') {
    if (!necesitaCanal()) return salida(1);
    const id = arg[0]; const estado = String(opt.estado || '').toUpperCase().replace(' ', '_');
    if (!id || !['HECHO', 'PARCIAL', 'NO_HECHO', 'BLOQUEADO'].includes(estado)) { say('Uso: teams.cjs reportar T-001 --estado=HECHO|PARCIAL|NO_HECHO|BLOQUEADO --detalle="…" [--verif="comando: resultado"] [--archivos=a,b]'); return salida(2); }
    const detalle = opt.detalle && opt.detalle !== true ? String(opt.detalle).replace(/\s+/g, ' ').trim() : '';
    const linea = `- [${id}] ${estado} — ${detalle || '(sin detalle)'}${/[.!?]$/.test(detalle) || !detalle ? '' : '.'}${opt.verif && opt.verif !== true ? ' Verificación: ' + opt.verif + '.' : ''}${opt.archivos && opt.archivos !== true ? ' Archivos: ' + lista(opt.archivos).join(', ') + '.' : ''}`;
    canal.mutar(root, (lineas) => {
      let L = canal.__asegurar(lineas.slice(), 'reporte', 'Reporte del constructor'); L = canal.__quitarPlaceholder(L, 'reporte');
      const c = canal.analizar(L.join('\n')); const els = canal.elementos(c, 'reporte');
      const primero = els[0];
      const reciente = primero && /Ronda\s+\d+\s+—\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/.exec(primero.titulo);
      if (reciente && (Date.now() - Date.parse(reciente[1].replace(' ', 'T'))) < 10 * 60000 && primero.titulo.includes('auto')) { L.splice(primero.ini + 1, 0, linea); return L; }
      const n = (/Ronda\s+(\d+)/.exec(els.map((x) => x.titulo).join('\n')) || [0, 0])[1];
      const maxRonda = Math.max(0, ...els.map((x) => Number((/Ronda\s+(\d+)/.exec(x.titulo) || [0, 0])[1]))); void n;
      const pos = canal.__inicioSeccion(L, 'reporte');
      L.splice(pos, 0, `### Ronda ${maxRonda + 1} — ${canal.sello()} (constructor, auto)`, linea, '');
      return L;
    });
    say(`✔ reporte de ${id}: ${estado}`);
    if (estado !== 'HECHO') say('  · queda visible para el Director como «' + (estado === 'PARCIAL' ? 'trabajo parcial' : 'devuelta') + '»; no se pierde ni se omite.');
    return salida();
  }

  if (cmd === 'modo') {
    const e = necesitaCanal(); if (!e) return salida(1);
    const m = String(arg[0] || '').toLowerCase();
    if (!['completo', 'individual'].includes(m)) { say('Uso: teams.cjs modo completo|individual [--extra="nombre: enfoque"] [--mecanica=base]  (completo = Director + 3 sub-agentes + Cursor constructor; individual = Claude Code también construye)'); return salida(2); }
    const est = leerEstado(root);
    est.modo = m; est.extras = lista(opt.extra); guardarEstado(root, est);
    const mecanica = m === 'individual' ? 'INDIVIDUAL' : (/^base$/i.test(String(opt.mecanica || '')) ? 'BASE' : 'INVERTIDA');
    fijarModoEnCanal(root, mecanica, opt);
    say(`✔ Modo ${m.toUpperCase()} (mecánica ${mecanica})${est.extras.length ? ' · auditores extra: ' + est.extras.join(' | ') : ' · 3 sub-agentes auditores estándar'}`);
    if (m === 'completo') {
      const f = path.join(root, canal.DIR, 'PROMPT-builder.md'); fs.writeFileSync(f, P.prompt('builder', {}));
      say('', 'LISTO. Siguiente paso del dueño: `teams: plan …` (pásame todo lo ya aterrizado: docs, rutas, detalles).',
        'Para Cursor (modo completo): el dueño escribe en el chat de Cursor `teams: constructor`. Si su Cursor no reconociera el comando, le pegas este prompt (también guardado en .legion/PROMPT-builder.md):', '', P.prompt('builder', {}));
    } else say('', 'LISTO. Siguiente paso del dueño: `teams: plan …` (todo lo que hay que construir) y luego `teams: iniciar`. Trabajas tú solo, con tus 3 sub-agentes auditando lo que construyes.');
    return salida();
  }

  if (cmd === 'plan' || cmd === 'objetivo') {
    const e = necesitaCanal(); if (!e) return salida(1);
    const txt = arg.join(' ').trim();
    const docs = lista(opt.docs).flatMap((d) => d.split(',')).map((d) => d.trim()).filter(Boolean);
    if (!txt && !docs.length) { say('Uso: teams.cjs plan "resumen de lo que entendiste del plan" [--docs=ruta1,ruta2]  (el agente lee los docs COMPLETOS antes y deja aquí su resumen)'); return salida(2); }
    const faltan = docs.filter((d) => !fs.existsSync(path.resolve(root, d)));
    fs.mkdirSync(path.join(root, canal.DIR), { recursive: true });
    fs.writeFileSync(path.join(root, canal.DIR, 'PLAN.md'), `# Plan del dueño — ${canal.sello()}\n\n${txt}\n\n## Documentos fuente\n${docs.length ? docs.map((d) => '- ' + d + (faltan.includes(d) ? '  (⚠ no existe)' : '')).join('\n') : '_Ninguno indicado._'}\n`);
    const est = leerEstado(root); est.plan = { at: iso(), docs }; est.nivel = 'objetivo'; guardarEstado(root, est);
    say(`✔ Plan guardado en .legion/PLAN.md${docs.length ? ' (' + docs.length + ' documento(s) fuente)' : ''}.`);
    for (const d of faltan) say('  ⚠ no encuentro ' + d);
    if (est.modo === 'completo') say('', 'Siguiente: activa Cursor con `teams: constructor` en SU chat. Cuando Cursor diga «LISTO y a la espera», escribe aquí `teams: iniciar`.');
    else if (est.modo === 'individual') say('', 'Siguiente: `teams: iniciar` y empiezo a construir.');
    else say('', 'Falta elegir el modo: pregunta al dueño completo o individual y ejecuta `modo`.');
    return salida();
  }

  if (cmd === 'constructor' || cmd === 'builder' || cmd === 'conectar') {
    const e = necesitaCanal(); if (!e) return salida(1);
    const est = leerEstado(root); est.builder = { at: iso() }; guardarEstado(root, est);
    say('CONSTRUCTOR CONECTADO — el Director verá `constructor conectado` en el estado.', '',
      'LO PRIMERO QUE HACES (obligatorio): activar tus DOS vigilantes y confirmarlo —',
      `  1) vigilante de archivo en segundo plano:  ${P.CMD} esperar --rol=builder --despertar`,
      '  2) loop de respaldo cada ~3 minutos de tu host corriendo:  ' + P.CMD + ' ronda --rol=builder',
      `  3) confirmar:  ${P.CMD} comprobar   (debe decir builder: VIGILANTE_VIVO)`,
      'Después NO construyas nada hasta que el Director inicie. El protocolo completo:', '', P.prompt('builder', {}));
    if (e.canal === 'PAUSADO') say('', 'AVISO: el canal está PAUSADO. No trabajes ni lances vigilantes hasta que el dueño escriba `teams: continuar`.');
    if (e.canal === 'CERRADO') say('', 'AVISO: el canal está CERRADO. No hay nada que hacer.');
    return salida();
  }

  if (cmd === 'iniciar') {
    const e = necesitaCanal(); if (!e) return salida(1);
    const est = leerEstado(root);
    if (!est.modo) { say('Falta el modo: pregunta al dueño completo o individual y ejecuta `modo completo|individual`.'); return salida(2); }
    if (e.canal === 'CERRADO') { say('El canal está CERRADO. Usa `teams: reabrir` si hay más trabajo.'); return salida(2); }
    if (e.canal === 'ACTIVO') say('· El canal ya estaba ACTIVO.');
    else canal.fijarEstado(root, 'ACTIVO', 'iniciado ' + canal.sello());
    est.iniciado_at = iso(); guardarEstado(root, est);
    say(`✔ INICIADO — modo ${est.modo.toUpperCase()}, canal ACTIVO.`);
    if (est.modo === 'completo') {
      let vivo = false; try { const v = JSON.parse(fs.readFileSync(path.join(canal.dirEstado(root), 'vigilantes', 'builder.json'), 'utf8')); process.kill(v.pid, 0); vivo = true; } catch { /* sin vigilante */ }
      say(est.builder || vivo ? '  Constructor: ' + (vivo ? 'conectado con vigilante vivo' : 'conectado (su vigilante no figura vivo: puede que despierte por su loop de respaldo)') : '  ⚠ Constructor NO conectado todavía: el dueño debe escribir `teams: constructor` en el chat de Cursor.');
    }
    if (!est.plan && !e.tareas.length) say('  ⚠ No hay plan ni tareas: pídele al dueño `teams: plan …` antes de seguir.');
    say('', 'AHORA, Director:', '  1) lee .legion/PLAN.md y sus documentos fuente, y descompón el plan en lotes;', '  2) encola los 2 primeros con `tarea "…" --criterio="…" --archivos=…` (después te adelantas 1–2 lotes siempre);', est.modo === 'completo' ? `  3) activa tus DOS vigilantes: \`${P.CMD} esperar --rol=director --despertar\` en segundo plano + loop de respaldo de ~3 min con \`${P.CMD} revisar\`; confírmalo con \`${P.CMD} comprobar\`. El de Cursor lo despertará solo al ver la primera tarea.` : '  3) construye tú siguiendo `prompt individual` (bucle: construir → reportar → auditar con 3 sub-agentes → aceptar).');
    return salida();
  }

  if (cmd === 'pausa') {
    const e = necesitaCanal(); if (!e) return salida(1);
    if (e.canal === 'CERRADO') { say('El canal está CERRADO: no hay nada que pausar.'); return salida(2); }
    canal.fijarEstado(root, 'PAUSADO', canal.sello());
    const est = leerEstado(root); est.pausado_at = iso(); guardarEstado(root, est);
    say('✔ Canal PAUSADO. Los vigilantes de los dos roles terminan solos (AGENT_LOOP_PAUSE) y el constructor recibe la orden de parar en su próxima lectura; nadie gasta tokens consultando mientras no haya instrucciones.',
      '  El constructor también debe CANCELAR su loop de respaldo (se lo dice `ronda`). Para volver: `teams: continuar` en tu chat y, sobre todo, en el de Cursor.');
    return salida();
  }

  if (cmd === 'continuar') {
    const e = necesitaCanal(); if (!e) return salida(1);
    const rol = ['builder', 'constructor'].includes(opt.rol) ? 'builder' : 'director';
    if (e.canal === 'CERRADO') { say('El canal está CERRADO. Si hay más trabajo: `teams: reabrir`.'); return salida(2); }
    if (e.canal === 'PREPARADO') { say('El canal aún no se inició: el Director debe escribir `teams: iniciar` (modo, plan y constructor primero).'); return salida(2); }
    if (e.canal === 'PAUSADO') { canal.fijarEstado(root, 'ACTIVO', 'continuado ' + canal.sello()); say('✔ Canal ACTIVO otra vez.'); } else say('· El canal ya estaba ACTIVO.');
    const est = leerEstado(root); est.seen = est.seen || {}; est.seen[rol] = ''; guardarEstado(root, est);
    say(`CONTINÚAS como ${rol === 'builder' ? 'CONSTRUCTOR' : 'DIRECTOR'}: 1) relanza tu vigilante \`esperar --rol=${rol} --despertar\` como tarea en segundo plano; 2) reactiva tu loop de respaldo de ~3 min; 3) ejecuta \`${rol === 'builder' ? 'ronda --rol=builder' : 'revisar'}\` y retoma donde ibas.`);
    if (rol === 'director') say('  Recuerda: el constructor (Cursor) también necesita que el dueño escriba `teams: continuar` en SU chat para relanzar sus vigilantes.');
    return salida();
  }

  if (cmd === 'heredar') {
    const e = necesitaCanal(); if (!e) return salida(1);
    let n = 0;
    for (const k of e.corrPend) if (canal.anadirLineaAlElemento(root, 'correcciones', k.id, `✅ RESUELTO ${canal.sello()} — heredado de la adopción del canal`)) n++;
    for (const t of e.tareasPend) if (canal.anadirLineaAlElemento(root, 'tareas', t.id, `✔ HEREDADA ${canal.sello()} — ya estaba en el historial al adoptar el canal`)) n++;
    say(`✔ ${n} elemento(s) vivos marcados como heredados: el constructor empieza limpio. (Lo que escribas desde ahora cuenta normal.)`);
    return salida();
  }

  if (cmd === 'cancelar') {
    if (!necesitaCanal()) return salida(1);
    const id = arg[0]; const motivo = arg.slice(1).join(' ').trim();
    if (!id || !motivo) { say('Uso: teams.cjs cancelar T-001 "motivo" (la tarea deja de contar y de pedirse al constructor)'); return salida(2); }
    if (!canal.anadirLineaAlElemento(root, 'tareas', id, `❌ CANCELADA ${canal.sello()} — ${motivo}`)) { say('No encuentro la tarea ' + id); return salida(1); }
    say(`✔ ${id} cancelada: ya no se le pide al constructor ni cuenta en el avance`); say('  Ojo: cancelar y reencolar la misma tarea NO despierta a Cursor (glowly lo comprobó). Si no la tomaba, corre diagnostico y dale al dueño el mensaje que imprime.'); return salida();
  }

  if (cmd === 'auditar') {
    const e = necesitaCanal(); if (!e) return salida(1);
    const t = e.tareas.find((x) => x.id === arg[0]); if (!t) { say('Tarea no encontrada: ' + arg[0]); return salida(1); }
    const archivos = reg.archivosDe(root, t, t.reporte);
    let diff = '';
    try { const r = spawnSync('git', ['-c', 'safe.directory=*', 'diff', '--stat', 'HEAD', '--', ...archivos.slice(0, 40)], { cwd: root, encoding: 'utf8', timeout: 20000, windowsHide: true }); diff = r.status === 0 ? r.stdout.trim() : ''; } catch { /* sin git */ }
    say(`AUDITAR ${t.id} — ${t.titulo}`, '', 'Tarea tal como se pidió:', t.crudo, '', 'Lo que reportó el constructor:', t.reporte ? `  ${t.reporte.estado || 'sin estado'} — ${t.reporte.detalle}` : '  (nada: eso ya es una omisión)');
    say('', 'Archivos reales: ' + (archivos.join(', ') || '(no se pudieron determinar: usa git diff)'));
    if (diff) say('', 'git diff --stat:', diff);
    say('', 'Checklist del Director (hazlo TÚ, no solo leas el reporte): typecheck/build verde · tests verdes (reintenta una vez) · leer el diff real · contrastar casilla por casilla · si tocó algo compartido, comprobar que no quedó inconsistente.');
    say('', 'Lanza EN PARALELO, en un solo mensaje, 3 sub-agentes de solo lectura (cada uno con SOLO este diff y esta tarea):');
    say('  1) FRONTEND / UI-UX — accesibilidad, estados vacíos/carga/error, responsive, coherencia visual, la UI no debe ofrecer lo que el servidor rechaza.');
    say('  2) BACKEND — seguridad (tenant, authz, inyección, secretos), datos (transacciones, idempotencia, migraciones), errores y bordes (zona horaria, concurrencia), contratos de API.');
    say('  3) NEGOCIO — cumple lo que la tarea pide y las reglas del dominio; investiga con fuentes reales lo que dude (con o sin links del dueño); no inventa.');
    (leerEstado(root).extras || []).forEach((x, i) => say(`  ${4 + i}) EXTRA — ${x}`));
    say(`Cada hallazgo, al instante: node .agentic/grafo/teams.cjs corregir "…" --sev=… --archivo=archivo:línea --tarea=${t.id}. La auditoría NO frena el avance: sigue encolando.`);
    return salida();
  }

  if (cmd === 'aceptar') {
    const e = necesitaCanal(); if (!e) return salida(1);
    const t = e.tareas.find((x) => x.id === arg[0]); if (!t) { say('Tarea no encontrada: ' + arg[0]); return salida(1); }
    const avisos = [];
    if (!t.reporte) avisos.push('el constructor no dejó reporte puntual de ' + t.id);
    if (t.casillas.total > 0 && !t.completa) avisos.push(`quedan ${t.casillas.total - t.casillas.hechas} casilla(s) sin marcar`);
    const ligadas = e.corrPend.filter((k) => k.titulo.includes(t.id)); if (ligadas.length) avisos.push('correcciones pendientes ligadas: ' + ligadas.map((k) => k.id).join(', '));
    if (t.estado === 'ACEPTADA') say(`· ${t.id} ya estaba aceptada; se reintenta su registro si faltaba.`);
    else {
      const tests = opt.tests !== undefined && /^\d+$/.test(String(opt.tests)) ? Number(opt.tests) : null;
      const linea = `- ✅ ACEPTADA [${t.id}] ${canal.sello()} — ${t.titulo}${opt.verifico && opt.verifico !== true ? '. Verificó: ' + opt.verifico : ''}${tests !== null ? ' · tests: ' + tests : ''}`;
      canal.mutar(root, (lineas) => { let L = canal.__asegurar(lineas.slice(), 'auditoria', 'Auditoría del Director'); L = canal.__quitarPlaceholder(L, 'auditoria'); const fin = canal.__finSeccion(L, 'auditoria'); L.splice(fin, 0, linea); return L; });
      const est = leerEstado(root); est.aceptaciones = (est.aceptaciones || []).concat({ id: t.id, at: iso() }); guardarEstado(root, est);
      say(`✔ ${t.id} ACEPTADA`);
    }
    // Lo aprendido al aceptar entra a la memoria KDD (nodos del grafo). En `aa:` lo escriben los agentes de memoria; en TEAMS nadie
    // lo hacía y el grafo KDD quedaba vacío. Solo si el Director lo da: no se inventa un aprendizaje por cada tarea.
    if (opt.aprendizaje && opt.aprendizaje !== true) {
      const tipo = ['decision', 'patron', 'error'].includes(String(opt.tipo)) ? String(opt.tipo) : 'decision';
      const arch = reg.archivosDe(root, t, t.reporte);
      const m = reg.recordar(root, 'aceptar:' + t.id, `[${t.id}] ${t.titulo}. ${opt.aprendizaje}`, { tipo, area: reg.areaDe(arch), archivos: arch, confianza: 'MEDIA' });
      say(m.ok ? `  🧠 memoria KDD: ${m.estado === 'YA_REGISTRADO' ? 'ya estaba' : 'registrado como ' + tipo}` : `  ⚠ memoria KDD pendiente (${m.causa}) — no frena nada`);
    }
    for (const a of avisos) say('  ⚠ ' + a + ' (aviso: la aceptación es decisión tuya, no se bloquea)');
    const e2 = calcular(root); observar(root, e2, (x) => say(x));
    return salida();
  }

  if (cmd === 'observar') {
    const e = necesitaCanal(); if (!e) return salida(1);
    const r = observar(root, e, (x) => say(x), !!opt.reintentar);
    say(`Observado: ${r.length} tarea(s) aceptada(s) · ${JSON.stringify(reg.resumen(root))}`);
    return salida();
  }

  if (cmd === 'decision') {
    if (!necesitaCanal()) return salida(1);
    const pregunta = arg.join(' ').trim(); if (!pregunta) { say('Uso: teams.cjs decision "pregunta" --tipo=director|dueno [--elegida=…] [--porque=…] [--fuentes=u1,u2] [--opciones="a|b"] [--recomendacion=…] [--impacto=…]'); return salida(2); }
    const dueno = /^due/i.test(String(opt.tipo || ''));
    let id = '';
    canal.mutar(root, (lineas, c) => {
      id = canal.siguienteId(c.limpias.join(String.fromCharCode(10)), 'D');
      const decidida = !dueno && opt.elegida && opt.elegida !== true;
      const b = [`### [${id}] ${pregunta}`, `Tipo: ${dueno ? 'DUEÑO' : 'DIRECTOR'} · Estado: ${decidida ? 'DECIDIDA' : 'ABIERTA'} · ${canal.sello()}`];
      if (opt.opciones && opt.opciones !== true) b.push('Opciones: ' + opt.opciones);
      if (opt.recomendacion && opt.recomendacion !== true) b.push('Recomendación: ' + opt.recomendacion);
      if (opt.impacto && opt.impacto !== true) b.push('Impacto: ' + opt.impacto);
      if (decidida) b.push('Elegida: ' + opt.elegida);
      if (opt.porque && opt.porque !== true) b.push('Porque: ' + opt.porque);
      if (opt.fuentes && opt.fuentes !== true) b.push('Fuentes: ' + lista(opt.fuentes).join(', '));
      let L = canal.__asegurar(lineas.slice(), 'decisiones', 'Decisiones del Director y del dueño'); L = canal.__quitarPlaceholder(L, 'decisiones');
      const fin = canal.__finSeccion(L, 'decisiones'); L.splice(fin, 0, '', ...b); return L;
    });
    if (dueno) say(`✔ ${id} es del DUEÑO y queda ABIERTA. El trabajo independiente continúa. (Solo se escala lo que no está en internet o es bloqueante por seguridad.)`);
    else {
      say(`✔ ${id} decidida por el Director${opt.elegida ? ': ' + opt.elegida : ''}`);
      if (opt.elegida && opt.elegida !== true) { const m = reg.recordar(root, 'dec:' + id + ':' + canal.sha(pregunta).slice(0, 8), `[teams] Decisión: ${pregunta}. Elegida: ${opt.elegida}.${opt.porque && opt.porque !== true ? ' Porque: ' + opt.porque : ''}${opt.fuentes && opt.fuentes !== true ? ' Fuentes: ' + lista(opt.fuentes).join(', ') : ''}`, { tipo: 'decision', area: 'global', confianza: 'MEDIA' }); say(m.ok ? '  ✔ registrada en la memoria KDD' : '  · memoria KDD: pendiente (' + m.causa + ')'); }
      else say('  ⚠ sin --elegida quedó ABIERTA: si ya la decidiste, repítela con --elegida y --porque (el porqué siempre se escribe).');
    }
    return salida();
  }

  if (cmd === 'decidir') {
    if (!necesitaCanal()) return salida(1);
    const id = arg[0]; const dec = arg.slice(1).join(' ').trim(); if (!id || !dec) { say('Uso: teams.cjs decidir D-001 "decisión del dueño" [--porque=…]'); return salida(2); }
    let hallado = false;
    canal.mutar(root, (lineas, c) => {
      const d = canal.elementos(c, 'decisiones').find((x) => x.id === id); if (!d) return null; hallado = true;
      for (let i = d.ini; i < d.fin; i++) lineas[i] = lineas[i].replace(/Estado:\s*ABIERTA/i, 'Estado: DECIDIDA');
      lineas.splice(d.fin, 0, `Decisión del dueño ${canal.sello()}: ${dec}${opt.porque && opt.porque !== true ? ' — ' + opt.porque : ''}`);
      return lineas;
    });
    if (!hallado) { say('No encuentro la decisión ' + id); return salida(1); }
    say(`✔ ${id} decidida por el dueño. El Director la verá en su próxima revisión.`);
    reg.recordar(root, 'dec-dueno:' + id + ':' + canal.sha(dec).slice(0, 8), `[teams] Decisión del dueño ${id}: ${dec}`, { tipo: 'decision', area: 'global', confianza: 'ALTA' });
    return salida();
  }

  if (cmd === 'diagnostico') {
    const e = necesitaCanal(); if (!e) return salida(1);
    const ev = evidenciaConstructor(root, e); const sn = leerEstado(root).sinNovedad;
    say('DIAGNÓSTICO DEL CONSTRUCTOR: ' + ev.veredicto);
    say('  ' + ev.texto);
    say('  pendientes: ' + (e.tareasPend.length ? e.tareasPend.map((t) => t.id).join(', ') : 'ninguna tarea') + ' · correcciones: ' + (e.corrPend.length || 0) + ' · vigilante ' + (vigilanteVivo(root, 'builder') ? 'vivo' : 'MUERTO') + (sn && sn.builder ? ' · ' + sn.builder.n + ' ronda(s) iguales' : ''));
    if (ev.veredicto === 'PARADO' && ev.empujon) say('', 'PARECE PARADO (terminó su turno y espera que le escriban). No hay forma de escribir en su chat desde aquí: pásale al dueño este mensaje para que se lo pegue a Cursor:', '  «' + ev.empujon + '»');
    else if (ev.veredicto === 'TRABAJANDO') say('', 'Hay señales de trabajo reciente: no lo interrumpas.');
    return salida();
  }

  if (cmd === 'avance') {
    const e = necesitaCanal(); if (!e) return salida(1);
    say(e.avance === null ? 'Aún no hay tareas medibles.' : `El proyecto está en ${e.avance} % (${e.aceptadas} de ${e.total} tareas aceptadas).`);
    if (e.decisionesDueno.length) { say('Está así por estas decisiones tuyas:'); for (const d of e.decisionesDueno) say(`  · ${d.id} ${corto(d.titulo, 140)}`); }
    return salida();
  }

  if (cmd === 'reporte') {
    const e = necesitaCanal(); if (!e) return salida(1);
    const r = escribirReporte(root, e, false); say(r.texto, '', '(guardado en ' + path.relative(root, r.ruta) + ')');
    return salida();
  }

  if (cmd === 'cerrar') {
    const e = necesitaCanal(); if (!e) return salida(1);
    if (!e.listo && !opt.forzar) {
      say('No cierro todavía — queda trabajo vivo:');
      if (e.tareasPend.length) say('  · en cola: ' + e.tareasPend.map((t) => t.id).join(', '));
      if (e.corrPend.length) say('  · correcciones: ' + e.corrPend.map((k) => k.id).join(', '));
      if (e.hechasSinAceptar.length) say('  · por aceptar: ' + e.hechasSinAceptar.map((t) => t.id).join(', '));
      if (e.devueltas.length) say('  · devueltas: ' + e.devueltas.map((t) => t.id).join(', '));
      if (!e.total) say('  · el canal no tiene tareas');
      say('Resuélvelo, o cierra igual con --forzar (los pendientes quedan en el reporte).');
      return salida(2);
    }
    observar(root, e, (x) => say(x));
    canal.fijarEstado(root, 'CERRADO', canal.sello());
    const e2 = calcular(root); escribirContinuidad(root, e2); const r = escribirReporte(root, e2, true);
    say(`✔ Canal CERRADO. Reporte final: ${path.relative(root, r.ruta)}`, '  Los vigilantes de los dos roles recibirán AGENT_LOOP_END y terminarán solos; no relances ninguno. Ahora el dueño puede probar.');
    return salida();
  }

  if (cmd === 'reabrir') {
    if (!necesitaCanal()) return salida(1);
    canal.fijarEstado(root, 'ACTIVO'); say('✔ Canal ACTIVO otra vez. Relanza los vigilantes (`teams: vigilar`).'); return salida();
  }

  if (cmd === 'salud') {
    const s = salud(root); if (!s) { say(SIN_CANAL); return salida(1); }
    say(JSON.stringify(s, null, 2)); return salida();
  }

  if (cmd === 'comprobar') {
    const est = leerEstado(root); const dir = path.join(canal.dirEstado(root), 'vigilantes');
    const ec = calcular(root);
    { const sl = salud(root); if (sl && sl.alertas.length) { say(`SEMÁFORO ${sl.semaforo}:`); for (const al of sl.alertas) say(`  ${al.nivel === 'ROJO' ? '🔴' : '🟡'} ${al.msg}`); say(''); } else if (sl && ['VERDE'].includes(sl.semaforo)) say('SEMÁFORO VERDE: los dos roles con vigilante y loop, sin avisos sin atender.', ''); }
    say(`Canal ${ec ? ec.canal : 'inexistente'} · modo ${est.modo ? est.modo.toUpperCase() : 'POR DEFINIR'}${est.modo === 'individual' ? ' (sin vigilantes: no hacen falta)' : ''}`);
    for (const p of procesosViejos(root)) say(`⚠ PROCESO DEL TEAMS ANTERIOR VIVO (pid ${p.pid}): reescribe el canal con el formato viejo. Ejecuta \`teams: activar\` para detenerlo.`);
    for (const rol of ['builder', 'director']) {
      let v = null; try { v = JSON.parse(fs.readFileSync(path.join(dir, rol + '.json'), 'utf8')); } catch { /* sin vigilante */ }
      let vivo = false; if (v) { try { process.kill(v.pid, 0); vivo = true; } catch { vivo = false; } }
      const edad = v ? Math.round((Date.now() - Date.parse(v.latido)) / 1000) : null;
      const sano = vivo && edad !== null && edad < Math.max(60, (v.sondeo_s || 10) * 4);
      const w = (est.wakes || []).filter((x) => x.rol === rol);
      const ult = est.rondas && est.rondas[rol]; const hace = ult ? Math.round((Date.now() - ult) / 60000) : null;
      say(`${rol}: loop de respaldo ${ec && ec.canal === 'ACTIVO' && est.modo !== 'individual' ? (hace !== null && hace <= 4 ? 'ACTIVO (última ronda hace ' + hace + ' min)' : 'NO FIGURA' + (hace !== null ? ' (última ronda hace ' + hace + ' min)' : ' (sin rondas registradas)')) : 'n/a'}`);
      say(`${rol}: ${sano ? 'VIGILANTE_VIVO (pid ' + v.pid + ', latido hace ' + edad + ' s)' : 'NO_HAY_VIGILANTE vivo'} · despertares emitidos ${w.length}, atendidos ${w.filter((x) => x.visto_at).length}`);
    }
    const ver = (est.wakes || []).some((x) => x.visto_at);
    say(ver ? 'Despertar VERIFICADO: hubo al menos un aviso seguido de una ronda del rol.' : 'Despertar NO verificado todavía: sin un aviso atendido, solo cuenta el loop de respaldo del host (cada ~3 min). No lo des por autónomo.');
    return salida();
  }

  if (cmd === 'esperar') return { code: -1, out: '', esperar: true, opt };

  say([
    'teams.cjs — TEAMS v4 (Claude Code dirige, Cursor construye, un canal MD)',
    '  flujo: activar → modo completo|individual → plan → (Cursor) constructor → iniciar → pausa / continuar',
    '  activar | modo | plan | constructor | iniciar | pausa | continuar | estado | ronda --rol=builder [--cierre] | revisar | tarea | corregir | resolver | reportar | auditar | aceptar',
    '  cancelar | decision | decidir | objetivo | avance | reporte | cerrar | reabrir | observar | esperar --rol= --despertar | comprobar | prompt director|builder',
  ].join('\n'));
  return salida(cmd === 'ayuda' ? 0 : 2);
}

// ───────────────────────────── vigilante ────────────────────────────────────

function esperar(root, opt) {
  const rol = opt.rol === 'director' ? 'director' : 'builder';
  const sondeoMs = Math.max(200, Number(process.env.AKDD_TEAMS_SONDEO_MS) || (Number(opt.sondeo) || 10) * 1000);
  const maxMs = Number(process.env.AKDD_TEAMS_MAX_MS) || (Number(opt.max) || 720) * 60000;
  const ociosoMs = Number(process.env.AKDD_TEAMS_OCIOSO_MS) || OCIOSO_MS;
  const dir = path.join(canal.dirEstado(root), 'vigilantes'); fs.mkdirSync(dir, { recursive: true });
  const archivoV = path.join(dir, rol + '.json');
  const desde = iso(); let ultimoLatido = 0; let terminado = false; let watcher = null; let timer = null;
  const latir = () => { try { fs.writeFileSync(archivoV, JSON.stringify({ rol, pid: process.pid, desde, latido: iso(), sondeo_s: sondeoMs / 1000 })); ultimoLatido = Date.now(); } catch { /* sin latido */ } };
  // Bitácora propia del vigilante (arranque, avisos, fin): sin ella un despertar que no llega es imposible de diagnosticar.
  const continuo = !!opt.continuo; let ultimoEmitido = ''; let ultimoEmitidoAt = 0; let recordatorios = 0;
  const archivoLog = path.join(dir, rol + '.log');
  const log = (m) => { try { let t = ''; try { t = fs.readFileSync(archivoLog, 'utf8'); } catch { /* nuevo */ } if (t.length > 120000) t = t.slice(-60000); fs.writeFileSync(archivoLog, t + new Date().toISOString() + ' pid=' + process.pid + ' ' + m + '\n'); } catch { /* sin bitácora */ } };
  log('INICIO sondeo=' + sondeoMs + 'ms max=' + Math.round(maxMs / 60000) + 'min' + (continuo ? ' CONTINUO' : ''));
  const fin = (texto) => {
    if (terminado) return; terminado = true;
    log('FIN ' + String(texto).split('\n').slice(0, 3).join(' | ').slice(0, 300));
    try { if (watcher) watcher.close(); } catch { /* ya cerrado */ } if (timer) clearInterval(timer);
    try { fs.rmSync(archivoV, { force: true }); } catch { /* sin archivo */ }
    console.log(texto); process.exit(0);
  };
  const revisar = () => {
    if (terminado) return;
    if (Date.now() - ultimoLatido > 20000) latir();
    const e = calcular(root, { ociosoMs });
    if (!e) return fin(`AGENT_LOOP_END_${rol}\nNo hay canal TEAMS en este proyecto: no hay nada que vigilar. No relances este vigilante.`);
    if (e.canal === 'PAUSADO') return fin(`AGENT_LOOP_PAUSE_${rol}\nEl canal está PAUSADO por el Director. NO relances este vigilante y CANCELA tu loop de respaldo: así no gastas tokens consultando mientras no hay instrucciones. Para seguir, el dueño escribe \`teams: continuar\` en tu chat.`);
    if (e.canal === 'CERRADO') return fin(`AGENT_LOOP_END_${rol}\nEl canal está CERRADO: el trabajo terminó. NO relances este vigilante ni sigas sondeando; informa al dueño (ver .legion/REPORTE.md) y detente.`);
    const a = accionable(e, rol); const est = leerEstado(root);
    const em = (est.emitido || {})[rol]; const yaEmitido = !!(em && em.digest === a.digest && a.digest); const recordar = yaEmitido && Date.now() - em.at >= LOOP_MS;
    if (continuo && a.digest && a.digest === ultimoEmitido && a.digest !== (est.seen || {})[rol] && Date.now() - ultimoEmitidoAt >= LOOP_MS) {
      // el aviso sigue sin atenderse: se repite cada ~3 min (con el vigilante continuo el aviso no se pierde aunque el modelo lo ignore una vez)
      ultimoEmitidoAt = Date.now(); recordatorios++; { est.emitido = est.emitido || {}; est.emitido[rol] = { digest: a.digest, at: Date.now() }; guardarEstado(root, est); } log('RECORDATORIO ' + recordatorios); console.log(`AGENT_LOOP_WAKE_${rol} (RECORDATORIO ${recordatorios}: sigue sin atenderse)\n` + a.razones.slice(0, 6).map((r) => '  · ' + r).join('\n') + `\nAhora: ${P.CMD} ${rol === 'director' ? 'revisar' : 'ronda --rol=builder'}`);
    }
    // Sin esto, «relanza el vigilante PRIMERO» provocaba una tormenta: el vigilante nuevo veía el mismo aviso aún sin atender y disparaba de inmediato
    // (medido en glowly: arranque y fin con 12 ms de diferencia, varias veces por minuto, cada una costando tokens).
    if (a.digest && a.digest !== (est.seen || {})[rol] && !(continuo && a.digest === ultimoEmitido) && (!yaEmitido || recordar)) {
      est.wakes = (est.wakes || []).concat({ rol, at: iso(), digest: a.digest }).slice(-200); est.emitido = est.emitido || {}; est.emitido[rol] = { digest: a.digest, at: Date.now() }; guardarEstado(root, est);
      const ahora = `${P.CMD} ${rol === 'director' ? 'revisar' : 'ronda --rol=builder'}`;
      const bloque = [`AGENT_LOOP_WAKE_${rol}${recordar ? ' (RECORDATORIO: el aviso anterior sigue sin atenderse)' : ''}`, ...a.razones.slice(0, 12).map((r) => '  · ' + r),
        continuo
          ? `Ahora: ${ahora}   (imprime TODO lo pendiente; trabájalo completo. NO relances este vigilante: sigue vivo y avisará de lo siguiente)`
          : `Ahora: ${ahora}   (imprime TODO lo pendiente). PRIMERO relanza este vigilante (antes de trabajar): si no, una corrección o una pausa que llegue mientras trabajas no te despierta`].join('\n');
      if (!continuo) return fin(bloque);
      ultimoEmitido = a.digest; ultimoEmitidoAt = Date.now(); recordatorios = 0; log('AVISO ' + bloque.split('\n').slice(0, 2).join(' | ').slice(0, 200)); console.log(bloque);
    }
    if (Date.now() - inicio > maxMs) return fin(`AGENT_LOOP_RELAUNCH_${rol}\nSigo sin novedades tras ${Math.round(maxMs / 60000)} min; relánzame para renovar la espera (no es un aviso de trabajo).`);
  };
  const inicio = Date.now();
  latir();
  try { watcher = fs.watch(path.join(root, canal.DIR), { persistent: true }, () => { setTimeout(revisar, 250); }); } catch { /* sin watch: queda el sondeo */ }
  timer = setInterval(revisar, sondeoMs);
  revisar();
}

// ───────────────────────────── salud (tablero, comprobar, monitor) ──────────

function leerVigilante(root, rol) {
  let v = null; try { v = JSON.parse(fs.readFileSync(path.join(canal.dirEstado(root), 'vigilantes', rol + '.json'), 'utf8')); } catch { /* sin vigilante */ }
  if (!v) return { vivo: false, pid: null, latido_hace_s: null, desde: null };
  let proceso = false; try { process.kill(v.pid, 0); proceso = true; } catch { proceso = false; }
  const hace = Math.round((Date.now() - Date.parse(v.latido)) / 1000);
  return { vivo: proceso && hace < Math.max(60, (v.sondeo_s || 10) * 4), pid: v.pid, latido_hace_s: hace, desde: v.desde };
}

/** Una decisión del dueño lista para mostrar en el tablero: la pregunta, sus opciones, la recomendación del Director y desde cuándo espera. */
function detalleDecision(d) {
  const lineas = String(d.texto || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const cab = lineas[0] || '';
  const campo = (re) => { const l = lineas.find((x) => re.test(x)); return l ? corto(l.replace(re, '').trim(), 400) : null; };
  const sello = /(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2})/.exec(lineas[1] || '');
  const cuerpo = lineas.slice(1).filter((l) => !/^(Tipo|Opciones|Recomendaci[óo]n|Impacto|Elegida|Porque|Fuentes|Respondida por):/i.test(l) && !/^Decisi[óo]n del due/i.test(l));
  return { id: d.id, titulo: corto(d.titulo || cab.replace(/^###\s*\[[^\]]+\]\s*/, ''), 160), detalle: corto(cuerpo.join(' '), 600), opciones: campo(/^Opciones:\s*/i), recomendacion: campo(/^Recomendaci[óo]n:\s*/i), desde: sello ? sello[1] : null };
}

/** Semáforo + detalle por rol. Se deriva SOLO de archivos y procesos (sin demonio propio): lo que ve el tablero es lo que hay. */
function salud(root, opts = {}) {
  const e = calcular(root, opts); if (!e) return null;
  const est = leerEstado(root); const ahora = e.ahora; const individual = est.modo === 'individual';
  const roles = {}; const alertas = []; let nivel = 0;
  const sube = (n, msg) => { nivel = Math.max(nivel, n); alertas.push({ nivel: n === 2 ? 'ROJO' : 'AMARILLO', msg }); };
  const NOMBRE = { director: 'Director (Claude Code)', builder: 'Constructor (Cursor)' };
  for (const rol of ['director', 'builder']) {
    const a = accionable(e, rol); const v = leerVigilante(root, rol);
    const ult = est.rondas && est.rondas[rol]; const ultMin = ult ? Math.round((ahora - ult) / 60000) : null;
    const sinAt = (est.wakes || []).filter((w) => w.rol === rol && !w.visto_at).map((w) => Date.parse(w.at)).filter(Number.isFinite);
    const avisoMin = sinAt.length ? Math.round((ahora - Math.min(...sinAt)) / 60000) : null;
    const sn = rol === 'builder' && est.sinNovedad && est.sinNovedad.builder; const sinNov = sn && sn.n >= 2 ? { n: sn.n, min: Math.round((ahora - sn.desde) / 60000), pedido: sn.pedido || null, umbral: sn.umbral || OCIO_RONDAS, evidencia: sn.evidencia || null, veredicto: sn.veredicto || null, empujon: sn.empujon || null } : null;
    roles[rol] = { sin_novedad: sinNov, nombre: NOMBRE[rol], vigilante: v, ultima_ronda_hace_min: ultMin, loop: individual ? 'n/a' : (ultMin !== null && ultMin <= 6 ? 'ACTIVO' : 'NO FIGURA'), pendiente: a.razones.length, razones: a.razones.slice(0, 6), aviso_sin_atender_min: avisoMin };
    if (e.canal !== 'ACTIVO' || individual) continue;
    if (sinNov && sinNov.n >= sinNov.umbral) sube(sinNov.n >= sinNov.umbral * 2 ? 2 : 1, NOMBRE[rol] + ': ' + sinNov.n + ' rondas sin trabajo (~' + sinNov.min + ' min)' + (sinNov.pedido ? '; ya pidió tareas al Director (' + sinNov.pedido + ')' : '') + (sinNov.veredicto === 'PARADO' ? '. Evidencia: ' + sinNov.evidencia + '. Probablemente terminó su turno y espera que le escribas: pégale en su chat «' + (sinNov.empujon || 'Continúa con la cola y no te detengas a resumir.') + '»' : ''));
    const empujonDir = rol === 'director' && a.razones.length ? ' Si su chat está quieto, pégale en él: «' + (e.hechasSinAceptar.length ? 'Revisa ' + e.hechasSinAceptar.map((t) => t.id).join(', ') + ': audita y acepta o corrige' : 'Atiende lo que tienes pendiente') + ', atiende lo que pida el constructor y sigue con el siguiente lote. No te detengas a resumir.»' : '';
    if (!v.vivo) sube(a.razones.length ? 2 : 1, NOMBRE[rol] + ': su vigilante NO está vivo' + (a.razones.length ? ' y tiene trabajo esperando' : '') + empujonDir);
    if (avisoMin !== null && avisoMin >= 10) sube(2, NOMBRE[rol] + ': aviso sin atender hace ' + avisoMin + ' min (en un turno largo, o dormido: solo tú puedes despertarlo escribiéndole en su chat)');
    else if (avisoMin !== null && avisoMin >= 3) sube(1, NOMBRE[rol] + ': aviso sin atender hace ' + avisoMin + ' min');
    if (ultMin === null || ultMin > 6) sube(1, NOMBRE[rol] + ': su loop de respaldo no figura (' + (ultMin === null ? 'sin rondas registradas' : 'última ronda hace ' + ultMin + ' min') + ')');
  }
  const quieto = Math.round(Math.max(0, ahora - e.mtime) / 60000);
  if (e.canal === 'ACTIVO') {
    const trabajo = e.tareasPend.length + e.hechasSinAceptar.length + e.devueltas.length + e.corrPend.length;
    // Si el constructor sigue tocando archivos, lo suyo (tareas y correcciones) está en marcha aunque el canal esté quieto (H-007, glowly 05/10/2026):
    // solo cuenta lo que espera al Director. Sin git no se puede saber y se avisa como antes.
    const enMarcha = quieto >= 20 && (e.tareasPend.length || e.corrPend.length) && evidenciaConstructor(root, e).veredicto === 'TRABAJANDO';
    const trabajoParado = enMarcha ? e.hechasSinAceptar.length + e.devueltas.length : trabajo;
    if (trabajoParado && quieto >= 20) sube(2, 'Nadie avanza: hay ' + trabajoParado + ' cosa(s) pendiente(s) y el canal lleva ' + quieto + ' min sin cambios');
    if (!e.total && quieto >= 10) sube(1, 'El canal está ACTIVO pero no hay ninguna tarea en cola: el Director debe encolar el primer lote');
    if (!trabajo && e.total && !e.listo && quieto >= 10) sube(1, 'Nadie tiene nada accionable pero el proyecto no está cerrado: el Director debe encolar el siguiente lote o cerrar');
    if (e.listo) sube(1, 'Todo aceptado y sin pendientes (LISTO_PARA_CERRAR): falta que el Director ejecute «cerrar»');
  }
  const informativo = e.canal !== 'ACTIVO';
  // Lo que se ve en la oficina 3D: quién hace qué AHORA, derivado de la bitácora de comandos y del canal.
  const evs = leerEventos(root, 60);
  let auditoria = null;
  for (const ev of evs) {
    if (ev.cmd === 'auditar') auditoria = { id: ev.arg || null, desde: ev.t };
    else if (auditoria && (['corregir', 'cancelar', 'cerrar', 'pausa'].includes(ev.cmd) || (ev.cmd === 'aceptar' && (!ev.arg || !auditoria.id || ev.arg === auditoria.id)))) auditoria = null;
  }
  if (auditoria && (ahora - Date.parse(auditoria.desde) > 20 * 60000 || (auditoria.id && e.tareas.some((t) => t.id === auditoria.id && t.estado === 'ACEPTADA')))) auditoria = null;
  const ultEv = evs.length ? Date.parse(evs[evs.length - 1].t) : 0;
  const actividadSeg = Math.round(Math.max(0, ahora - Math.max(e.mtime || 0, ultEv)) / 1000);
  return {
    canal: e.canal, modo: est.modo || null, semaforo: informativo ? e.canal : ['VERDE', 'AMARILLO', 'ROJO'][nivel],
    ntfy: (() => { try { const nb = puenteTelefono(); const c = nb && nb.leerConfig(root); if (!c || !c.activo) return { activo: false }; return { activo: true, servicio_vivo: nb.estadoServicio(root).vivo, buzon_sin_leer: nb.sinLeer(root).length }; } catch { return { activo: false }; } })(),
    alertas, roles, quieto_min: quieto, actividad_seg: actividadSeg, plan: !!est.plan, builder_conectado: !!est.builder, extras: (est.extras || []).length, auditoria,
    eventos: evs.slice(-14).map((ev) => ({ t: ev.t, cmd: ev.cmd, rol: ev.rol, arg: ev.arg || null })),
    tareas_todas: e.tareas.slice(-60).map((t) => ({ id: t.id, titulo: corto(t.titulo, 70), estado: t.estado, reporte: t.reporte ? t.reporte.estado : null })),
    segmentos: e.segmentos, fin: e.fin,
    correcciones_todas: e.correcciones.slice(-30).map((k) => ({ id: k.id, resuelta: !!k.resuelto, sev: k.sev, titulo: corto(k.titulo, 70) })), avance: e.avance, aceptadas: e.aceptadas, total: e.total,
    cola: { tareas: e.tareasPend.map((t) => ({ id: t.id, titulo: corto(t.titulo, 90) })), por_aceptar: e.hechasSinAceptar.map((t) => ({ id: t.id, titulo: corto(t.titulo, 90) })), devueltas: e.devueltas.map((t) => ({ id: t.id, titulo: corto(t.titulo, 90), estancada: !!t.estancada })), correcciones: e.corrPend.map((k) => ({ id: k.id, sev: k.sev, titulo: corto(k.titulo, 90) })), decisiones_dueno: e.decisionesDueno.map(detalleDecision) },
    registro: Object.assign(reg.resumen(root), { base: reg.estadoBase(root) }), avisos: (est.wakes || []).slice(-8).map((w) => ({ rol: w.rol, at: w.at, atendido: !!w.visto_at })),
    generado: new Date(ahora).toISOString(),
  };
}

// ───────────────────────────── main ─────────────────────────────────────────

module.exports = { leerVigilante, registrarEvento, salud, reencolaCancelada, evidenciaConstructor, ultimoCambioArchivos, detalleDecision, leerEventos, registrarEvento, calcular, accionable, ejecutar, parseArgs, leerEstado, textoRondaBuilder, textoRondaDirector, activar, escribirReporte };

if (require.main === module) {
  let root = process.cwd();
  const a = process.argv.slice(2);
  const i = a.findIndex((x) => x.startsWith('--root='));
  if (i >= 0) { root = path.resolve(a[i].slice(7)); a.splice(i, 1); }
  try {
    const r = ejecutar(a, root);
    if (r.esperar) esperar(root, r.opt);
    else { if (r.out) console.log(r.out); process.exitCode = r.code; }
  } catch (e) {
    console.error(e.code === 'SIN_CANAL' ? e.message : 'teams: ' + e.message);
    process.exitCode = 1;
  }
}
