'use strict';

/**
 * Reloj derivado — la duración se deduce de huellas mecánicas, no de la memoria
 * de nadie.
 *
 * EL PROBLEMA QUE CIERRA
 * ----------------------
 * `linea-tiempo.cjs inicio` es un paso de protocolo: alguien tiene que
 * acordarse de marcarlo. En D:\360, de 155 ciclos registrados, 96 tenían
 * `duracion_ms = 0` — y en los 96, `fecha_inicio` y `fecha_fin` eran el MISMO
 * segundo. El dato no se perdió: nunca se tomó. El post-cycle registró el
 * ciclo al cerrar y estampó las dos fechas con "ahora".
 *
 * O sea: el 62% de la columna principal de la pantalla de tiempos estaba vacía,
 * y encima vacía de una forma que parece un cero.
 *
 * DE DÓNDE SALE LA DURACIÓN AHORA
 * -------------------------------
 * De cuatro huellas que ya se escriben solas, probadas en este orden:
 *
 *   0. MARCA DE ARRANQUE — el context-enricher corre al principio de cada
 *      ciclo (paso 0.1 del pipeline) y ahora deja su hora al pasar. Es la
 *      única que da el inicio exacto; las otras tres lo deducen.
 *
 *   1. VENTANA DE LOCK — el lock-manager escribe `acquired_at`/`released_at`
 *      cada vez que un agente toma y suelta un módulo. Marca exactamente
 *      cuándo se estuvo trabajando ese módulo.
 *
 *   2. COMMITS — los commits entre el cierre del ciclo anterior y el de este,
 *      agrupados en tandas: un hueco de más de 90 minutos separa dos sesiones.
 *      Se suman las sesiones, no el rango completo — entre tanda y tanda hay
 *      noches y fines de semana.
 *
 *   3. EVENTOS DE CONTROL — la más débil: las horas de los gates que corrieron
 *      durante el ciclo. Si todos corrieron juntos al cerrar, el lapso es cero
 *      y se declara sin dato, que es lo correcto.
 *
 * Un proyecto sin git y sin locks solo tiene la 0 y la 3. Por eso el histórico
 * anterior a que existieran esas huellas NO se puede recuperar entero: no es
 * un fallo del cálculo, es que el rastro no se escribió nunca.
 *
 * LO QUE NO HACE, A PROPÓSITO
 * ---------------------------
 * Si un ciclo tiene un solo commit y ninguna ventana de lock, NO se inventa una
 * duración. Un commit suelto no dice cuánto se tardó en escribirlo. Ese ciclo
 * se queda sin dato, y sin dato es la respuesta correcta — un cero inventado
 * ensucia todos los promedios que alguien vaya a mirar después.
 *
 * Cada duración queda marcada con su origen (`medido`, `marca`, `lock`, `git`,
 * `gates`) para que
 * la pantalla pueda decir de dónde salió en vez de fingir que todo se midió
 * igual.
 *
 *   node .agentic/grafo/reloj-derivado.cjs backfill [--dry]
 *   node .agentic/grafo/reloj-derivado.cjs estado
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const safe = (fn, fb = null) => { try { return fn(); } catch { return fb; } };

/* Un hueco mayor que esto separa dos tandas de trabajo. Noventa minutos es
   suficiente para no partir una pausa de café y corto para no fundir en una
   sola sesión el trabajo de la mañana y el de la tarde. */
const HUECO_SESION_MS = 90 * 60 * 1000;

/* Tolerancia para emparejar una ventana de lock con el cierre de un ciclo:
   entre que se suelta el lock y se registra el ciclo pasan segundos, no horas. */
const TOLERANCIA_MS = 15 * 60 * 1000;

function openDB(root, { write = false } = {}) {
  const p = path.join(root, '.agentic', 'memoria.db');
  if (!fs.existsSync(p)) return null;
  try {
    const BS3 = require('better-sqlite3');
    return write ? new BS3(p) : new BS3(p, { readonly: true });
  } catch {}
  try {
    const { DatabaseSync } = require('node:sqlite');
    return new DatabaseSync(p, write ? {} : { readOnly: true });
  } catch {}
  return null;
}

/** Las fechas de `ciclos` vienen en UTC sin zona explícita. */
const aMs = (s) => {
  if (!s) return null;
  const t = Date.parse(String(s).includes('T') ? s : String(s).replace(' ', 'T') + 'Z');
  return Number.isNaN(t) ? null : t;
};
const aTexto = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

