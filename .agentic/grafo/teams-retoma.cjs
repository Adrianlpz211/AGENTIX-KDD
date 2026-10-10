#!/usr/bin/env node
'use strict';
/* TEAMS — punto de retoma. Al volver de una pausa (o de un `reabrir`), cada chat debe saber DÓNDE QUEDÓ y QUÉ CAMBIÓ mientras no estaba.
 *
 * Medido en medinet y protocolo_reserva: tras `continuar` el constructor hacía su primera ronda en segundos, pero `pausa` solo guardaba una hora:
 * no anotaba qué tarea iba en curso ni su último reporte, y `continuar` solo decía «corre ronda» (que lista TODO lo pendiente). Un chat de Cursor
 * dormido o compactado no sabía por dónde seguir ni qué había encolado el Director entre tanto. Nada puede escribir en un chat dormido, así que
 * el dueño pega un mensaje: aquí se genera listo para pegar.
 *
 * Todo sale del estado del canal (instantánea al pausar + estado actual al continuar): nada se inventa.
 */

const corto = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const FUERA = new Set(['ACEPTADA', 'CANCELADA', 'HEREDADA']);

function hace(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return m + ' min';
  const h = Math.floor(m / 60);
  return h >= 48 ? Math.round(h / 24) + ' días' : h + ' h ' + String(m % 60).padStart(2, '0') + ' min';
}

/** Lo que había al pausar: ids por estado, lo que iba en curso y el último reporte. `e` es el resultado de teams.calcular. */
function instantanea(e) {
  const tareas = {}; for (const t of e.tareas || []) tareas[t.id] = t.estado;
  const correcciones = {}; for (const k of e.correcciones || []) correcciones[k.id] = !!k.resuelto;
  const parciales = (e.tareas || [])
    .filter((t) => t.reporte && t.reporte.estado === 'PARCIAL' && !FUERA.has(t.estado))
    .map((t) => ({ id: t.id, titulo: corto(t.titulo, 90), detalle: corto(t.reporte.detalle, 200) }));
  let ultimo = null;
  for (const t of e.tareas || []) {
    const r = t.reporte; if (!r || !r.at) continue;
    if (!ultimo || r.at > ultimo.at) ultimo = { id: t.id, estado: r.estado || null, detalle: corto(r.detalle, 160), at: r.at };
  }
  return {
    at: Date.now(), tareas, correcciones, parciales, ultimo_reporte: ultimo,
    decididas: (e.decididasDueno || []).map((d) => d.id),
    cola: (e.tareasPend || []).map((t) => ({ id: t.id, titulo: corto(t.titulo, 90) })),
    corrPend: (e.corrPend || []).map((k) => ({ id: k.id, titulo: corto(k.titulo, 90) })),
    porAceptar: (e.hechasSinAceptar || []).map((t) => t.id),
    rondas: Object.assign({}, e.rondas || {}),
  };
}

/** Qué cambió desde la instantánea: elementos nuevos y tareas cuyo estado es otro. */
function cambios(e, snap) {
  const out = { tareasNuevas: [], correccionesNuevas: [], correccionesResueltas: [], estados: [], decisiones: [] };
  if (!snap) return out;
  for (const t of e.tareas || []) {
    if (!(t.id in (snap.tareas || {}))) { if (!FUERA.has(t.estado)) out.tareasNuevas.push({ id: t.id, titulo: corto(t.titulo, 90) }); continue; }
    if (snap.tareas[t.id] !== t.estado) out.estados.push({ id: t.id, antes: snap.tareas[t.id], ahora: t.estado });
  }
  for (const k of e.correcciones || []) {
    if (!(k.id in (snap.correcciones || {}))) { if (!k.resuelto) out.correccionesNuevas.push({ id: k.id, titulo: corto(k.titulo, 90) }); continue; }
    if (!snap.correcciones[k.id] && k.resuelto) out.correccionesResueltas.push(k.id);
  }
  const antes = new Set(snap.decididas || []);
  for (const d of e.decididasDueno || []) if (!antes.has(d.id)) out.decisiones.push({ id: d.id, titulo: corto(d.titulo, 90) });
  return out;
}

