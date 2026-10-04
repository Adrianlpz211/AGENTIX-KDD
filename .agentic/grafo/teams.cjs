#!/usr/bin/env node
'use strict';
/**
 * TEAMS v4 — Claude Code dirige, Cursor construye, un solo canal MD. `akdd teams …` y `teams: …` en el chat.
 *
 * Es el protocolo manual del dueño (carpeta «Protocolo-TEAMS») hecho comando, conectado al núcleo de Agentix.
 * Diseño: Agentix OBSERVA y ayuda, no manda. No hay máquina de estados, ni compuertas, ni fencing: el avance lo
 * decide el Director en el canal, y nada de lo que se mide aquí lo frena (la auditoría nunca gatea el avance).
 *
 *   FLUJO DEL DUEÑO:  activar → modo completo|individual → plan → (en Cursor) builder → iniciar → pausa / continuar
 *   activar | init            modo completo|individual [--extra="nombre: enfoque"]      plan "resumen" [--docs=a,b]
 *   builder (Cursor)          iniciar                       pausa                       continuar [--rol=builder|director]
 *   estado [--json]            ronda --rol=builder|director [--cierre]        revisar  (= ronda --rol=director)
 *   tarea "t" [--criterio=…]   corregir "t" [--sev=] [--archivo=] [--tarea=]  resolver C-001 "qué se hizo"
 *   reportar T-001 --estado=HECHO|PARCIAL|NO_HECHO --detalle=… [--verif=] [--archivos=]
 *   auditar T-001              cancelar T-001 "motivo"   aceptar T-001 [--verifico=] [--tests=N]        observar
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
  const c = canal.leer(root);
  if (!c) return null;
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
    else if (hechaBuilder) estado = 'HECHA_SIN_ACEPTAR';
    return { ...t, estado, reporte: r, completa, aceptacion: detAcept[t.id] || null };
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
    return { ...d, dueno, abierta };
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
    correcciones, corrPend, tareas, tareasPend, hechasSinAceptar, devueltas, omisiones, decisiones,
    decisionesDueno: decisiones.filter((d) => d.dueno && d.abierta), decididasDueno: decisiones.filter((d) => d.dueno && !d.abierta),
    aceptadas: aceptadasN, total: vivas, avance: vivas ? Math.round((aceptadasN / vivas) * 100) : null,
    constructorSinTrabajo, listo, ocioso,
  };
}

/** Qué le toca a cada rol, y su huella: si la huella no cambió desde la última ronda que el rol hizo, no hay despertar. */
function accionable(e, rol) {
  const razones = []; const claves = [];
  if (e.canal !== 'ACTIVO') return { razones, digest: '' }; // preparado, pausado o cerrado: nadie es despertado
  if (rol === 'builder') {
    for (const k of e.corrPend) { razones.push(`CORRECCION ${k.id} (${k.sev}): ${corto(k.titulo, 110)}`); claves.push('C:' + k.id + ':' + canal.sha(k.texto).slice(0, 8)); }
    for (const t of e.tareasPend) { razones.push(`TAREA ${t.id}: ${corto(t.titulo, 110)}`); claves.push('T:' + t.id + ':' + canal.sha(t.texto).slice(0, 8)); }
    for (const o of e.omisiones) { razones.push(`OMISION ${o.codigo}: ${o.texto}`); claves.push('O:' + o.codigo + ':' + o.id); }
  } else {
    for (const t of e.hechasSinAceptar) { razones.push(`ENTREGA ${t.id} por revisar: ${corto(t.titulo, 90)}`); claves.push('E:' + t.id + ':' + canal.sha((t.reporte ? t.reporte.detalle + t.reporte.estado : '') + t.casillas.hechas).slice(0, 8)); }
    for (const t of e.devueltas) { razones.push(`DEVUELTA ${t.id} (${t.reporte.estado}): ${corto(t.reporte.detalle, 100)} — decide: reformular, desbloquear o cancelar`); claves.push('V:' + t.id + ':' + canal.sha(t.reporte.detalle).slice(0, 8)); }
    for (const o of e.omisiones) { razones.push(`OMISION del constructor ${o.codigo}: ${o.texto}`); claves.push('O:' + o.codigo + ':' + o.id); }
    for (const d of e.decididasDueno) { razones.push(`DECISION DEL DUEÑO ${d.id} contestada: ${corto(d.titulo, 90)}`); claves.push('D:' + d.id); }
    if (e.ocioso) { razones.push('CONSTRUCTOR_OCIOSO: la cola está vacía y no hay correcciones — pon el siguiente lote, o decide cerrar'); claves.push('OCIOSO'); }
    if (e.listo) { razones.push('LISTO_PARA_CERRAR: todo aceptado, sin correcciones y sin más lotes — ejecuta `cerrar` (publica el reporte final y detiene a los vigilantes)'); claves.push('LISTO'); }
  }
  return { razones, digest: claves.length ? canal.sha(claves.sort().join('|')).slice(0, 16) : '' };
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
  if (!e.corrPend.length && !e.tareasPend.length && !e.omisiones.length) o.push('', 'Nada nuevo. NO inventes trabajo: cierra la ronda.');
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

function anexar(f, texto, crearSi = true) {
  let actual = '';
  try { actual = fs.readFileSync(f, 'utf8'); } catch { if (!crearSi) return false; }
  if (actual.includes(MARCA_SNIPPET)) return false;
  const crlf = /\r\n/.test(actual);
  const nuevo = (actual && !/\n$/.test(actual) ? '\n' : '') + (actual ? '\n' : '') + texto;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, actual + (crlf ? nuevo.replace(/\n/g, '\r\n') : nuevo));
  return true;
}