function asegurarColumna(db) {
  safe(() => db.exec('ALTER TABLE ciclos ADD COLUMN duracion_origen TEXT'));
}

/* ── ancla 0: la marca que deja el enricher al arrancar ────────────────────
   El enricher corre al principio de CADA ciclo (paso 0.1 del pipeline), así que
   marcar ahí el arranque no depende de que nadie recuerde un comando aparte:
   va pegado a algo que ya ocurre siempre. Es la única ancla que da la hora de
   inicio exacta; las demás la deducen. */

function marcaDeArranque(db, ciclo) {
  const fin = aMs(ciclo.fecha_fin);
  if (fin == null) return null;
  const fila = safe(() => db.prepare(
    `SELECT ts FROM gate_events
      WHERE verdict = 'CICLO_INICIO' AND ts <= ?
      ORDER BY ts DESC LIMIT 1`
  ).get(aTexto(fin)), null);
  if (!fila) return null;
  const ini = aMs(fila.ts);
  if (ini == null || ini >= fin) return null;
  /* Una marca de hace tres días no es el arranque de este ciclo: es una que
     quedó huérfana porque aquel ciclo nunca cerró. */
  if (fin - ini > 12 * 3600 * 1000) return null;
  return { ini, fin };
}

/* ── ancla 3: los eventos de gate del propio ciclo ─────────────────────────
   Cada ciclo dispara controles (seguridad, TDD, spec…) y cada uno deja su hora.
   Agrupados en tandas dan la ventana de trabajo. Es la más débil de las
   anclas — si todos los controles corren juntos al cerrar, el lapso es cero y
   entonces se declara sin dato, que es lo correcto. */

function eventosEntre(db, desdeMs, hastaMs) {
  if (desdeMs == null || hastaMs == null || hastaMs <= desdeMs) return [];
  const filas = safe(() => db.prepare(
    'SELECT ts FROM gate_events WHERE ts > ? AND ts <= ? ORDER BY ts'
  ).all(aTexto(desdeMs), aTexto(hastaMs)), []) || [];
  return filas.map((r) => aMs(r.ts)).filter((n) => n != null);
}

/* ── ancla 1: las ventanas de lock ─────────────────────────────────────────── */

function ventanasDeLock(db) {
  const filas = safe(() => db.prepare(
    "SELECT detalle FROM gate_events WHERE verdict = 'LOCK_WINDOW'"
  ).all(), []) || [];

  const out = [];
  for (const f of filas) {
    const d = safe(() => JSON.parse(f.detalle), null);
    if (!d || !d.acquired_at || !d.released_at) continue;
    const ini = aMs(d.acquired_at);
    const fin = aMs(d.released_at);
    if (ini == null || fin == null || fin <= ini) continue;
    out.push({ modulo: String(d.module || ''), ini, fin });
  }
  out.sort((a, b) => a.fin - b.fin);
  return out;
}

/**
 * La ventana de lock que cerró junto con este ciclo.
 * Se exige que el módulo coincida: dos agentes trabajando a la vez tienen
 * ventanas solapadas, y quedarse con la más cercana sin mirar el módulo
 * atribuiría el trabajo de uno al ciclo del otro.
 */
function ventanaDe(ciclo, ventanas) {
  const fin = aMs(ciclo.fecha_fin);
  if (fin == null) return null;
  const mod = String(ciclo.modulo || '').toLowerCase();

  let mejor = null;
  for (const v of ventanas) {
    if (mod && v.modulo && v.modulo.toLowerCase() !== mod) continue;
    const delta = Math.abs(v.fin - fin);
    if (delta > TOLERANCIA_MS) continue;
    if (!mejor || delta < mejor.delta) mejor = { ...v, delta };
  }
  return mejor;
}

/* ── ancla 2: los commits ──────────────────────────────────────────────────── */

function commitsEntre(root, desdeMs, hastaMs) {
  if (desdeMs == null || hastaMs == null || hastaMs <= desdeMs) return [];
  const cmd = 'git log --format=%cI --since="' + new Date(desdeMs).toISOString() +
              '" --until="' + new Date(hastaMs).toISOString() + '"';
  const out = safe(() => execSync(cmd, { cwd: root, stdio: 'pipe', timeout: 20000 }).toString(), '');
  return out.split('\n').map((s) => aMs(s.trim())).filter((n) => n != null).sort((a, b) => a - b);
}