function primeraAccion(e, rol) {
  if (rol === 'builder') {
    const parcial = (e.tareas || []).find((t) => t.reporte && t.reporte.estado === 'PARCIAL' && !FUERA.has(t.estado));
    if (parcial) return `Retoma ${parcial.id} («${corto(parcial.titulo, 70)}»): iba PARCIAL — "${corto(parcial.reporte.detalle, 120)}". Léela entera, termina lo que falta y repórtala.`;
    if ((e.corrPend || []).length) return `Resuelve primero ${e.corrPend[0].id} («${corto(e.corrPend[0].titulo, 70)}»): las correcciones van antes que las tareas.`;
    if ((e.tareasPend || []).length) return `Toma ${e.tareasPend[0].id} («${corto(e.tareasPend[0].titulo, 70)}»): es la primera de la cola.`;
    return 'No tienes nada en cola: corre la ronda, avisa que quedaste libre y espera al Director.';
  }
  if ((e.hechasSinAceptar || []).length) return `Revisa y audita lo entregado: ${e.hechasSinAceptar.map((t) => t.id).join(', ')} (revisar → auditar → aceptar o corregir).`;
  if ((e.devueltas || []).length) return `Decide sobre lo devuelto: ${e.devueltas.map((t) => t.id).join(', ')} (aceptar así, reformular, desbloquear o cancelar).`;
  if ((e.decididasDueno || []).length) return 'El dueño respondió decisiones: ejecútalas y ciérralas con evidencia (decisiones.cjs aplicada).';
  if ((e.tareasPend || []).length || (e.corrPend || []).length) return 'El constructor aún tiene cola: revisa lo que entregue y atiende sus solicitudes.';
  return 'No hay nada accionable: encola el siguiente lote o, si todo está aceptado, cierra el canal.';
}

/** Bloque de texto «RETOMA» para imprimir al continuar. `snap` puede faltar (pausa anterior a esta versión): entonces solo hay «dónde estás». */
function bloque(e, rol, snap) {
  const L = [];
  const nombre = rol === 'builder' ? 'CONSTRUCTOR' : 'DIRECTOR';
  L.push('', `━━ RETOMA — ${nombre}: dónde quedaste y qué cambió ━━`);
  if (snap && snap.at) L.push(`Pausa de hace ${hace(Date.now() - snap.at)}.`);
  if (rol === 'builder') {
    const s = snap || instantanea(e);
    if (s.parciales && s.parciales.length) { L.push('Iba en curso (PARCIAL):'); for (const p of s.parciales) L.push(`  · ${p.id} — ${p.titulo}${p.detalle ? ' → ' + p.detalle : ''}`); }
    if (s.ultimo_reporte) L.push(`Tu último reporte: ${s.ultimo_reporte.id} ${s.ultimo_reporte.estado || ''}${s.ultimo_reporte.detalle ? ' — ' + s.ultimo_reporte.detalle : ''}`);
    if (!(s.parciales && s.parciales.length) && !s.ultimo_reporte) L.push('No habías reportado nada antes de parar.');
  } else {
    const s = snap || instantanea(e);
    if (s.porAceptar && s.porAceptar.length) L.push(`Esperaban tu revisión: ${s.porAceptar.join(', ')}`);
    if (s.cola && s.cola.length) L.push(`En la cola del constructor: ${s.cola.map((t) => t.id).join(', ')}`);
  }
  if (snap) {
    const c = cambios(e, snap);
    const hay = c.tareasNuevas.length || c.correccionesNuevas.length || c.correccionesResueltas.length || c.estados.length || c.decisiones.length;
    L.push(hay ? 'Qué cambió mientras estuvo pausado:' : 'Mientras estuvo pausado no cambió nada en el canal.');
    for (const t of c.tareasNuevas) L.push(`  · NUEVA tarea ${t.id} — ${t.titulo}`);
    for (const k of c.correccionesNuevas) L.push(`  · NUEVA corrección ${k.id} — ${k.titulo}`);
    for (const id of c.correccionesResueltas) L.push(`  · corrección ${id} resuelta`);
    for (const x of c.estados) L.push(`  · ${x.id}: ${x.antes} → ${x.ahora}`);
    for (const d of c.decisiones) L.push(`  · el dueño respondió ${d.id} — ${d.titulo}`);
  }
  L.push(`PRIMERA ACCIÓN: ${primeraAccion(e, rol)}`);
  return L;
}

/** Mensaje listo para pegar en el chat de Cursor (nada puede escribir en un chat dormido: lo pega el dueño). */
function mensajeParaCursor(cmd) {
  return `teams: continuar — retoma donde quedaste: corre \`${cmd} continuar --rol=builder\`, relanza tu vigilante y reactiva tu loop; sigue el bloque «RETOMA» y haz primero lo que diga su PRIMERA ACCIÓN.`;
}

module.exports = { instantanea, cambios, bloque, primeraAccion, mensajeParaCursor, hace };
