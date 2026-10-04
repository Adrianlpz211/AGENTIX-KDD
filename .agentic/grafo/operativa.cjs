'use strict';

/**
 * Lo operativo del tablero en un solo sitio: incidentes, retrabajo, fricción,
 * actividad y tiempos. La pantalla, el reporte exportado y la API leen esto;
 * ninguno vuelve a contar a su manera.
 *
 *   - Un evento repetido es una observación más del mismo incidente.
 *   - Regresión = algo que se verificó y después volvió a fallar.
 *   - Retrabajo = reabrir una entrega verificada. Un arreglo sin ese vínculo
 *     es trabajo, no retrabajo.
 *   - El tiempo de calendario es la unión de intervalos, no su suma.
 *   - Lo que no tiene dato queda null, nunca 0.
 */

const fechaMod = require('./fecha-utc.cjs');
const estadoCiclo = require('./estado-ciclo.cjs');

const SEVERIDAD = { STOP: 'alta', FAIL: 'alta', FAILED: 'alta', BROKEN: 'alta', REGRESSION: 'alta', RECOVERY_FAILED: 'alta', DOUBT: 'media', WARN: 'baja' };
const CIERRE = ['PASS', 'VERIFIED', 'RECOVERED', 'RESOLVED', 'OK'];
const SEVERIDADES = ['alta', 'media', 'baja'];
const RANGO = { alta: 3, media: 2, baja: 1 };
const VEREDICTOS = Object.keys(SEVERIDAD).concat(CIERRE);

const msDe = (x) => { const d = fechaMod.fechaUtc(x); return d && !isNaN(d) ? d.getTime() : null; };
const iso = (t) => (t == null ? null : new Date(t).toISOString());
const pj = (s) => { if (s && typeof s === 'object') return s; try { return JSON.parse(s || '{}') || {}; } catch { return {}; } };
const sujeto = (e) => [String(e.gate || '').replace(/-transition$/, ''), e.behavior_id || '', e.file || ''].join('|');

/* ─── D11: incidentes ─────────────────────────────────────────────────────── */

/**
 * Agrupa eventos de control en incidentes con identidad estable. Un cierre
 * (PASS/VERIFIED/RECOVERED) del mismo sujeto lo resuelve; si vuelve a fallar
 * después, es una recurrencia — salvo que sea el mismo subject_hash que se
 * verificó, que entonces es un resultado inestable, no una regresión.
 */