/**
 * Agrupa marcas de tiempo en tandas y suma solo el tiempo DENTRO de cada tanda.
 * Devuelve null si no hay ninguna tanda de dos o más commits: con una sola
 * marca no se puede saber cuánto duró, y estimarlo sería inventarlo.
 */
function tandas(marcas) {
  if (marcas.length < 2) return null;
  const sesiones = [];
  let ini = marcas[0], prev = marcas[0];
  for (const m of marcas.slice(1)) {
    if (m - prev > HUECO_SESION_MS) { sesiones.push([ini, prev]); ini = m; }
    prev = m;
  }
  sesiones.push([ini, prev]);
  const total = sesiones.reduce((s, [a, b]) => s + (b - a), 0);
  return total > 0 ? { ms: total, inicio: sesiones[0][0], sesiones: sesiones.length } : null;
}

/* ── derivación ────────────────────────────────────────────────────────────── */

/**
 * Deduce la duración de un ciclo. No escribe nada.
 * @returns {ms, inicio, origen, detalle} | null si no hay forma honesta de saberlo
 */
function derivar(root, db, ciclo, { ventanas = null, cierreAnterior = null } = {}) {
  /* Ancla 0 — la marca del enricher. La más exacta: da la hora real, no la
     deduce. Va primera por eso. */
  const marca = marcaDeArranque(db, ciclo);
  if (marca) {
    return {
      ms: marca.fin - marca.ini,
      inicio: aTexto(marca.ini),
      origen: 'marca',
      detalle: 'arranque marcado por el enricher',
    };
  }

  const v = ventanaDe(ciclo, ventanas || ventanasDeLock(db));
  if (v) {
    return {
      ms: v.fin - v.ini,
      inicio: aTexto(v.ini),
      origen: 'lock',
      detalle: 'ventana de lock del módulo ' + (v.modulo || '?'),
    };
  }

  const fin = aMs(ciclo.fecha_fin);
  if (fin == null) return null;
  /* Sin cierre anterior conocido se mira un día hacia atrás: más que eso
     arrastraría trabajo de otras tareas al de esta. */
  const desde = cierreAnterior != null ? cierreAnterior : fin - 24 * 3600 * 1000;
  const t = tandas(commitsEntre(root, desde, fin));
  if (t) {
    return {
      ms: t.ms,
      inicio: aTexto(t.inicio),
      origen: 'git',
      detalle: t.sesiones + ' tanda(s) de commits',
    };
  }

  /* Última ancla: los controles que corrieron durante el ciclo. */
  const e = tandas(eventosEntre(db, desde, fin));
  if (e) {
    return {
      ms: e.ms,
      inicio: aTexto(e.inicio),
      origen: 'gates',
      detalle: e.sesiones + ' tanda(s) de eventos de control',
    };
  }

  /* Sin huella suficiente. Devolver null es la respuesta honesta: un ciclo sin
     duración NO es un ciclo de cero minutos. */
  return null;
}

/**
 * Rellena la duración de todos los ciclos que no la tienen.
 * @returns {revisados, derivados, sinDato, porOrigen}
 */
function backfill(root, { dry = false } = {}) {
  const db = openDB(root, { write: !dry });
  if (!db) return { error: 'sin memoria.db' };
  if (!dry) asegurarColumna(db);

  const ciclos = safe(() => db.prepare(
    'SELECT id, ciclo_id, tarea, modulo, fecha_inicio, fecha_fin, duracion_ms FROM ciclos ORDER BY fecha_fin'
  ).all(), []) || [];

  const ventanas = ventanasDeLock(db);
  const res = { revisados: 0, derivados: 0, sinDato: 0, porOrigen: { marca: 0, lock: 0, git: 0, gates: 0 }, ejemplos: [] };

  let cierreAnterior = null;
  for (const c of ciclos) {
    const finMs = aMs(c.fecha_fin);
    if (c.duracion_ms > 0) { cierreAnterior = finMs; continue; }

    res.revisados++;
    const d = derivar(root, db, c, { ventanas, cierreAnterior });
    cierreAnterior = finMs;

    if (!d) { res.sinDato++; continue; }

    res.derivados++;
    res.porOrigen[d.origen] = (res.porOrigen[d.origen] || 0) + 1;
    if (res.ejemplos.length < 5) {
      res.ejemplos.push({ tarea: String(c.tarea || '').slice(0, 52), ms: d.ms, origen: d.origen });
    }

    if (!dry) {
      safe(() => db.prepare(
        'UPDATE ciclos SET duracion_ms = ?, fecha_inicio = ?, duracion_origen = ? WHERE id = ?'
      ).run(d.ms, d.inicio, d.origen, c.id));
    }
  }

  /* Lo que ya venía medido se marca como tal, para que la pantalla distinga. */
  if (!dry) {
    safe(() => db.prepare(
      "UPDATE ciclos SET duracion_origen = 'medido' WHERE duracion_ms > 0 AND duracion_origen IS NULL"
    ).run());
  }

  safe(() => db.close());
  return res;
}