function activar(root, opt) {
  const out = []; const dir = path.join(root, canal.DIR);
  fs.mkdirSync(dir, { recursive: true });
  const existente = fs.existsSync(canal.rutaCanal(root));
  const fecha = new Date().toISOString().slice(0, 10);
  if (!existente) {
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
  const s = P.snippetClaude();
  const a = anexar(path.join(root, '.agentic', 'INSTRUCCIONES-PROYECTO.md'), s);
  const b = fs.existsSync(path.join(root, 'CLAUDE.md')) ? anexar(path.join(root, 'CLAUDE.md'), s, false) : false;
  out.push(a || b ? '✔ regla de recuperación de contexto añadida (INSTRUCCIONES-PROYECTO.md' + (b ? ' y CLAUDE.md' : '') + ')' : '· la regla de recuperación de contexto ya estaba');
  if (fs.existsSync(path.join(root, '.cursor')) || fs.existsSync(path.join(root, '.cursorrules'))) {
    const rc = path.join(root, '.cursor', 'rules', 'protocolo-teams.mdc');
    if (!fs.existsSync(rc)) { fs.mkdirSync(path.dirname(rc), { recursive: true }); fs.writeFileSync(rc, P.reglaCursor()); out.push('✔ regla de Cursor: .cursor/rules/protocolo-teams.mdc'); }
  }
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

function observar(root, e, say) {
  const detalles = aceptacionesDetalle(e.c);
  const res = [];
  for (const t of e.tareas.filter((x) => x.estado === 'ACEPTADA')) {
    const ac = detalles[t.id] || { fecha: '', tests: 0 };
    const r = reg.registrarTarea(root, t, { fecha: ac.fecha, tests: ac.tests, reporte: t.reporte });
    res.push({ id: t.id, ...r });
  }
  const nuevos = res.filter((x) => !['YA_REGISTRADA'].includes(x.estado));
  if (say) for (const x of nuevos) say(x.estado === 'REGISTRADA' ? `  ✔ ${x.id} registrada en el núcleo (ciclo ${x.ciclo}, área ${x.area}, ${x.archivos} archivo(s))` : `  ⚠ ${x.id} ${x.estado}${x.causa ? ': ' + x.causa : ''} — no frena nada; se reintenta en la próxima revisión`);
  return res;
}

function ejecutar(argv, root) {
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
      say(JSON.stringify({ canal: e.canal, mecanica: e.mecanica, avance: e.avance, aceptadas: e.aceptadas, total: e.total, correcciones_pendientes: e.corrPend.map((k) => k.id), tareas_pendientes: e.tareasPend.map((t) => t.id), por_aceptar: e.hechasSinAceptar.map((t) => t.id), devueltas: e.devueltas.map((t) => t.id), omisiones: e.omisiones.map((o) => o.codigo + ':' + o.id), decisiones_dueno_abiertas: e.decisionesDueno.map((d) => d.id), listo_para_cerrar: e.listo, constructor_ocioso: e.ocioso, registro: reg.resumen(root) }, null, 2));
      return salida();
    }
    const est0 = leerEstado(root);
    say(`Canal ${e.canal} · modo ${est0.modo ? est0.modo.toUpperCase() : 'POR DEFINIR'}${(est0.extras || []).length ? ' (+' + est0.extras.length + ' auditor extra)' : ''} · plan ${est0.plan ? 'guardado' : 'sin plan'}${est0.modo === 'completo' ? ' · constructor ' + (est0.builder ? 'conectado' : 'NO conectado') : ''}`);
    say(`Mecánica ${e.mecanica || 'n/d'} · avance ${e.avance === null ? 'n/d' : e.avance + ' %'} (${e.aceptadas}/${e.total} aceptadas)`);
    say(`Correcciones pendientes: ${e.corrPend.length} · Tareas en cola: ${e.tareasPend.length} · Por aceptar: ${e.hechasSinAceptar.length} · Devueltas: ${e.devueltas.length} · Omisiones: ${e.omisiones.length}`);
    say(`Decisiones del dueño abiertas: ${e.decisionesDueno.length} · Listo para cerrar: ${e.listo ? 'SÍ' : 'no'}${e.ocioso ? ' · CONSTRUCTOR OCIOSO' : ''}`);
    const r = reg.resumen(root); say(`Registro en Agentix: ${r.registradas} ciclo(s) · pendientes ${r.pendientes}${r.abandonadas ? ' · abandonados ' + r.abandonadas : ''} · memoria KDD ${r.memoria}`);
    return salida();
  }

  if (cmd === 'ronda' || cmd === 'revisar') {
    const rol = cmd === 'revisar' || opt.rol === 'director' ? 'director' : 'builder';
    const e = necesitaCanal(); if (!e) return salida(1);
    if (rol === 'director') {
      say(textoRondaDirector(e));
      const rs = observar(root, e, (x) => say(x)); void rs;
      try { escribirContinuidad(root, e); } catch { /* auxiliar */ }
    } else say(textoRondaBuilder(e));
    if (opt.cierre && rol === 'builder' && e.canal === 'ACTIVO') {
      say('');
      const pend = e.corrPend.length + e.tareasPend.length + e.omisiones.length;
      if (!e.corrPend.length && !e.omisiones.length) say(e.tareasPend.length ? `RONDA_COMPLETA (quedan ${e.tareasPend.length} tarea(s) en cola: sigue directo con la siguiente).` : 'RONDA_COMPLETA');
      else say(`RONDA_INCOMPLETA: ${pend} cosa(s) sin cerrar — ${e.corrPend.length} corrección(es) sin resolver, ${e.omisiones.length} omisión(es). Trabaja lo listado arriba.`);
    }
    const est = leerEstado(root); est.seen = est.seen || {}; est.seen[rol] = accionable(e, rol).digest;
    for (const w of (est.wakes || []).slice().reverse()) if (w.rol === rol && !w.visto_at) { w.visto_at = iso(); break; }
    guardarEstado(root, est);
    return salida();
  }

  if (cmd === 'tarea') {
    if (!necesitaCanal()) return salida(1);
    const titulo = arg.join(' ').trim(); if (!titulo) { say('Uso: teams.cjs tarea "título" --criterio="…" [--criterio=…] [--archivos=a,b] [--detalle="…"] [--lote=L1]'); return salida(2); }
    const crit = lista(opt.criterio); let id = '';
    canal.mutar(root, (lineas, c) => {
      id = canal.siguienteId(c.limpias.join(String.fromCharCode(10)), 'T');
      const bloque = [`### [${id}] ${titulo}${opt.lote && opt.lote !== true ? ' — lote ' + opt.lote : ''}`];
      if (opt.archivos && opt.archivos !== true) bloque.push('Archivos: ' + lista(opt.archivos).join(', '));
      if (opt.detalle && opt.detalle !== true) bloque.push(String(opt.detalle));
      for (const k of crit) bloque.push('- [ ] ' + k);
      let L = lineas.slice(); L = canal.__asegurar(L, 'tareas', 'Tareas para el constructor'); L = canal.__quitarPlaceholder(L, 'tareas');
      const fin = canal.__finSeccion(L, 'tareas'); L.splice(fin, 0, '', ...bloque); return L;
    });
    say(`✔ ${id} encolada${crit.length ? ' con ' + crit.length + ' criterio(s)' : ''}`);
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
        'Para Cursor (modo completo): el dueño escribe en el chat de Cursor `teams: builder`. Si su Cursor no reconociera el comando, le pegas este prompt (también guardado en .legion/PROMPT-builder.md):', '', P.prompt('builder', {}));
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
    if (est.modo === 'completo') say('', 'Siguiente: activa Cursor con `teams: builder` en SU chat. Cuando Cursor diga «LISTO y a la espera», escribe aquí `teams: iniciar`.');
    else if (est.modo === 'individual') say('', 'Siguiente: `teams: iniciar` y empiezo a construir.');
    else say('', 'Falta elegir el modo: pregunta al dueño completo o individual y ejecuta `modo`.');
    return salida();
  }

  if (cmd === 'builder' || cmd === 'conectar') {
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
      say(est.builder || vivo ? '  Constructor: ' + (vivo ? 'conectado con vigilante vivo' : 'conectado (su vigilante no figura vivo: puede que despierte por su loop de respaldo)') : '  ⚠ Constructor NO conectado todavía: el dueño debe escribir `teams: builder` en el chat de Cursor.');
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
    const rol = opt.rol === 'builder' ? 'builder' : 'director';
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
    say(`✔ ${id} cancelada: ya no se le pide al constructor ni cuenta en el avance`); return salida();
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
    for (const a of avisos) say('  ⚠ ' + a + ' (aviso: la aceptación es decisión tuya, no se bloquea)');
    const e2 = calcular(root); observar(root, e2, (x) => say(x));
    return salida();
  }

  if (cmd === 'observar') {
    const e = necesitaCanal(); if (!e) return salida(1);
    const r = observar(root, e, (x) => say(x));
    say(`Observado: ${r.length} tarea(s) aceptada(s) · ${JSON.stringify(reg.resumen(root))}`);
    return salida();
  }

  if (cmd === 'decision') {
    if (!necesitaCanal()) return salida(1);
    const pregunta = arg.join(' ').trim(); if (!pregunta) { say('Uso: teams.cjs decision "pregunta" --tipo=director|dueno [--elegida=…] [--porque=…] [--fuentes=u1,u2] [--opciones="a|b"] [--recomendacion=…]'); return salida(2); }
    const dueno = /^due/i.test(String(opt.tipo || ''));
    let id = '';
    canal.mutar(root, (lineas, c) => {
      id = canal.siguienteId(c.limpias.join(String.fromCharCode(10)), 'D');
      const decidida = !dueno && opt.elegida && opt.elegida !== true;
      const b = [`### [${id}] ${pregunta}`, `Tipo: ${dueno ? 'DUEÑO' : 'DIRECTOR'} · Estado: ${decidida ? 'DECIDIDA' : 'ABIERTA'} · ${canal.sello()}`];
      if (opt.opciones && opt.opciones !== true) b.push('Opciones: ' + opt.opciones);
      if (opt.recomendacion && opt.recomendacion !== true) b.push('Recomendación: ' + opt.recomendacion);
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

  if (cmd === 'comprobar') {
    const est = leerEstado(root); const dir = path.join(canal.dirEstado(root), 'vigilantes');
    const ec = calcular(root);
    say(`Canal ${ec ? ec.canal : 'inexistente'} · modo ${est.modo ? est.modo.toUpperCase() : 'POR DEFINIR'}${est.modo === 'individual' ? ' (sin vigilantes: no hacen falta)' : ''}`);
    for (const rol of ['builder', 'director']) {
      let v = null; try { v = JSON.parse(fs.readFileSync(path.join(dir, rol + '.json'), 'utf8')); } catch { /* sin vigilante */ }
      let vivo = false; if (v) { try { process.kill(v.pid, 0); vivo = true; } catch { vivo = false; } }
      const edad = v ? Math.round((Date.now() - Date.parse(v.latido)) / 1000) : null;
      const sano = vivo && edad !== null && edad < Math.max(60, (v.sondeo_s || 10) * 4);
      const w = (est.wakes || []).filter((x) => x.rol === rol);
      say(`${rol}: ${sano ? 'VIGILANTE_VIVO (pid ' + v.pid + ', latido hace ' + edad + ' s)' : 'NO_HAY_VIGILANTE vivo'} · despertares emitidos ${w.length}, atendidos ${w.filter((x) => x.visto_at).length}`);
    }
    const ver = (est.wakes || []).some((x) => x.visto_at);
    say(ver ? 'Despertar VERIFICADO: hubo al menos un aviso seguido de una ronda del rol.' : 'Despertar NO verificado todavía: sin un aviso atendido, solo cuenta el loop de respaldo del host (cada ~3 min). No lo des por autónomo.');
    return salida();
  }

  if (cmd === 'esperar') return { code: -1, out: '', esperar: true, opt };

  say([
    'teams.cjs — TEAMS v4 (Claude Code dirige, Cursor construye, un canal MD)',
    '  flujo: activar → modo completo|individual → plan → (Cursor) builder → iniciar → pausa / continuar',
    '  activar | modo | plan | builder | iniciar | pausa | continuar | estado | ronda --rol=builder [--cierre] | revisar | tarea | corregir | resolver | reportar | auditar | aceptar',
    '  cancelar | decision | decidir | objetivo | avance | reporte | cerrar | reabrir | observar | esperar --rol= --despertar | comprobar | prompt director|builder',
  ].join('\n'));
  return salida(cmd === 'ayuda' ? 0 : 2);
}

// ───────────────────────────── vigilante ────────────────────────────────────

function esperar(root, opt) {
  const rol = opt.rol === 'director' ? 'director' : 'builder';
  const sondeoMs = Math.max(200, Number(process.env.AKDD_TEAMS_SONDEO_MS) || (Number(opt.sondeo) || 10) * 1000);
  const maxMs = Number(process.env.AKDD_TEAMS_MAX_MS) || (Number(opt.max) || 105) * 60000;
  const ociosoMs = Number(process.env.AKDD_TEAMS_OCIOSO_MS) || OCIOSO_MS;
  const dir = path.join(canal.dirEstado(root), 'vigilantes'); fs.mkdirSync(dir, { recursive: true });
  const archivoV = path.join(dir, rol + '.json');
  const desde = iso(); let ultimoLatido = 0; let terminado = false; let watcher = null; let timer = null;
  const latir = () => { try { fs.writeFileSync(archivoV, JSON.stringify({ rol, pid: process.pid, desde, latido: iso(), sondeo_s: sondeoMs / 1000 })); ultimoLatido = Date.now(); } catch { /* sin latido */ } };
  const fin = (texto) => {
    if (terminado) return; terminado = true;
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
    if (a.digest && a.digest !== (est.seen || {})[rol]) {
      est.wakes = (est.wakes || []).concat({ rol, at: iso(), digest: a.digest }).slice(-200); guardarEstado(root, est);
      return fin([`AGENT_LOOP_WAKE_${rol}`, ...a.razones.slice(0, 12).map((r) => '  · ' + r),
        `Ahora: ${P.CMD} ${rol === 'director' ? 'revisar' : 'ronda --rol=builder'}   (imprime TODO lo pendiente; trabájalo completo y luego RELANZA este vigilante)`].join('\n'));
    }
    if (Date.now() - inicio > maxMs) return fin(`AGENT_LOOP_RELAUNCH_${rol}\nSigo sin novedades tras ${Math.round(maxMs / 60000)} min; relánzame para renovar la espera (no es un aviso de trabajo).`);
  };
  const inicio = Date.now();
  latir();
  try { watcher = fs.watch(path.join(root, canal.DIR), { persistent: true }, () => { setTimeout(revisar, 250); }); } catch { /* sin watch: queda el sondeo */ }
  timer = setInterval(revisar, sondeoMs);
  revisar();
}

// ───────────────────────────── main ─────────────────────────────────────────

module.exports = { calcular, accionable, ejecutar, parseArgs, leerEstado, textoRondaBuilder, textoRondaDirector, activar, escribirReporte };

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