function incidentes(eventos) {
  const vistos = new Set();
  const lista = [];
  for (const e of eventos || []) {
    const k = e.event_id || 'row-' + e.id;
    if (vistos.has(k)) continue;
    vistos.add(k);
    const v = String(e.verdict || '').toUpperCase();
    if (!SEVERIDAD[v] && !CIERRE.includes(v)) continue;
    lista.push(Object.assign({}, e, { _v: v, _t: msDe(e.ts), _d: pj(e.detalle) }));
  }
  lista.sort((a, b) => ((a._t == null ? Infinity : a._t) - (b._t == null ? Infinity : b._t)) || ((a.id || 0) - (b.id || 0)));

  const porClave = new Map();
  const porSujeto = new Map();
  for (const e of lista) {
    if (SEVERIDAD[e._v]) {
      const clave = e.incident_id || sujeto(e);
      let inc = porClave.get(clave);
      if (!inc) {
        inc = { id: clave, gate: e.gate, file: e.file || null, behavior_id: e.behavior_id || null, verdict: e._v, severidad: SEVERIDAD[e._v],
          first_seen: e.ts, last_seen: e.ts, occurrences: 0, resolved_at: null, abierto: false, recurrencias: [], inestable: 0,
          cierre: null, ciclos: new Set(), eventos: [], periodos: [], _desde: null, _alta: false, _obs: 0 };
        porClave.set(clave, inc);
      }
      const s = sujeto(e);
      if (!porSujeto.has(s)) porSujeto.set(s, new Set());
      porSujeto.get(s).add(clave);
      observar(inc, e);
    } else {
      const claves = new Set(porSujeto.get(sujeto(e)) || []);
      if (e.incident_id && porClave.has(e.incident_id)) claves.add(e.incident_id);
      for (const c of claves) cerrar(porClave.get(c), e);
    }
  }
  return [...porClave.values()].map((inc) => {
    if (inc.abierto) inc.periodos.push({ desde: inc._desde, hasta: null, alta: inc._alta });
    const estado = inc.recurrencias.length ? 'RECURRENTE' : !inc.abierto ? 'RESUELTO' : inc._obs > 1 ? 'PERSISTENTE' : 'ABIERTO';
    const { _desde, _alta, _obs, ...resto } = inc;
    return Object.assign(resto, { estado, ciclos: [...inc.ciclos], eventos: inc.eventos.slice(-20) });
  }).sort((a, b) => (RANGO[b.severidad] - RANGO[a.severidad]) || (b.occurrences - a.occurrences) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function observar(inc, e) {
  inc.occurrences++;
  inc.last_seen = e.ts;
  inc.eventos.push(e.event_id || 'row-' + e.id);
  if (e.cycle_id) inc.ciclos.add(e.cycle_id);
  if (RANGO[SEVERIDAD[e._v]] > RANGO[inc.severidad]) { inc.severidad = SEVERIDAD[e._v]; inc.verdict = e._v; }
  if (!inc.abierto) {
    if (inc.cierre) {
      const antes = inc.cierre.subject_hash;
      if (antes && e._d.subject_hash && antes === e._d.subject_hash) inc.inestable++;
      else inc.recurrencias.push({ cerrado_en: inc.cierre.at, reaparece_en: e.ts, original_task_id: inc.cierre.cycle_id, original_execution_id: inc.cierre.execution_id, event_id: e.event_id || null, repair_execution_id: null, repair_task_id: null });
      inc.resolved_at = null;
    }
    inc.abierto = true;
    inc._desde = e._t;
    inc._alta = false;
    inc._obs = 0;
  }
  inc._obs++;
  if (SEVERIDAD[e._v] === 'alta') inc._alta = true;
}

function cerrar(inc, e) {
  if (!inc || !inc.abierto) return;
  inc.abierto = false;
  inc.resolved_at = e.ts;
  inc.cierre = { at: e.ts, verdict: e._v, event_id: e.event_id || null, cycle_id: e.cycle_id || null,
    execution_id: e._d.execution_id || null, subject_hash: e._d.subject_hash || null, evidence_id: e._d.evidence_id || null };
  const ultima = inc.recurrencias[inc.recurrencias.length - 1];
  if (ultima && !ultima.repair_execution_id && !ultima.repair_task_id) { ultima.repair_execution_id = inc.cierre.execution_id; ultima.repair_task_id = inc.cierre.cycle_id; }
  inc.periodos.push({ desde: inc._desde, hasta: e._t, alta: inc._alta });
}

/* ─── D10: retrabajo ──────────────────────────────────────────────────────── */

const ES_ARREGLO = /^(fix|bugfix|hotfix|arreglo)$/i;

/**
 * Retrabajo por tareas: reaperturas de entregas verificadas sobre entregas
 * verificadas. Las regresiones de un comportamiento sin tarea enlazada se
 * cuentan aparte; los arreglos sin vínculo no son retrabajo, son desconocido.
 */
function retrabajo(ciclos, incs) {
  const lista = ciclos || [];
  const porId = new Map(lista.map((c) => [c.ciclo_id, c]));
  const verificada = (id) => !!id && porId.has(id) && estadoCiclo.clasificar(porId.get(id).estado) === 'VERIFICADO';
  const reaperturas = [];
  const regresiones = [];
  for (const c of lista) {
    const original = c.original_task_id || c.reabre_ciclo || null;
    if (!original) continue;
    const r = { incident_id: null, original_task_id: original, reopened_at: c.fecha_inicio || null, repair_execution_id: c.ciclo_id, razon: c.tarea || null, modulo: (porId.get(original) || c).modulo || null, origen: 'ciclo' };
    if (verificada(original)) reaperturas.push(r);
  }
  for (const i of incs || []) {
    for (const rec of i.recurrencias) {
      const r = { incident_id: i.id, original_task_id: rec.original_task_id, original_execution_id: rec.original_execution_id, reopened_at: rec.reaparece_en,
        repair_execution_id: rec.repair_execution_id || rec.repair_task_id, razon: `${i.gate} ${i.verdict}${i.file ? ' en ' + i.file : ''}`, modulo: rec.original_task_id && porId.has(rec.original_task_id) ? porId.get(rec.original_task_id).modulo : null, origen: 'incidente' };
      if (verificada(rec.original_task_id)) reaperturas.push(r); else regresiones.push(r);
    }
  }
  const verificadas = lista.filter((c) => estadoCiclo.clasificar(c.estado) === 'VERIFICADO');
  const vinculados = new Set(reaperturas.map((r) => r.repair_execution_id).filter(Boolean));
  const arreglosSinVinculo = lista.filter((c) => ES_ARREGLO.test(String(c.tipo_tarea || '')) && !(c.original_task_id || c.reabre_ciclo) && !vinculados.has(c.ciclo_id)).length;
  const auditoria = lista.filter((c) => /^audit/i.test(String(c.tipo_tarea || ''))).length;
  const porModulo = {};
  for (const c of verificadas) { const m = c.modulo || '(sin módulo)'; porModulo[m] = porModulo[m] || { entregas_verificadas: 0, reaperturas: 0 }; porModulo[m].entregas_verificadas++; }
  for (const r of reaperturas) { const m = r.modulo || '(sin módulo)'; porModulo[m] = porModulo[m] || { entregas_verificadas: 0, reaperturas: 0 }; porModulo[m].reaperturas++; }
  for (const m of Object.values(porModulo)) m.tasa = m.entregas_verificadas ? Math.round((m.reaperturas * 100) / m.entregas_verificadas) : null;
  return {
    denominador: 'entregas verificadas',
    entregas_verificadas: verificadas.length,
    reaperturas: reaperturas.length,
    tasa: verificadas.length ? Math.round((reaperturas.length * 100) / verificadas.length) : null,
    regresiones: regresiones.length,
    arreglos_sin_vinculo: arreglosSinVinculo,
    auditoria,
    detalle: reaperturas.concat(regresiones).slice(0, 50),
    por_modulo: porModulo,
  };
}

/* ─── D12/D15: intervalos ─────────────────────────────────────────────────── */

/** Unión de intervalos [desde, hasta]: dos horas simultáneas son una hora de calendario. */
function union(intervalos) {
  const v = (intervalos || []).filter((i) => i && i.desde != null && i.hasta != null && i.hasta >= i.desde).sort((a, b) => a.desde - b.desde);
  let total = 0;
  let ini = null;
  let fin = null;
  for (const i of v) {
    if (fin == null || i.desde > fin) { if (fin != null) total += fin - ini; ini = i.desde; fin = i.hasta; } else if (i.hasta > fin) fin = i.hasta;
  }
  if (fin != null) total += fin - ini;
  return total;
}

function medir(intervalos) {
  const v = (intervalos || []).filter((i) => i && i.desde != null && i.hasta != null);
  if (!v.length) return { acumulado_ms: null, calendario_ms: null, transcurrido_ms: null, intervalos: 0 };
  return {
    acumulado_ms: v.reduce((a, i) => a + (i.hasta - i.desde), 0),
    calendario_ms: union(v),
    transcurrido_ms: Math.max(...v.map((i) => i.hasta)) - Math.min(...v.map((i) => i.desde)),
    intervalos: v.length,
  };
}

/* ─── D12: fricción ───────────────────────────────────────────────────────── */

/**
 * Cuántos incidentes por severidad, cuánto tiempo bloqueado se MIDIÓ y qué
 * tareas tocó. Un aviso no bloquea; un STOP bloquea desde que salta hasta que
 * se verifica el cierre. Lo que sigue abierto termina en `snapshot_at` y se
 * marca en curso — no se mezcla con lo cerrado.
 */
function friccion(incs, { snapshotAt = Date.now(), decisiones = [] } = {}) {
  const por_severidad = Object.fromEntries(SEVERIDADES.map((s) => [s, { incidentes: 0, eventos: 0 }]));
  const cerrados = [];
  const abiertos = [];
  const tareas = new Set();
  for (const i of incs || []) {
    por_severidad[i.severidad].incidentes++;
    por_severidad[i.severidad].eventos += i.occurrences;
    for (const c of i.ciclos) tareas.add(c);
    for (const p of i.periodos) {
      if (!p.alta || p.desde == null) continue;
      if (p.hasta == null) abiertos.push({ desde: p.desde, hasta: Math.max(snapshotAt, p.desde), incidente: i.id });
      else cerrados.push({ desde: p.desde, hasta: p.hasta, incidente: i.id });
    }
  }
  const mc = medir(cerrados);
  const ma = medir(abiertos);
  return {
    snapshot_at: iso(snapshotAt),
    incidentes: (incs || []).length,
    eventos: (incs || []).reduce((a, i) => a + i.occurrences, 0),
    por_severidad,
    bloqueo: {
      medido: { n: cerrados.length, calendario_ms: mc.calendario_ms, acumulado_ms: mc.acumulado_ms },
      en_curso: { n: abiertos.length, calendario_ms: ma.calendario_ms, acumulado_ms: ma.acumulado_ms, desde: abiertos.length ? iso(Math.min(...abiertos.map((a) => a.desde))) : null },
    },
    tareas_afectadas: tareas.size,
    decisiones: (decisiones || []).map((d) => {
      const ev = Array.isArray(d.evidence) ? d.evidence : [];
      const alt = d.alternatives || d.options || ev.flatMap((x) => (x && (x.alternativas || x.opciones)) || []);
      return { id: d.id, pregunta: d.question || null, alternativas: Array.isArray(alt) ? alt : [], impacto: d.affected_tasks || [], sigue: d.safe_independent_tasks || [], desde: d.created_at || null, motivo: d.reason_code || null };
    }),
  };
}

/* ─── D13: top-N con "otros" ──────────────────────────────────────────────── */

const cmpTexto = (a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);

/**
 * Las N filas más grandes y el resto agregado en "otros". El total sale de
 * todos los grupos (o de la consulta de agregación si se pasa) — nunca de la
 * suma de lo mostrado. Empates por clave estable.
 */
function topN(grupos, n, totalAgregado) {
  const todos = [...(grupos || [])].sort((a, b) => ((b.n || 0) - (a.n || 0)) || cmpTexto(a.archivo, b.archivo) || cmpTexto(a.gate, b.gate) || cmpTexto(a.verdict, b.verdict));
  const filas = todos.slice(0, n);
  const resto = todos.slice(n);
  const total = totalAgregado != null ? Number(totalAgregado) : todos.reduce((a, g) => a + (g.n || 0), 0);
  const mostrado = filas.reduce((a, g) => a + (g.n || 0), 0);
  const otros = resto.reduce((a, g) => a + (g.n || 0), 0);
  return { filas, grupos: todos.length, otros_grupos: resto.length, otros_eventos: otros, total, cuadra: mostrado + otros === total };
}

/* ─── D14: actividad ──────────────────────────────────────────────────────── */

const UMBRAL_HEURISTICO_MS = 3.5 * 60 * 1000; // sin latido real: heurística por antigüedad de la tarea abierta

const lockDe = (m, locks, ahora) => (locks || []).find((l) => {
  const n = String(l.module_name || '');
  return (n === m || n.endsWith('-' + m) || n.startsWith(m + '-')) && (msDe(l.expires_at) || 0) > ahora;
});

/**
 * Estado de cada módulo sin deducir nada de fechas de archivo:
 *   ESTABLE              sin tarea abierta (terminado hace meses también)
 *   TRABAJANDO           tarea abierta con lease vigente (el lease es su latido)
 *   POSIBLE_INACTIVIDAD  tarea abierta sin lease más allá del umbral — heurística
 */
function actividad({ modulos, ciclos, locks, ahora = Date.now() }) {
  const abiertas = (ciclos || []).filter((c) => estadoCiclo.clasificar(c.estado) === 'EN_CURSO');
  const lista = (modulos || []).map((t) => {
    const m = String(t.m);
    const suyas = abiertas.filter((c) => String(c.modulo || '(sin módulo)') === m);
    if (!suyas.length) return { m, estado: 'ESTABLE', heuristico: false, detalle: 'sin tarea abierta' };
    const l = lockDe(m, locks, ahora);
    if (l) return { m, estado: 'TRABAJANDO', heuristico: false, detalle: 'lease vigente hasta ' + iso(msDe(l.expires_at)) };
    const inicio = Math.min(...suyas.map((c) => msDe(c.fecha_inicio)).filter((x) => x != null));
    const ausente = isFinite(inicio) ? ahora - inicio : null;
    if (ausente == null) return { m, estado: 'POSIBLE_INACTIVIDAD', heuristico: true, detalle: 'tarea abierta sin fecha de inicio ni latido' };
    return ausente > UMBRAL_HEURISTICO_MS
      ? { m, estado: 'POSIBLE_INACTIVIDAD', heuristico: true, ausente_ms: ausente, detalle: 'sin latido ni lease: heurística por antigüedad de la tarea abierta' }
      : { m, estado: 'TRABAJANDO', heuristico: true, ausente_ms: ausente, detalle: 'abierta hace poco; sin latido real' };
  });
  const conteo = {};
  for (const x of lista) conteo[x.estado] = (conteo[x.estado] || 0) + 1;
  return { modulos: lista, conteo, equipo: null, umbral_ms: UMBRAL_HEURISTICO_MS };
}

/* ─── D15: tiempos ────────────────────────────────────────────────────────── */

/** Intervalo medido de un ciclo o fase: termina en su fecha de fin y dura lo medido. */
function intervaloDe(fila) {
  const dur = Number(fila.duracion_ms) || 0;
  const fin = msDe(fila.fecha_fin);
  if (dur <= 0 || fin == null) return null;
  return { desde: fin - dur, hasta: fin };
}

/**
 * Tres números que no se mezclan: transcurrido (fin − inicio), acumulado
 * (suma de lo medido) y calendario activo (unión). Un ciclo sin duración es
 * "sin dato", no cero. El presupuesto sale del plan, si lo fija.
 */
function tiempos({ ciclos, fases, plan } = {}) {
  const porMod = new Map();
  const todos = [];
  let sinDato = 0;
  for (const c of ciclos || []) {
    const m = c.modulo || '(sin módulo)';
    if (!porMod.has(m)) porMod.set(m, { iv: [], sin_dato: 0, ciclos: 0 });
    const e = porMod.get(m);
    e.ciclos++;
    const iv = intervaloDe(c);
    if (iv) { e.iv.push(iv); todos.push(iv); } else { e.sin_dato++; sinDato++; }
  }
  const porAgente = new Map();
  for (const f of fases || []) {
    const a = f.agente || '(sin agente)';
    if (!porAgente.has(a)) porAgente.set(a, { iv: [], sin_dato: 0 });
    const iv = intervaloDe(f);
    if (iv) porAgente.get(a).iv.push(iv); else porAgente.get(a).sin_dato++;
  }
  const limites = plan && plan.limits ? pj(plan.limits) : null;
  return {
    total: Object.assign(medir(todos), { con_dato: todos.length, sin_dato: sinDato }),
    por_modulo: Object.fromEntries([...porMod].map(([m, e]) => [m, Object.assign(medir(e.iv), { con_dato: e.iv.length, sin_dato: e.sin_dato, ciclos: e.ciclos })])),
    por_agente: Object.fromEntries([...porAgente].map(([a, e]) => [a, Object.assign(medir(e.iv), { con_dato: e.iv.length, sin_dato: e.sin_dato })])),
    presupuesto: limites && (limites.max_minutos_plan != null || limites.max_intentos_plan != null)
      ? { max_minutos_plan: limites.max_minutos_plan ?? null, max_intentos_plan: limites.max_intentos_plan ?? null } : null,
  };
}

const CONSULTAS = {
  eventosOperativos: { tabla: 'gate_events', sql: `SELECT id, ts, gate, verdict, behavior_id, file, detalle, cycle_id, event_id, incident_id FROM gate_events WHERE verdict IN (${VEREDICTOS.map((v) => `'${v}'`).join(',')}) ORDER BY id` },
  friccionGrupos: { tabla: 'gate_events', sql: "SELECT IFNULL(file,'(sin archivo)') archivo, gate, verdict, COUNT(*) n, MAX(ts) ultimo FROM gate_events WHERE verdict IN ('STOP','WARN','DOUBT') GROUP BY archivo, gate, verdict" },
  friccionTotal: { tabla: 'gate_events', sql: "SELECT COUNT(*) n FROM gate_events WHERE verdict IN ('STOP','WARN','DOUBT')" },
  locks: { tabla: 'module_locks', sql: 'SELECT module_name, instance_id, acquired_at, expires_at FROM module_locks' },
  fasesTodas: { tabla: 'fases', sql: 'SELECT ciclo_id, agente, duracion_ms, fecha_inicio, fecha_fin FROM fases' },
};

/** Todo lo operativo a partir de las filas ya leídas en una misma lectura. */
function operativa({ ciclos, eventos, grupos, totalFriccion, locks, fases, modulos, ahora = Date.now(), top = 40 }) {
  const incs = incidentes(eventos);
  return {
    incidentes: incs,
    retrabajo: retrabajo(ciclos, incs),
    friccion: friccion(incs, { snapshotAt: ahora, decisiones: [] }),
    top: topN(grupos, top, totalFriccion),
    actividad: actividad({ modulos, ciclos, locks, ahora }),
    tiempos: tiempos({ ciclos, fases, plan: null }),
  };
}

module.exports = { incidentes, retrabajo, friccion, topN, actividad, tiempos, union, medir, operativa, CONSULTAS, SEVERIDAD, CIERRE, UMBRAL_HEURISTICO_MS };