/** Se llama al cerrar un ciclo: si quedó sin duración, se deduce en el acto. */
function completarUltimo(root) {
  const db = openDB(root, { write: true });
  if (!db) return null;
  asegurarColumna(db);
  const c = safe(() => db.prepare(
    'SELECT id, ciclo_id, tarea, modulo, fecha_inicio, fecha_fin, duracion_ms FROM ciclos ORDER BY id DESC LIMIT 1'
  ).get(), null);
  if (!c || c.duracion_ms > 0) { safe(() => db.close()); return null; }

  const anterior = safe(() => db.prepare(
    'SELECT fecha_fin FROM ciclos WHERE id < ? ORDER BY id DESC LIMIT 1'
  ).get(c.id), null);

  const d = derivar(root, db, c, { cierreAnterior: anterior ? aMs(anterior.fecha_fin) : null });
  if (d) {
    safe(() => db.prepare(
      'UPDATE ciclos SET duracion_ms = ?, fecha_inicio = ?, duracion_origen = ? WHERE id = ?'
    ).run(d.ms, d.inicio, d.origen, c.id));
  }
  safe(() => db.close());
  return d;
}

function estado(root) {
  const db = openDB(root);
  if (!db) return { error: 'sin memoria.db' };
  const t = safe(() => db.prepare('SELECT COUNT(*) c FROM ciclos').get().c, 0);
  const con = safe(() => db.prepare('SELECT COUNT(*) c FROM ciclos WHERE duracion_ms > 0').get().c, 0);
  const porOrigen = safe(() => db.prepare(
    'SELECT duracion_origen o, COUNT(*) c FROM ciclos WHERE duracion_ms > 0 GROUP BY 1'
  ).all(), []) || [];
  safe(() => db.close());
  return { total: t, conDuracion: con, cobertura: t ? Math.round((con / t) * 100) : 0, porOrigen };
}

const dur = (ms) => {
  const m = Math.round(ms / 60000);
  if (m < 60) return m + ' min';
  return Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0') + ' min';
};

if (require.main === module) {
  const cmd = process.argv[2] || 'estado';
  const root = process.cwd();

  if (cmd === 'backfill') {
    const dry = process.argv.includes('--dry');
    const r = backfill(root, { dry });
    if (r.error) { console.log('RELOJ DERIVADO — ' + r.error); process.exit(0); }
    console.log(`RELOJ DERIVADO${dry ? ' (simulación)' : ''} — ${r.revisados} ciclo(s) sin duración:`);
    console.log(`  ${r.derivados} deducido(s)  ·  ` + Object.entries(r.porOrigen).filter(([, n]) => n).map(([k, n]) => n + ' por ' + ({ marca: 'marca de arranque', lock: 'ventana de lock', git: 'commits', gates: 'eventos de control' }[k] || k)).join(', '));
    console.log(`  ${r.sinDato} sin dato — no hay huella suficiente y no se inventa`);
    if (r.ejemplos.length) {
      console.log('\n  muestra:');
      r.ejemplos.forEach((e) => console.log(`    ${dur(e.ms).padStart(11)} · [${e.origen}] ${e.tarea}`));
    }
    process.exit(0);
  }

  const e = estado(root);
  if (e.error) { console.log('RELOJ DERIVADO — ' + e.error); process.exit(0); }
  console.log(`RELOJ — ${e.conDuracion}/${e.total} ciclos con duración (${e.cobertura}%)`);
  e.porOrigen.forEach((o) => console.log(`   ${String(o.c).padStart(4)}  ${o.o || '(sin marcar)'}`));
  process.exit(0);
}

module.exports = {
  backfill, derivar, completarUltimo, estado, tandas, ventanasDeLock,
  marcaDeArranque, eventosEntre, HUECO_SESION_MS,
};
