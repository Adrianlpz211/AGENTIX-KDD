'use strict';
/**
 * Vigilancia de TEAMS (spec §6 y §12): watch + respaldo independientes, métricas por etapa, tarea de Windows
 * controlada, apagado verificado y capacidades honestas.
 *
 * Nivel A: mecanismo determinista. El reloj de los 180 s es SIMULADO (reloj inyectable) y el Programador de tareas se
 * sustituye por un ejecutor de PowerShell falso: ninguna prueba toca el sistema. Los casos de apagado sí usan
 * procesos reales (un watch propio y un señuelo ajeno).
 *
 * LO QUE NO SE PRUEBA AQUÍ (nivel C, host real): que una sesión de Claude Code o de Cursor LEA de verdad el cambio
 * antes del próximo tick. Aquí solo se prueba que el mecanismo detecta, mide y no confunde detección con recepción.
 *
 *   T07  edición a +20 s tras el segundo loop vacío: detecta y entrega antes del próximo tick de 180 s, con tiempos
 *        medidos y ACK solo tras la lectura confirmada (VISTO)
 *   T08  sin watch el respaldo recoge; sin respaldo el watch atiende: son independientes
 *   T09  los dos roles reciben eventos y respuestas; detectar no es recibir
 *   T10  duplicados / coalescing / fuera de orden: no se pierde una corrección ni se repite una ejecución
 *   T22  apagar detiene lo PROPIO y verifica; lo ajeno no se toca
 *   T26  mismo nombre de proyecto en otra carpeta: no se mezclan eventos ni vigilantes
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { proyectoTeams, REPO } = require('./helpers/teams-proyecto.cjs');
const { SIN_DRIVER } = require('./helpers/db-real.cjs');

const G = path.join(REPO, '.agentic', 'grafo');
const tw = require(path.join(G, 'teams-watch.cjs'));
const vig = require(path.join(G, 'teams-vigilancia.cjs'));
const md = require(path.join(G, 'teams-md-session.cjs'));
const skip = SIN_DRIVER || false;

/** Reloj simulado: el tiempo solo avanza cuando la prueba lo manda. */
function relojFalso(inicioMs = Date.parse('2026-10-03T12:00:00.000Z')) {
  let t = 0; let seq = 0;
  const timers = new Map();
  const programar = (fn, ms, repetir) => { const id = ++seq; timers.set(id, { fn, en: t + ms, cada: repetir ? ms : null }); return id; };
  const r = {
    ahora: () => t, ahoraMs: () => inicioMs + t, iso: () => new Date(inicioMs + t).toISOString(),
    setInterval: (fn, ms) => programar(fn, ms, true), setTimeout: (fn, ms) => programar(fn, ms, false),
    clearInterval: (id) => timers.delete(id), clearTimeout: (id) => timers.delete(id),
    /** Avanza el reloj disparando los temporizadores vencidos en orden. */
    avanzar(ms) {
      const fin = t + ms;
      for (;;) {
        const sig = [...timers.entries()].filter(([, x]) => x.en <= fin).sort((a, b) => a[1].en - b[1].en)[0];
        if (!sig) break;
        const [id, x] = sig; t = x.en;
        if (x.cada) x.en += x.cada; else timers.delete(id);
        x.fn();
      }
      t = fin;
    },
    pendientes: () => timers.size,
  };
  return r;
}

/** Fábrica de fs.watch falsa: deja disparar eventos a mano en el directorio que se quiera. */
function fabricaFalsa() {
  const ws = [];
  const fabrica = (dir, _o, cb) => {
    const w = { dir, cb, cerrado: false, handlers: {}, close() { this.cerrado = true; }, on(ev, h) { this.handlers[ev] = h; return this; } };
    ws.push(w);
    return w;
  };
  fabrica.watchers = ws;
  fabrica.de = (sufijo) => ws.filter((w) => !w.cerrado && w.dir.replace(/\\/g, '/').endsWith(sufijo)).pop();
  fabrica.emitir = (sufijo, tipo, archivo) => { const w = fabrica.de(sufijo); if (w) w.cb(tipo, archivo); return !!w; };
  fabrica.error = (sufijo) => { const w = fabrica.de(sufijo); if (w && w.handlers.error) w.handlers.error(new Error('overflow simulado')); };
  return fabrica;
}

const T = '.agentic/_teams';
const L = '.legion';
const iso = (ms) => new Date(ms).toISOString();

/** Sella la señal de revisión con la hora SIMULADA (el manager la escribe con el reloj real). */
function sellarSenal(p, rol, reloj) {
  const f = path.join(p.root, '.agentic', '_teams', 'rev-' + rol + '.json');
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  fs.writeFileSync(f, JSON.stringify({ seq: j.seq, at: reloj.iso() }));
  return j.seq;
}

/** Una sesión de host SIMULADA: lee lo entregado y confirma con VISTO (lo único que cuenta como lectura real). */
function sesionQueLee(p, rol, registro) {
  return async (eventos) => {
    const ultimo = eventos[eventos.length - 1].seq;
    registro.push(...eventos.map((e) => e.seq));
    md.visto(p.root, { rol, hasta_seq: ultimo });
    return { aceptado: true, hasta_seq: ultimo };
  };
}

const pendientes = (p, rol) => p.tm.delta(p.root, { rol }).eventos.length;
/** El plan ya publicó eventos al crearse: se consumen para empezar cada escenario con la cola de los roles vacía. */
const vaciarColas = (p) => { const ultimo = p.tm.estado(p.root).ultimo_seq; for (const rol of ['builder', 'director']) p.tm.ackSeq(p.root, { rol, seq: ultimo }); };

test('T07: tras el segundo loop vacío, una edición a +20 s se detecta y se entrega ANTES del próximo tick de 180 s, con tiempos medidos y ACK solo tras la lectura', { skip }, async () => {
  const p = proyectoTeams('t07');
  try {
    vaciarColas(p);
    const reloj = relojFalso(); const fab = fabricaFalsa(); const leidos = [];
    const v = new tw.Vigilancia(p.root, { rol: 'builder', intervaloMs: 180000, debounceMs: 500, watchFactory: fab, reloj, onTrabajo: sesionQueLee(p, 'builder', leidos) });
    assert.equal(v.intervaloMs, 180000);
    // El primer lote (la asignación) todavía no existe: dos loops vacíos.
    v.start();
    reloj.avanzar(180000); reloj.avanzar(180000);
    assert.equal(v.stats.pases_vacios, 3, 'arranque + dos loops vacíos');
    assert.equal(leidos.length, 0, 'sin trabajo no se llama al manejador: cero turnos de modelo');
    // +20 s después del segundo loop vacío (t = 380 s) el director publica; llega la señal del watch.
    reloj.avanzar(20000);
    const asg = p.tm.asignar(p.root, { owner_id: 'cursor-1' });
    assert.equal(asg.status, 'ASIGNADA');
    sellarSenal(p, 'builder', reloj);
    const tEdicion = reloj.ahoraMs();
    fab.emitir(T, 'rename', 'rev-builder.json');
    reloj.avanzar(500); // el debounce
    await v.enCurso;
    assert.equal(leidos.length >= 1, true, 'la sesión leyó');
    const m = v.metricas[v.metricas.length - 1];
    assert.equal(m.origen, 'watcher', 'lo atendió el watch, no el respaldo');
    assert.equal(m.aceptado, true);
    assert.ok(m.detectado_ms - tEdicion <= 500, 'detectado dentro del debounce: ' + (m.detectado_ms - tEdicion) + ' ms');
    assert.ok(m.detectado_ms - tEdicion < 180000 - 20000, 'antes del próximo tick (que llegaría a +160 s)');
    // Las cuatro etapas se miden por separado y en orden: detectado → solicitado → atendido → ACK.
    assert.ok(m.detectado_ms <= m.solicitado_ms && m.solicitado_ms <= m.atendido_ms && m.atendido_ms <= m.ack_ms);
    assert.equal(m.lat_deteccion_ms, 500);
    assert.equal(m.diagnostico, 'OK');
    // ACK auténtico: el cursor del rol avanzó porque la sesión confirmó (VISTO), no porque hubo una señal.
    assert.equal(pendientes(p, 'builder'), 0);
    assert.ok(md.sesiones(p.root) && vig.ultimoVisto(p.root, 'builder'), 'quedó el rastro de la lectura confirmada');
    // El próximo tick del respaldo no repite la ejecución: no hay nada nuevo.
    const antes = leidos.length;
    reloj.avanzar(180000);
    assert.equal(leidos.length, antes);
    // Persistido en el libro de métricas.
    const guardadas = tw.resumenMetricas(p.root, 'builder', { conProgreso: false });
    assert.equal(guardadas.disponible, true); assert.equal(guardadas.aceptadas, 1);
    v.stop();
  } finally { p.limpiar(); }
});

test('T07: una señal que solo se IMPRIME (sin lectura confirmada) no hace ACK; el siguiente tick lo reentrega', { skip }, async () => {
  const p = proyectoTeams('t07b');
  try {
    vaciarColas(p);
    const reloj = relojFalso(); const fab = fabricaFalsa();
    let impresos = 0; let leer = false;
    const v = new tw.Vigilancia(p.root, { rol: 'builder', intervaloMs: 180000, watchFactory: fab, reloj, onTrabajo: (evs) => { impresos += evs.length; return leer ? { aceptado: true, hasta_seq: evs[evs.length - 1].seq } : undefined; } });
    v.start();
    p.tm.asignar(p.root, { owner_id: 'cursor-1' });
    sellarSenal(p, 'builder', reloj);
    fab.emitir(T, 'change', 'rev-builder.json');
    reloj.avanzar(500);
    assert.ok(impresos > 0 && v.stats.aceptados === 0, 'detectado y entregado, NO aceptado');
    assert.ok(pendientes(p, 'builder') > 0, 'sin ACK el trabajo sigue pendiente');
    const m = v.metricas[v.metricas.length - 1];
    assert.equal(m.aceptado, false); assert.equal(m.ack_ms, null); assert.equal(m.diagnostico, 'SIN_ACEPTACION');
    leer = true;
    reloj.avanzar(180000);
    assert.equal(pendientes(p, 'builder'), 0, 'el respaldo lo reentregó y esta vez se aceptó');
    assert.equal(v.metricas[v.metricas.length - 1].origen, 'timer');
    v.stop();
  } finally { p.limpiar(); }
});

test('métricas: un host ocupado detecta rápido y atiende lento; el progreso real se mide aparte de la atención', { skip }, async () => {
  const p = proyectoTeams('metricas');
  try {
    vaciarColas(p);
    const reloj = relojFalso(); const fab = fabricaFalsa();
    let soltar;
    const v = new tw.Vigilancia(p.root, { rol: 'builder', intervaloMs: 180000, watchFactory: fab, reloj, onTrabajo: () => new Promise((r) => { soltar = r; }) });
    v.start();
    const asg = p.tm.asignar(p.root, { owner_id: 'cursor-1' });
    sellarSenal(p, 'builder', reloj);
    fab.emitir(T, 'change', 'rev-builder.json');
    reloj.avanzar(500);
    reloj.avanzar(40000); // el host está ocupado 40 s
    soltar({ aceptado: true });
    await v.enCurso;
    const m = v.metricas[v.metricas.length - 1];
    assert.equal(m.lat_deteccion_ms, 500);
    assert.ok(m.lat_atencion_ms >= 40000);
    assert.equal(m.diagnostico, 'DETECTADO_RAPIDO_ATENCION_LENTA', 'se distingue detección de atención');
    // Progreso real: sin ningún evento posterior del builder, la atención NO es progreso.
    const sin = tw.resumenMetricas(p.root, 'builder');
    assert.equal(sin.progreso.con_progreso, 0); assert.equal(sin.progreso.sin_progreso, 1);
    // El builder hace algo de verdad (ACK de la tarea): ahora sí hay progreso, medido tras la atención.
    p.tm.ack(p.root, { delivery_id: asg.assignment.delivery_id, owner_id: 'cursor-1' });
    const con = tw.medirProgreso(p.root, { rol: 'builder', desde_ms: Date.now() - 60000 });
    assert.equal(con.progreso, true);
    v.stop();
  } finally { p.limpiar(); }
});

test('T08: sin watch el respaldo recoge; sin respaldo el watch atiende (son independientes)', { skip }, async () => {
  const p = proyectoTeams('t08');
  try {
    vaciarColas(p);
    // (a) El watch muere (overflow): el respaldo, que no depende de él, recoge en su siguiente tick.
    let reloj = relojFalso(); let fab = fabricaFalsa(); const a = [];
    const va = new tw.Vigilancia(p.root, { rol: 'builder', intervaloMs: 180000, watchFactory: fab, reloj, onTrabajo: (evs) => { a.push(...evs.map((e) => e.seq)); return true; } });
    va.start();
    fab.error(T);
    assert.equal(va.health().watcher, 'MUERTO'); assert.equal(va.health().timer, 'VIVO'); assert.equal(va.health().estado, 'DEGRADED');
    p.tm.asignar(p.root, { owner_id: 'cursor-1' });
    reloj.avanzar(179000);
    assert.equal(a.length, 0, 'sin watch todavía no hay detección…');
    reloj.avanzar(1000);
    assert.ok(a.length >= 1, '…pero el respaldo la recoge en el tick de 180 s');
    assert.equal(va.metricas[va.metricas.length - 1].origen, 'timer');
    assert.equal(va.health().watcher, 'VIVO', 'y reabre el watch');
    assert.equal(va.stats.ultimo_origen, 'reapertura', 'tras reabrir el watch hay un pase de recuperación (catch-up por revisión)');
    va.stop();

    // (b) El respaldo falla (deshabilitado): el watch, que no depende de él, atiende de inmediato.
    reloj = relojFalso(); fab = fabricaFalsa(); const b = [];
    const vb = new tw.Vigilancia(p.root, { rol: 'director', timer: false, watchFactory: fab, reloj, onTrabajo: (evs) => { b.push(...evs.map((e) => e.seq)); return true; } });
    vb.start();
    assert.equal(vb.health().timer, 'DESHABILITADO'); assert.equal(vb.health().estado, 'DEGRADED');
    const antes = b.length;
    const asg = p.tm.asignar(p.root, { owner_id: 'cursor-2' });
    p.tm.ack(p.root, { delivery_id: asg.assignment.delivery_id, owner_id: 'cursor-2' }); // el builder responde → evento para el director
    fab.emitir(T, 'rename', 'rev-director.json');
    reloj.avanzar(500);
    assert.ok(b.length > antes, 'el watch atendió sin respaldo');
    assert.equal(vb.metricas[vb.metricas.length - 1].origen, 'watcher');
    reloj.avanzar(10 * 180000);
    assert.equal(vb.stats.por_origen.timer, undefined, 'sin respaldo no hay ticks: solo lo atendió el watch');
    vb.stop();
  } finally { p.limpiar(); }
});

test('T08: el respaldo no se reinicia con las señales (mantiene su ritmo aunque llegue una ráfaga)', { skip }, () => {
  const p = proyectoTeams('t08b');
  try {
    vaciarColas(p);
    const reloj = relojFalso(); const fab = fabricaFalsa();
    const v = new tw.Vigilancia(p.root, { rol: 'builder', intervaloMs: 180000, watchFactory: fab, reloj, onTrabajo: () => true });
    v.start();
    const ticks = [];
    const original = v.revisar.bind(v);
    v.revisar = (o) => { if (o === 'timer') ticks.push(reloj.ahora()); return original(o); };
    // Ráfaga de señales justo antes del tick: no lo desplaza.
    for (let t = 0; t < 170000; t += 10000) { reloj.avanzar(10000); fab.emitir(T, 'change', 'rev-builder.json'); }
    reloj.avanzar(10000); reloj.avanzar(180000);
    assert.deepEqual(ticks, [180000, 360000], 'los ticks siguen siendo cada 180 s exactos');
    v.stop();
  } finally { p.limpiar(); }
});

test('T09: los DOS roles reciben eventos y respuestas; detectar no es recibir', { skip }, async () => {
  const p = proyectoTeams('t09');
  try {
    vaciarColas(p);
    const reloj = relojFalso(); const fab = fabricaFalsa();
    const delBuilder = []; const delDirector = []; const respuestas = [];
    const vb = new tw.Vigilancia(p.root, { rol: 'builder', watchFactory: fab, reloj, onTrabajo: sesionQueLee(p, 'builder', delBuilder) });
    // El director NO confirma (su sesión no leyó): detecta y entrega, pero no hay ACK.
    const vd = new tw.Vigilancia(p.root, { rol: 'director', watchFactory: fab, reloj, onTrabajo: (evs) => { delDirector.push(...evs.map((e) => e.seq)); return undefined; }, onCanal: (i) => respuestas.push(i.archivo) });
    vb.start(); vd.start();
    const asg = p.tm.asignar(p.root, { owner_id: 'cursor-1' });
    // Los dos watchers sobre el MISMO directorio reciben la señal de SU rol (cada uno ignora la del otro).
    for (const w of fab.watchers.filter((x) => !x.cerrado && x.dir.replace(/\\/g, '/').endsWith(T))) w.cb('change', 'rev-builder.json');
    reloj.avanzar(500); await vb.enCurso;
    assert.ok(delBuilder.length >= 1, 'el builder recibió la asignación');
    assert.equal(delDirector.length, 0, 'el director no se despierta por la señal del builder');
    // El builder reporta: ACK de la tarea → evento para el director; y escribe su respuesta en la cola del canal.
    p.tm.ack(p.root, { delivery_id: asg.assignment.delivery_id, owner_id: 'cursor-1' });
    fs.mkdirSync(path.join(p.root, L), { recursive: true });
    fs.writeFileSync(path.join(p.root, L, 'AUDITORIA-CURSOR.md'), '# canal\n');
    fab.emitir(L, 'rename', 'cola-builder.jsonl'); // (el archivo de respuesta no existe aún en disco: se ignora el hash nulo)
    fs.appendFileSync(path.join(p.root, L, 'cola-builder.jsonl'), JSON.stringify({ kind: 'ACK', event_id: 'ack-1' }) + '\n');
    fab.emitir(L, 'change', 'cola-builder.jsonl');
    for (const w of fab.watchers.filter((x) => !x.cerrado && x.dir.replace(/\\/g, '/').endsWith(T))) w.cb('change', 'rev-director.json');
    reloj.avanzar(500);
    assert.ok(delDirector.length >= 1, 'el director recibió el reporte del builder');
    assert.deepEqual(respuestas, ['cola-builder.jsonl', 'cola-builder.jsonl'], 'y detectó las respuestas en la cola del canal: la confirmación VISTO de la sesión y el ACK agregado después');
    assert.ok(pendientes(p, 'director') > 0, 'detectado y entregado NO es aceptado: sin confirmación de su sesión el ACK del director no avanza');
    assert.equal(vd.stats.aceptados, 0);
    vb.stop(); vd.stop();
  } finally { p.limpiar(); }
});

test('T10: ráfaga, duplicados y señales fuera de orden se coalescen: ningún evento se pierde ni se ejecuta dos veces', { skip }, () => {
  const p = proyectoTeams('t10');
  try {
    vaciarColas(p);
    const reloj = relojFalso(); const fab = fabricaFalsa();
    const ejecutados = new Set(); let ejecuciones = 0; let llamadas = 0;
    const v = new tw.Vigilancia(p.root, { rol: 'builder', watchFactory: fab, reloj, onTrabajo: (evs) => { llamadas++; for (const e of evs) if (!ejecutados.has(e.event_id)) { ejecutados.add(e.event_id); ejecuciones++; } return true; } });
    v.start();
    // Dos publicaciones rápidas + 30 señales duplicadas: UNA entrega con las dos, ninguna repetida.
    p.tm.asignar(p.root, { owner_id: 'b1' }); p.tm.asignar(p.root, { owner_id: 'b2' });
    for (let i = 0; i < 30; i++) fab.emitir(T, i % 2 ? 'rename' : 'change', 'rev-builder.json');
    reloj.avanzar(500);
    assert.equal(llamadas, 1, 'coalescido en un solo pase');
    assert.equal(ejecuciones >= 2, true);
    const antes = ejecuciones;
    // Señal "vieja" tardía (fuera de orden): el delta por seq no reentrega lo ya aceptado.
    fab.emitir(T, 'change', 'rev-builder.json'); reloj.avanzar(500);
    assert.equal(ejecuciones, antes);
    // Una corrección que llega ENTRE dos señales no se pierde: se entrega en el siguiente pase.
    p.tm.pausar(p.root);
    fab.emitir(T, 'change', 'rev-builder.json'); reloj.avanzar(500);
    assert.ok(ejecuciones > antes, 'el evento nuevo (pausa) se entregó');
    // Un ACK atrasado no retrocede el cursor del rol.
    const hasta = p.tm.delta(p.root, { rol: 'builder' }).last_ack_seq;
    p.tm.ackSeq(p.root, { rol: 'builder', seq: 1 });
    assert.equal(p.tm.delta(p.root, { rol: 'builder' }).last_ack_seq, hasta, 'el ACK solo avanza');
    v.stop();
  } finally { p.limpiar(); }
});

test('T10: una ráfaga continua no pospone el pase para siempre (el debounce tiene tope)', { skip }, () => {
  const p = proyectoTeams('t10b');
  try {
    vaciarColas(p);
    const reloj = relojFalso(); const fab = fabricaFalsa(); let pases = 0;
    const v = new tw.Vigilancia(p.root, { rol: 'builder', watchFactory: fab, reloj, onTrabajo: () => { pases++; return true; } });
    v.start();
    p.tm.asignar(p.root, { owner_id: 'b1' });
    // Una señal cada 400 ms durante 12 s: sin tope el debounce de 500 ms nunca dispararía.
    for (let t = 0; t < 12000; t += 400) { fab.emitir(T, 'change', 'rev-builder.json'); reloj.avanzar(400); }
    assert.ok(pases >= 1, 'el pase ocurrió dentro del tope de ' + tw.MAX_ESPERA_SENAL_MS + ' ms');
    v.stop();
  } finally { p.limpiar(); }
});

test('canal MD: reemplazo atómico, mismo contenido, temporales y archivos propios no provocan eco; un cambio real sí', { skip }, () => {
  const p = proyectoTeams('canal');
  try {
    vaciarColas(p);
    const reloj = relojFalso(); const fab = fabricaFalsa(); const cambios = [];
    fs.mkdirSync(path.join(p.root, L), { recursive: true });
    const canal = path.join(p.root, L, 'AUDITORIA-CURSOR.md');
    fs.writeFileSync(canal, '# canal v1\n');
    const v = new tw.Vigilancia(p.root, { rol: 'builder', watchFactory: fab, reloj, onTrabajo: () => true, onCanal: (i) => cambios.push(i.archivo) });
    v.start();
    const pasesIniciales = v.stats.pases;
    // Reemplazo atómico con el MISMO contenido (rename de un temporal): no es un cambio.
    fs.writeFileSync(canal + '.123.tmp', '# canal v1\n'); fs.renameSync(canal + '.123.tmp', canal);
    fab.emitir(L, 'rename', 'AUDITORIA-CURSOR.md.123.tmp'); fab.emitir(L, 'rename', 'AUDITORIA-CURSOR.md');
    reloj.avanzar(500);
    assert.deepEqual(cambios, [], 'mismo contenido: ni temporales ni reemplazo idéntico cuentan');
    // Logs, latidos y métricas propios viven en _teams y nunca despiertan al watch principal (sin bucle de eco).
    fs.writeFileSync(path.join(p.root, '.agentic', '_teams', 'heartbeat-builder.json'), '{}');
    fs.writeFileSync(path.join(p.root, '.agentic', '_teams', 'watch-builder.log'), 'x');
    fab.emitir(T, 'change', 'heartbeat-builder.json'); fab.emitir(T, 'change', 'watch-builder.log'); fab.emitir(T, 'change', 'metricas-builder.jsonl'); fab.emitir(T, 'change', 'rev-director.json');
    reloj.avanzar(1000);
    assert.equal(v.stats.pases, pasesIniciales, 'ningún pase por ruido propio');
    // Un cambio REAL del canal (reemplazo atómico con otro contenido) sí se detecta, una vez.
    fs.writeFileSync(canal + '.9.tmp', '# canal v2\n'); fs.renameSync(canal + '.9.tmp', canal);
    fab.emitir(L, 'rename', 'AUDITORIA-CURSOR.md');
    reloj.avanzar(500);
    assert.deepEqual(cambios, ['AUDITORIA-CURSOR.md']);
    assert.equal(v.stats.cambios_canal, 1);
    // Overflow (el sistema perdió eventos: nombre nulo) → se revisa por revisión/sequence, nada se pierde.
    p.tm.asignar(p.root, { owner_id: 'b1' });
    fab.emitir(L, 'rename', null);
    fab.emitir(T, 'change', null);
    reloj.avanzar(500);
    assert.ok(v.stats.aceptados >= 1, 'el delta se recuperó tras el overflow');
    // El canal es auxiliar: si su watcher cae, el principal y el respaldo siguen.
    fab.error(L);
    assert.equal(v.health().canal, 'NO_DISPONIBLE'); assert.equal(v.health().watcher, 'VIVO'); assert.equal(v.health().timer, 'VIVO');
    v.stop();
  } finally { p.limpiar(); }
});

test('el director detecta las respuestas del builder (cola) y el builder las del canal; cada rol ignora su propio ruido', { skip }, () => {
  const p = proyectoTeams('canal-roles');
  try {
    vaciarColas(p);
    assert.deepEqual(tw.ARCHIVOS_CANAL.builder, ['AUDITORIA-CURSOR.md']);
    assert.ok(tw.ARCHIVOS_CANAL.director.includes('cola-builder.jsonl'));
    assert.ok(!tw.ARCHIVOS_CANAL.builder.includes('cola-builder.jsonl'), 'el builder no se despierta con sus propias respuestas');
  } finally { p.limpiar(); }
});

// ─── Windows: tarea controlada ───────────────────────────────────────────────

/** Programador de tareas SIMULADO: guarda lo que "instalan" los scripts y responde a las consultas. */
function schedulerFalso(p) {
  const tareas = new Map(); const scripts = [];
  const ejecutor = (script) => {
    scripts.push(script);
    const n = (re) => { const m = re.exec(script); return m ? m[1] : null; };
    if (/Register-ScheduledTask/.test(script)) {
      const nombre = n(/Register-ScheduledTask -TaskName '((?:[^']|'')*)'/); const accion = /New-ScheduledTaskAction -Execute '((?:[^']|'')*)' -Argument '((?:[^']|'')*)' -WorkingDirectory '((?:[^']|'')*)'/.exec(script);
      tareas.set(nombre, { ejecutable: accion[1].replace(/''/g, "'"), argumentos: accion[2].replace(/''/g, "'"), directorio: accion[3].replace(/''/g, "'"), descripcion: n(/-Description '((?:[^']|'')*)'/), nivel: 'Limited', estado: 'Running' });
      return { status: 0, stdout: '', stderr: '' };
    }
    if (/Unregister-ScheduledTask/.test(script)) { tareas.delete(n(/Unregister-ScheduledTask -TaskName '((?:[^']|'')*)'/)); return { status: 0, stdout: '', stderr: '' }; }
    if (/Get-ScheduledTask /.test(script)) {
      const t = tareas.get(n(/Get-ScheduledTask -TaskName '((?:[^']|'')*)'/));
      return { status: 0, stderr: '', stdout: JSON.stringify(t ? { instalada: true, estado: t.estado, ejecutable: t.ejecutable, argumentos: t.argumentos, directorio: t.directorio, usuario: 'PC\\yo', nivel: t.nivel, logon: 'Interactive', descripcion: t.descripcion, ultima_ejecucion: '', ultimo_resultado: 0 } : { instalada: false }) };
    }
    return { status: 1, stdout: '', stderr: 'script no reconocido' };
  };
  return { tareas, scripts, ejecutor };
}

const LANZ = { elegido: 'powershell-oculto', disponibles: ['powershell-oculto', 'directo'], comprobado: true };

test('Windows: la tarea es por proyecto, rol y usuario; sin privilegios altos ni credenciales; valores escapados; arranque inmediato', () => {
  const raiz = path.join(os.tmpdir(), "mi proyecto d'artagnan 'x'");
  const t = vig.generarTarea(raiz, 'builder', { usuario: 'ana', lanzador: 'powershell-oculto', node: "C:\\Program Files\\nodejs\\node.exe" });
  const u = vig.generarTarea(raiz, 'builder', { usuario: 'beto', lanzador: 'powershell-oculto' });
  const d = vig.generarTarea(raiz, 'director', { usuario: 'ana', lanzador: 'powershell-oculto' });
  const o = vig.generarTarea(path.join(os.tmpdir(), 'otro'), 'builder', { usuario: 'ana', lanzador: 'powershell-oculto' });
  assert.match(t.nombre, /^AgentixTeams-[0-9a-f]{8}-builder-[0-9a-f]{4}$/);
  assert.equal(new Set([t.nombre, u.nombre, d.nombre, o.nombre]).size, 4, 'distinto usuario, rol o proyecto = distinta tarea');
  assert.doesNotMatch(t.instalar, /-Password|RunLevel Highest|NT AUTHORITY|-UserId\s+'?SYSTEM/i);
  assert.match(t.instalar, /-RunLevel Limited/); assert.match(t.instalar, /-LogonType Interactive/);
  assert.match(t.instalar, /-MultipleInstances IgnoreNew/); assert.match(t.instalar, /-Hidden/); assert.match(t.instalar, /-Force/, 'reinstalar reemplaza (idempotente)');
  assert.match(t.instalar, /Start-ScheduledTask/, 'arranque inmediato');
  assert.match(t.instalar, /-AtLogOn/); assert.match(t.instalar, /RepetitionInterval/, 'se reinicia si murió');
  // Las comillas simples de la ruta se duplican (escape de PowerShell); ningún valor queda sin comillar.
  assert.ok(t.instalar.includes("d''artagnan ''x''"), 'ruta con apóstrofes escapada');
  assert.ok(t.instalar.includes("-WorkingDirectory '" + path.resolve(raiz).replace(/'/g, "''") + "'"));
  assert.equal(vig.psq("a'b"), "'a''b'");
  assert.throws(() => vig.psq('a\nb'), /VALOR_NO_ESCAPABLE/);
  assert.throws(() => vig.generarTarea(raiz, 'otro'), /ROL_DESCONOCIDO/);
  // El comando lleva la marca que prueba que un pid es nuestro.
  const cmd = Buffer.from(/-EncodedCommand (\S+)/.exec(t.accion.argumentos)[1], 'base64').toString('utf16le');
  assert.ok(cmd.includes('--vigilante=' + vig.idVigilante(raiz, 'builder')) && cmd.includes('--rol=builder') && cmd.includes('--intervalo=180000'));
  assert.ok(cmd.includes(path.join(path.resolve(raiz), '.agentic', 'grafo', 'teams-watch.cjs').split("'").join("''")), 'ruta absoluta del motor del proyecto (con los apóstrofes escapados)');
  // conhost-headless y directo se generan solo si se piden (no se asumen).
  assert.equal(vig.generarTarea(raiz, 'builder', { usuario: 'ana', lanzador: 'conhost-headless' }).accion.ejecutable, 'conhost.exe');
  assert.match(vig.generarTarea(raiz, 'builder', { usuario: 'ana', lanzador: 'conhost-headless' }).accion.argumentos, /^--headless/);
  assert.match(vig.generarTarea(raiz, 'builder', { usuario: 'ana', lanzador: 'directo' }).oculto, /no: node\.exe/);
});

test('Windows: instalar exige aprobación; con ella registra solo lo propio, es idempotente y se verifica contra lo instalado de verdad', { skip }, () => {
  const p = proyectoTeams('win');
  try {
    const s = schedulerFalso(p);
    const o = { usuario: 'ana', lanzador: 'powershell-oculto', plataforma: 'win32', ejecutorPS: s.ejecutor };
    const sin = vig.instalarTarea(p.root, 'builder', o);
    assert.equal(sin.status, 'REQUIERE_APROBACION'); assert.ok(sin.script.includes('Register-ScheduledTask'));
    assert.equal(s.scripts.length, 0, 'sin aprobar no se ejecuta NADA');
    assert.equal(fs.existsSync(path.join(p.root, '.agentic', '_teams', 'vigilancia-recursos.json')), false);
    const r = vig.instalarTarea(p.root, 'builder', Object.assign({ aprobar: true }, o));
    assert.equal(r.status, 'INSTALADA', JSON.stringify(r));
    assert.equal(s.tareas.size, 1);
    const reg = vig.leerRegistro(p.root);
    assert.deepEqual(Object.keys(reg.tareas), [r.nombre], 'recurso propio registrado');
    // Idempotente: reinstalar deja UNA tarea.
    assert.equal(vig.instalarTarea(p.root, 'builder', Object.assign({ aprobar: true }, o)).status, 'INSTALADA');
    assert.equal(s.tareas.size, 1);
    // Diagnóstico de lo instalado: si alguien cambió el comando, se detecta y reparar lo vuelve a poner.
    const nombre = r.nombre;
    s.tareas.get(nombre).argumentos = '-NoProfile -Command evil'; s.tareas.get(nombre).nivel = 'Highest';
    const e = vig.estado(p.root, 'builder', o);
    assert.equal(e.tarea.coincide, false); assert.ok(e.tarea.drift.includes('ARGUMENTOS_DISTINTOS') && e.tarea.drift.includes('PRIVILEGIOS_ALTOS'));
    const rep = vig.repararTarea(p.root, 'builder', Object.assign({ aprobar: true }, o));
    assert.equal(rep.status, 'INSTALADA');
    assert.equal(vig.consultarTarea(p.root, 'builder', o).coincide, true);
    assert.equal(vig.repararTarea(p.root, 'builder', Object.assign({ aprobar: true }, o)).status, 'SIN_CAMBIOS');
    // Fuera de Windows no se instala nada y se dice.
    assert.equal(vig.instalarTarea(p.root, 'builder', { aprobar: true, plataforma: 'linux' }).status === 'PLATAFORMA_NO_SOPORTADA' || process.platform === 'win32', true);
  } finally { p.limpiar(); }
});

test('Windows: desinstalar y apagar tocan SOLO la tarea registrada como propia; una tarea ajena con ese nombre no se toca', { skip }, () => {
  const p = proyectoTeams('win2');
  try {
    const s = schedulerFalso(p);
    const o = { usuario: 'ana', lanzador: 'powershell-oculto', plataforma: 'win32', ejecutorPS: s.ejecutor };
    const nombre = vig.nombreTarea(p.root, 'builder', 'ana');
    // Una tarea ajena con el MISMO nombre que este módulo no registró: no se toca.
    s.tareas.set(nombre, { ejecutable: 'otra.exe', argumentos: 'x', directorio: 'C:\\', descripcion: 'de otra persona', nivel: 'Limited', estado: 'Ready' });
    const ajena = vig.desinstalarTarea(p.root, 'builder', Object.assign({ aprobar: true }, o));
    assert.equal(ajena.status, 'NO_REGISTRADA_COMO_PROPIA'); assert.equal(s.tareas.size, 1);
    s.tareas.delete(nombre);
    assert.equal(vig.instalarTarea(p.root, 'builder', Object.assign({ aprobar: true }, o)).status, 'INSTALADA');
    assert.equal(vig.desinstalarTarea(p.root, 'builder', o).status, 'REQUIERE_APROBACION', 'desinstalar también pide aprobación');
    const r = vig.desinstalarTarea(p.root, 'builder', Object.assign({ aprobar: true }, o));
    assert.equal(r.status, 'DESINSTALADA'); assert.equal(r.verificada, true); assert.equal(s.tareas.size, 0);
    assert.deepEqual(vig.leerRegistro(p.root).tareas, {});
    // T22 (tarea): apagar con tarea propia instalada la retira y VERIFICA; si no se puede retirar → STOP_FAILED.
    vig.instalarTarea(p.root, 'builder', Object.assign({ aprobar: true }, o));
    const ok = vig.apagarVigilantes(p.root, 'builder', o);
    assert.equal(ok.status, 'APAGADO', JSON.stringify(ok)); assert.equal(ok.hecho.tarea, 'DESINSTALADA'); assert.equal(s.tareas.size, 0);
    vig.instalarTarea(p.root, 'builder', Object.assign({ aprobar: true }, o));
    const terca = (script) => (/Unregister-ScheduledTask/.test(script) ? { status: 0, stdout: '', stderr: '' } : s.ejecutor(script)); // Unregister "funciona" pero no hace nada
    const mal = vig.apagarVigilantes(p.root, 'builder', Object.assign({}, o, { ejecutorPS: terca }));
    assert.equal(mal.status, 'STOP_FAILED'); assert.ok(mal.diagnostico.some((d) => /sigue/.test(d)));
    assert.equal(mal.loop_host.estado, 'REQUIERE_ACCION_DE_LA_SESION', 'el loop del host no lo apaga este proceso y se declara');
  } finally { p.limpiar(); }
});

test('lanzador: se COMPRUEBA en la máquina, no se asume conhost --headless', () => {
  const l = vig.detectarLanzadores({ plataforma: 'linux' });
  assert.deepEqual(l.disponibles, ['directo']); assert.equal(l.comprobado, false);
  const real = vig.detectarLanzadores({});
  assert.ok(real.disponibles.includes('directo'));
  assert.equal(real.elegido, real.disponibles[0]);
  if (process.platform === 'win32') assert.equal(real.comprobado, true);
});

// ─── apagado con procesos REALES ─────────────────────────────────────────────

const esperar = (cond, ms = 15000) => { const fin = Date.now() + ms; while (Date.now() < fin) { if (cond()) return true; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); } return cond(); };
const vivo = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

test('T22: apagar detiene el watch PROPIO real, retira su latido y verifica; el siguiente estado lo confirma', { skip, timeout: 120000 }, () => {
  const p = proyectoTeams('t22');
  let hijo = null;
  try {
    const id = vig.idVigilante(p.root, 'builder');
    hijo = spawn(process.execPath, [path.join(G, 'teams-watch.cjs'), '--rol=builder', '--vigilante=' + id, '--intervalo=30000'], { cwd: p.root, stdio: 'ignore', windowsHide: true });
    assert.ok(esperar(() => fs.existsSync(path.join(p.root, '.agentic', '_teams', 'heartbeat-builder.json'))), 'el watch escribió su latido');
    const e = vig.estado(p.root, 'builder', { consultarSistema: false });
    assert.equal(e.proceso.pid, hijo.pid); assert.equal(e.proceso.propio, true, 'su línea de comandos prueba que es nuestro'); assert.equal(e.veredicto, 'ACTIVA');
    assert.equal(vig.capacidades(p.root, 'builder').deteccion.estado, 'ACTIVA');
    const r = vig.apagarVigilantes(p.root, 'builder', { esperaMs: 15000 });
    assert.equal(r.status, 'APAGADO', JSON.stringify(r));
    assert.equal(r.hecho.proceso, 'DETENIDO'); assert.equal(r.hecho.latido, 'RETIRADO');
    assert.equal(r.verificacion.proceso_vivo, false);
    assert.ok(esperar(() => !vivo(hijo.pid)), 'el proceso ya no existe');
    assert.equal(fs.existsSync(path.join(p.root, '.agentic', '_teams', 'heartbeat-builder.json')), false);
    assert.notEqual(vig.estado(p.root, 'builder', { consultarSistema: false }).veredicto, 'ACTIVA');
    // Apagar otra vez es inocuo.
    assert.equal(vig.apagarVigilantes(p.root, 'builder').status, 'APAGADO');
  } finally { if (hijo && vivo(hijo.pid)) { try { process.kill(hijo.pid); } catch { /* ya terminó */ } } p.limpiar(); }
});

test('T22: un proceso AJENO con un latido que lo reclama NO se mata (STOP_FAILED con diagnóstico); se compara la línea de comandos, nunca el nombre', { skip, timeout: 120000 }, () => {
  const p = proyectoTeams('t22b');
  let senuelo = null;
  try {
    senuelo = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore', windowsHide: true });
    assert.ok(esperar(() => vivo(senuelo.pid)));
    fs.mkdirSync(path.join(p.root, '.agentic', '_teams'), { recursive: true });
    fs.writeFileSync(path.join(p.root, '.agentic', '_teams', 'heartbeat-builder.json'), JSON.stringify({ pid: senuelo.pid, rol: 'builder', at: new Date().toISOString(), intervalo_ms: 180000 }));
    const e = vig.procesoPropio(p.root, 'builder');
    assert.equal(e.vivo, true); assert.equal(e.propio, false, 'otro proceso node: la línea de comandos no es la del watch');
    const r = vig.apagarVigilantes(p.root, 'builder', { esperaMs: 1500 });
    assert.equal(r.status, 'STOP_FAILED'); assert.match(r.diagnostico.join(' '), /NO se detiene/);
    assert.ok(vivo(senuelo.pid), 'el señuelo sigue vivo: nada ajeno se mata');
    assert.equal(r.hecho.latido, 'CONSERVADO');
    // Un pid inexistente con latido viejo: se retira el latido residual y queda apagado.
    fs.writeFileSync(path.join(p.root, '.agentic', '_teams', 'heartbeat-builder.json'), JSON.stringify({ pid: 2147483000, rol: 'builder', at: '2020-01-01T00:00:00.000Z', intervalo_ms: 180000 }));
    const r2 = vig.apagarVigilantes(p.root, 'builder');
    assert.equal(r2.status, 'APAGADO'); assert.equal(r2.hecho.proceso, 'YA_NO_EXISTIA'); assert.equal(r2.hecho.latido, 'RETIRADO');
  } finally { if (senuelo && vivo(senuelo.pid)) { try { process.kill(senuelo.pid); } catch { /* ya terminó */ } } p.limpiar(); }
});

test('apagarTodos cubre los dos roles y se reporta por rol', { skip }, () => {
  const p = proyectoTeams('todos');
  try {
    const r = vig.apagarTodos(p.root);
    assert.equal(r.status, 'APAGADO'); assert.deepEqual(Object.keys(r.por_rol).sort(), ['builder', 'director']);
  } finally { p.limpiar(); }
});

// ─── capacidades honestas ────────────────────────────────────────────────────

test('capacidades: sin rastro es MANUAL_ONLY; con lecturas confirmadas es ACTIVO_OBSERVADO; el despertar por evento NUNCA se anuncia', { skip }, () => {
  const p = proyectoTeams('cap');
  try {
    const c0 = vig.capacidades(p.root, 'builder');
    assert.equal(c0.loop_host.estado, 'MANUAL_ONLY'); assert.equal(c0.despertar_modelo.estado, 'EVENT_WAKE_UNSUPPORTED'); assert.equal(c0.despertar_modelo.verificado, false);
    assert.match(c0.autonomia, /^MANUAL/); assert.equal(c0.capacidad_completa, false);
    assert.equal(c0.deteccion.estado, 'SIN_PROCESO');
    // Una lectura confirmada por la sesión (VISTO) reciente → loop observado; sigue sin haber despertar por evento.
    md.visto(p.root, { rol: 'builder', hasta_seq: 3 });
    const c1 = vig.capacidades(p.root, 'builder');
    assert.equal(c1.loop_host.estado, 'ACTIVO_OBSERVADO'); assert.equal(c1.despertar_modelo.estado, 'EVENT_WAKE_UNSUPPORTED');
    assert.match(c1.autonomia, /PARCIAL/); assert.match(c1.autonomia, /NO está soportado/);
    // Lecturas viejas: el loop pudo detenerse.
    const f = path.join(p.root, '.legion', 'cola-builder.jsonl');
    fs.writeFileSync(f, JSON.stringify({ kind: 'VISTO', hasta_seq: 3, at: '2020-01-01T00:00:00.000Z', event_id: 'visto-builder-3' }) + '\n');
    assert.equal(vig.capacidades(p.root, 'builder').loop_host.estado, 'DECLARADO_SIN_ACTIVIDAD');
    // Un adapter que declare EVENT sin verificación en host real NO cambia el veredicto.
    const fiel = vig.capacidades(p.root, 'builder', { adapter: { capabilities: () => ({ wake: 'EVENT' }) } });
    assert.equal(fiel.despertar_modelo.estado, 'EVENT_WAKE_UNSUPPORTED');
  } finally { p.limpiar(); }
});

test('smoke de despertar: distingue detección de lectura real y no promete un SLA', { skip }, () => {
  const p = proyectoTeams('smoke');
  try {
    const t0 = Date.parse('2026-10-03T12:06:20.000Z');
    fs.mkdirSync(path.join(p.root, '.agentic', '_teams'), { recursive: true });
    const linea = (o) => JSON.stringify(Object.assign({ rol: 'builder', origen: 'watcher', detectado_ms: t0 + 600, solicitado_ms: t0 + 601, atendido_ms: t0 + 9000, ack_ms: t0 + 9001, aceptado: true }, o)) + '\n';
    fs.writeFileSync(path.join(p.root, '.agentic', '_teams', 'metricas-builder.jsonl'), linea());
    // Solo detección: nadie confirmó lectura.
    assert.equal(vig.evaluarSmokeDespertar(p.root, 'builder', { editado_at: iso(t0) }).veredicto, 'SOLO_DETECCION');
    // Lectura confirmada por la sesión 8,4 s después de la edición: antes del tick y dentro del objetivo de laboratorio.
    fs.mkdirSync(path.join(p.root, '.legion'), { recursive: true });
    fs.writeFileSync(path.join(p.root, '.legion', 'cola-builder.jsonl'), JSON.stringify({ kind: 'VISTO', hasta_seq: 4, at: iso(t0 + 8400), event_id: 'visto-builder-4' }) + '\n');
    const ok = vig.evaluarSmokeDespertar(p.root, 'builder', { editado_at: iso(t0) });
    assert.equal(ok.veredicto, 'LECTURA_ANTES_DEL_TICK'); assert.equal(ok.detectado_ms, 600); assert.equal(ok.lectura_host_ms, 8400); assert.equal(ok.objetivo_lab_cumplido, true);
    assert.match(ok.nota, /SLA/);
    // Lectura recién en el tick siguiente: tardía.
    fs.writeFileSync(path.join(p.root, '.legion', 'cola-builder.jsonl'), JSON.stringify({ kind: 'VISTO', hasta_seq: 4, at: iso(t0 + 170000), event_id: 'visto-builder-5' }) + '\n');
    assert.equal(vig.evaluarSmokeDespertar(p.root, 'builder', { editado_at: iso(t0), intervalo_ms: 120000 }).veredicto, 'LECTURA_TARDIA');
    assert.equal(vig.evaluarSmokeDespertar(p.root, 'builder', { editado_at: 'no-es-fecha' }).status, 'PARAMETROS_INVALIDOS');
    // Sin detección registrada: no se afirma nada.
    fs.writeFileSync(path.join(p.root, '.agentic', '_teams', 'metricas-builder.jsonl'), '');
    assert.equal(vig.evaluarSmokeDespertar(p.root, 'builder', { editado_at: iso(t0) }).veredicto, 'NO_DETECTADO');
  } finally { p.limpiar(); }
});

test('T26: mismo nombre de proyecto en otra carpeta no mezcla eventos, vigilantes ni tareas', { skip }, () => {
  const a = proyectoTeams('mismo-nombre'); const b = proyectoTeams('mismo-nombre');
  try {
    vaciarColas(a); vaciarColas(b);
    assert.notEqual(a.root, b.root);
    assert.notEqual(vig.idVigilante(a.root, 'builder'), vig.idVigilante(b.root, 'builder'));
    assert.notEqual(vig.nombreTarea(a.root, 'builder', 'ana'), vig.nombreTarea(b.root, 'builder', 'ana'));
    // Un evento publicado en A no aparece en el delta de B (cada proyecto tiene su base) y su señal no despierta a B.
    a.tm.asignar(a.root, { owner_id: 'cursor-a' });
    assert.ok(pendientes(a, 'builder') > 0); assert.equal(pendientes(b, 'builder'), 0);
    const reloj = relojFalso(); const fab = fabricaFalsa(); let despertoB = 0;
    const vb = new tw.Vigilancia(b.root, { rol: 'builder', watchFactory: fab, reloj, onTrabajo: () => { despertoB++; return true; } });
    vb.start();
    assert.ok(fab.watchers.every((w) => w.dir.startsWith(b.root) || w.dir.replace(/\\/g, '/').startsWith(b.root.replace(/\\/g, '/'))), 'B solo observa SUS carpetas');
    fab.emitir(T, 'change', 'rev-builder.json'); reloj.avanzar(500);
    assert.equal(despertoB, 0, 'la actividad de A no despierta a B');
    // El latido/proceso de A no se confunde con el de B: el pid de A no es "propio" de B.
    fs.mkdirSync(path.join(b.root, '.agentic', '_teams'), { recursive: true });
    fs.writeFileSync(path.join(b.root, '.agentic', '_teams', 'heartbeat-builder.json'), JSON.stringify({ pid: process.pid, rol: 'builder', at: new Date().toISOString(), intervalo_ms: 180000 }));
    const e = vig.procesoPropio(b.root, 'builder', { lectorCmdline: () => 'node teams-watch.cjs --rol=builder --vigilante=' + vig.idVigilante(a.root, 'builder') });
    assert.equal(e.propio, false, 'la marca del vigilante de A no es la de B');
    vb.stop();
  } finally { a.limpiar(); b.limpiar(); }
});

test('el respaldo por defecto es de 180 s y el techo y el piso se respetan', () => {
  assert.deepEqual([tw.INTERVALO.min, tw.INTERVALO.defecto, tw.INTERVALO.max], [30000, 180000, 300000]);
  assert.equal(vig.INTERVALO_DEFECTO_MS, 180000);
});

test('fs.watch REAL del sistema: una publicación (reemplazo atómico de la señal) se detecta y entrega en segundos, sin esperar al respaldo', { skip, timeout: 60000 }, async () => {
  const p = proyectoTeams('fs-real');
  try {
    vaciarColas(p);
    const vistos = [];
    const v = new tw.Vigilancia(p.root, { rol: 'builder', intervaloMs: 300000, debounceMs: 300, onTrabajo: (evs) => { vistos.push(...evs.map((e) => e.seq)); return { aceptado: true }; } });
    v.start();
    assert.equal(v.health().watcher, 'VIVO');
    const t0 = Date.now();
    p.tm.asignar(p.root, { owner_id: 'cursor-real' });
    const limite = Date.now() + 8000;
    while (!vistos.length && Date.now() < limite) await new Promise((r) => setTimeout(r, 50));
    const lat = Date.now() - t0;
    v.stop();
    assert.ok(vistos.length >= 1, 'el watch del sistema detectó el cambio antes del respaldo (que es de 300 s)');
    assert.ok(lat < 8000, 'latencia real: ' + lat + ' ms');
    const m = v.metricas[v.metricas.length - 1];
    assert.equal(m.origen, 'watcher');
    assert.ok(m.lat_deteccion_ms != null && m.lat_deteccion_ms < 8000, 'detección medida desde la escritura de la señal: ' + m.lat_deteccion_ms + ' ms');
  } finally { p.limpiar(); }
});

// ─── espera por evento (la vía por la que un watch llega al modelo dentro de su propio turno) ───

const correrEsperar = (root, rol, max) => new Promise((resolve) => {
  const t0 = Date.now();
  const h = spawn(process.execPath, [path.join(G, 'teams-vigilancia.cjs'), 'esperar', '--rol=' + rol, '--max=' + max], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  h.stdout.on('data', (d) => { out += d; });
  h.on('close', (code) => { let json = null; try { json = JSON.parse(out); } catch { /* sin JSON */ } resolve({ code, json, ms: Date.now() - t0, out }); });
  correrEsperar.ultimo = h;
});

test('esperar: devuelve TRABAJO en cuanto el rol tiene eventos nuevos, sin hacer ACK (la sesión confirma después con visto)', { skip, timeout: 60000 }, async () => {
  const p = proyectoTeams('esperar');
  try {
    vaciarColas(p);
    const espera = correrEsperar(p.root, 'builder', 30);
    await new Promise((r) => setTimeout(r, 1500));
    const t0 = Date.now();
    p.tm.asignar(p.root, { owner_id: 'cursor-e' });
    const r = await espera;
    assert.equal(r.code, 0); assert.equal(r.json.estado, 'TRABAJO', r.out);
    assert.ok(['watch', 'sondeo', 'inicial'].includes(r.json.origen));
    assert.ok(r.json.eventos >= 1 && r.json.tipos.includes('TASK_ASSIGNED'));
    assert.ok(Date.now() - t0 < 6000, 'despertó con el evento, no por tiempo agotado: ' + (Date.now() - t0) + ' ms');
    assert.match(r.json.nota, /detectar no es leer/);
    assert.ok(pendientes(p, 'builder') > 0, 'esperar NO hace ACK: lo pendiente sigue pendiente hasta que la sesión confirme');
    // Con trabajo ya pendiente vuelve de inmediato.
    const ya = await correrEsperar(p.root, 'builder', 30);
    assert.equal(ya.json.estado, 'TRABAJO'); assert.equal(ya.json.origen, 'inicial'); assert.ok(ya.ms < 5000);
  } finally { p.limpiar(); }
});

test('esperar: sin trabajo no inventa nada: SIN_TRABAJO al agotar el tiempo', { skip, timeout: 60000 }, async () => {
  const p = proyectoTeams('esperar-vacio');
  try {
    vaciarColas(p);
    const r = await correrEsperar(p.root, 'director', 2);
    assert.equal(r.json.estado, 'SIN_TRABAJO'); assert.equal(r.json.origen, 'tiempo');
    assert.ok(r.json.esperado_ms >= 1900 && r.ms < 10000);
  } finally { p.limpiar(); }
});

// ─── PowerShell REAL (solo lectura: no instala ni cambia nada del sistema) ────

const esWin = process.platform === 'win32';

test('Windows REAL: los scripts generados son PowerShell VÁLIDO (se analizan, no se ejecutan) y la consulta real de una tarea inexistente responde «no instalada»', { skip: !esWin, timeout: 120000 }, () => {
  const raiz = path.join(os.tmpdir(), "proyecto d'prueba 'x' ñ");
  for (const lanzador of ['powershell-oculto', 'conhost-headless', 'directo']) {
    const t = vig.generarTarea(raiz, 'builder', { usuario: "ana d'a", lanzador });
    for (const [nombre, script] of [['instalar', t.instalar], ['estado', t.estado], ['desinstalar', t.desinstalar]]) {
      // El analizador de PowerShell valida la sintaxis SIN ejecutar nada.
      const analiza = "$e = $null; $null = [System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$null, [ref]$e); if ($e.Count) { $e | ForEach-Object { $_.Message }; exit 3 } else { 'SINTAXIS_OK' }";
      const b64 = Buffer.from(analiza, 'utf16le').toString('base64');
      const r = require('child_process').spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64], { input: script, encoding: 'utf8', windowsHide: true, timeout: 60000 });
      assert.equal(r.status, 0, lanzador + '/' + nombre + ' no es PowerShell válido: ' + r.stdout + r.stderr);
      assert.match(r.stdout, /SINTAXIS_OK/);
    }
  }
  // Consulta REAL de solo lectura: una tarea con nuestro prefijo que NO existe → instalada:false (el script de estado funciona de verdad).
  const p = proyectoTeams('ps-real', { plan: false });
  try {
    const e = vig.consultarTarea(p.root, 'builder', { usuario: 'usuario-que-no-existe-' + Date.now() });
    assert.equal(e.consultada, true, JSON.stringify(e)); assert.equal(e.instalada, false);
    assert.equal(vig.estado(p.root, 'builder', { usuario: 'x-' + Date.now(), lectorCmdline: () => null }).veredicto, 'NO_INSTALADA');
  } finally { p.limpiar(); }
});

test('Windows REAL: los cmdlets y parámetros del script de instalación existen en esta máquina y los objetos de la tarea se construyen (sin registrar ni arrancar NADA)', { skip: !esWin, timeout: 120000 }, () => {
  const raiz = path.join(os.tmpdir(), "proyecto d'prueba 'x' ñ");
  for (const lanzador of ['powershell-oculto', 'conhost-headless', 'directo']) {
    const t = vig.generarTarea(raiz, 'director', { usuario: 'ana', lanzador });
    // Todo menos los dos pasos con efecto (registrar y arrancar): se construyen en memoria la acción, los disparadores, el principal y los ajustes.
    const seguro = t.instalar.split('\n').filter((l) => !/^(Register-ScheduledTask|Start-ScheduledTask)/.test(l)).join('\n')
      + "\n$faltan = @(); foreach ($par in @(@('Register-ScheduledTask','TaskName','Action','Trigger','Settings','Principal','Description','Force'), @('New-ScheduledTaskPrincipal','UserId','LogonType','RunLevel'), @('New-ScheduledTaskSettingsSet','RestartCount','RestartInterval','ExecutionTimeLimit','StartWhenAvailable','MultipleInstances','Hidden'), @('New-ScheduledTaskTrigger','AtLogOn','Once','At','RepetitionInterval','RepetitionDuration','User'), @('Unregister-ScheduledTask','TaskName','Confirm'), @('Stop-ScheduledTask','TaskName'))) { $c = Get-Command $par[0]; foreach ($n in $par[1..($par.Count-1)]) { if (-not $c.Parameters.ContainsKey($n)) { $faltan += ($par[0] + ':' + $n) } } }\n"
      + "if ($faltan.Count) { 'FALTAN ' + ($faltan -join ','); exit 3 }\nif ($p.RunLevel -ne 'Limited') { 'NIVEL ' + $p.RunLevel; exit 4 }\n'OBJETOS_OK ' + $a.Execute";
    const b64 = Buffer.from(seguro, 'utf16le').toString('base64');
    const r = require('child_process').spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64], { encoding: 'utf8', windowsHide: true, timeout: 90000 });
    assert.equal(r.status, 0, lanzador + ': ' + r.stdout + r.stderr);
    assert.match(r.stdout, /OBJETOS_OK/);
  }
});

test('T19: con un update en curso la vigilancia no entrega ni hace ACK; al terminar recupera lo pendiente sin perder nada', { skip }, async () => {
  const p = proyectoTeams('t19');
  try {
    vaciarColas(p);
    const reloj = relojFalso(); const fab = fabricaFalsa(); const leidos = [];
    const v = new tw.Vigilancia(p.root, { rol: 'builder', intervaloMs: 180000, watchFactory: fab, reloj, onTrabajo: sesionQueLee(p, 'builder', leidos) });
    v.start();
    const guard = require(path.join(G, 'update-guard.cjs'));
    const h = guard.acquire(p.root, { opId: 'update-de-prueba' });
    try {
      p.tm.asignar(p.root, { owner_id: 'cursor-u' });
    } catch (e) { assert.equal(e.code, 'UPDATE_IN_PROGRESS', 'la publicación también respeta la exclusión del update'); }
    try {
      fab.emitir(T, 'change', 'rev-builder.json'); reloj.avanzar(500); reloj.avanzar(180000);
      assert.equal(leidos.length, 0, 'durante el update no se entrega nada');
      assert.equal(v.stats.aceptados, 0);
    } finally { guard.release(h); }
    // Terminado el update: el trabajo publicado después se recupera por revisión (no se perdió ninguna señal).
    p.tm.asignar(p.root, { owner_id: 'cursor-u' });
    reloj.avanzar(180000);
    assert.ok(leidos.length >= 1, 'recuperado en el siguiente tick');
    await v.enCurso;
    assert.equal(pendientes(p, 'builder'), 0);
    v.stop();
  } finally { p.limpiar(); }
});

test('un sondeo o heartbeat vacío NO es aprendizaje ni ciclo completado: la vigilancia ociosa no escribe nada en el núcleo', { skip }, () => {
  const p = proyectoTeams('ocioso');
  try {
    vaciarColas(p);
    const base = { eventos: sqlUno(p, "SELECT count(*) AS n FROM mem_events WHERE host = 'teams'"), ciclos: sqlUno(p, 'SELECT count(*) AS n FROM ciclos'), jobs: sqlUno(p, 'SELECT count(*) AS n FROM mem_jobs'), nodos: sqlUno(p, 'SELECT count(*) AS n FROM nodos'), obs: sqlUno(p, 'SELECT count(*) AS n FROM mem_observations') };
    const reloj = relojFalso(); const fab = fabricaFalsa(); let llamadas = 0;
    const v = new tw.Vigilancia(p.root, { rol: 'builder', intervaloMs: 180000, watchFactory: fab, reloj, onTrabajo: () => { llamadas++; return true; } });
    v.start();
    for (let i = 0; i < 20; i++) { reloj.avanzar(180000); fab.emitir(T, 'change', 'rev-builder.json'); reloj.avanzar(500); }
    v.stop();
    assert.equal(llamadas, 0); assert.ok(v.stats.pases_vacios >= 20);
    assert.deepEqual({ eventos: sqlUno(p, "SELECT count(*) AS n FROM mem_events WHERE host = 'teams'"), ciclos: sqlUno(p, 'SELECT count(*) AS n FROM ciclos'), jobs: sqlUno(p, 'SELECT count(*) AS n FROM mem_jobs'), nodos: sqlUno(p, 'SELECT count(*) AS n FROM nodos'), obs: sqlUno(p, 'SELECT count(*) AS n FROM mem_observations') }, base);
  } finally { p.limpiar(); }
});

function sqlUno(p, consulta) { const db = p.abrirR(); try { return Number(db.get(consulta).n); } finally { db.close(); } }

test('iniciar (arranque manual propio) es idempotente y apagar lo detiene y verifica: ciclo completo con procesos REALES', { skip, timeout: 120000 }, () => {
  const p = proyectoTeams('iniciar', { conGrafo: true });
  let pid = null;
  try {
    const a = vig.iniciarProceso(p.root, 'director', { esperaMs: 20000 });
    assert.equal(a.status, 'INICIADO', JSON.stringify(a)); pid = a.pid;
    assert.ok(vivo(pid));
    assert.equal(vig.iniciarProceso(p.root, 'director').status, 'YA_ACTIVO', 'no duplica el proceso');
    const e = vig.estado(p.root, 'director', { consultarSistema: false });
    assert.equal(e.veredicto, 'ACTIVA'); assert.equal(e.proceso.propio, true); assert.equal(e.proceso.pid, pid);
    assert.deepEqual(vig.leerRegistro(p.root).procesos.director.pid, pid);
    const cap = vig.capacidades(p.root, 'director');
    assert.equal(cap.deteccion.estado, 'ACTIVA'); assert.equal(cap.deteccion.watcher, 'VIVO'); assert.equal(cap.despertar_modelo.estado, 'EVENT_WAKE_UNSUPPORTED');
    const r = vig.apagarVigilantes(p.root, 'director', { esperaMs: 15000 });
    assert.equal(r.status, 'APAGADO', JSON.stringify(r)); assert.equal(r.hecho.proceso, 'DETENIDO');
    assert.ok(esperar(() => !vivo(pid)));
    assert.equal(vig.leerRegistro(p.root).procesos.director, undefined, 'el recurso propio ya no figura');
    // El otro rol no se tocó (no había nada de él).
    assert.equal(vig.apagarVigilantes(p.root, 'builder').hecho.proceso, 'NO_HABIA');
  } finally { if (pid && vivo(pid)) { try { process.kill(pid); } catch { /* ya terminó */ } } p.limpiar(); }
});

test('Windows REAL: el comando EXACTO de la tarea (conhost --headless, PowerShell oculto y directo) arranca de verdad el watch propio, que se identifica y se apaga verificado', { skip: !esWin || SIN_DRIVER, timeout: 240000 }, () => {
  for (const lanzador of ['conhost-headless', 'powershell-oculto', 'directo']) {
    const p = proyectoTeams('accion-' + lanzador, { conGrafo: true });
    let pid = null;
    try {
      const t = vig.generarTarea(p.root, 'builder', { lanzador, usuario: 'prueba' });
      // Tal como lo ejecutaría el Programador de tareas: ejecutable + argumentos tal cual, en el directorio del proyecto, con consola oculta (sin DETACHED: PowerShell necesita una consola, como la que le da el Programador).
      // (El Programador de tareas recibe Execute y Argument por separado y tolera espacios en la ruta; aquí se reproduce citando el ejecutable.)
      const exe = /s/.test(t.accion.ejecutable) ? '"' + t.accion.ejecutable + '"' : t.accion.ejecutable;
      const h = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', '"' + exe + ' ' + t.accion.argumentos + '"'], { cwd: t.accion.directorio, windowsVerbatimArguments: true, stdio: 'ignore', windowsHide: true });
      h.unref();
      assert.ok(esperar(() => fs.existsSync(path.join(p.root, '.agentic', '_teams', 'heartbeat-builder.json')), 30000), lanzador + ': el comando de la tarea no arrancó el watch');
      const pr = vig.procesoPropio(p.root, 'builder');
      pid = pr.pid;
      assert.equal(pr.vivo, true); assert.equal(pr.propio, true, lanzador + ': la línea de comandos del proceso debe llevar la marca de este proyecto y rol: ' + JSON.stringify(pr));
      assert.equal(vig.estado(p.root, 'builder', { consultarSistema: false }).veredicto, 'ACTIVA');
      const r = vig.apagarVigilantes(p.root, 'builder', { esperaMs: 20000 });
      assert.equal(r.status, 'APAGADO', lanzador + ': ' + JSON.stringify(r));
      assert.ok(esperar(() => !vivo(pid)), lanzador + ': el proceso sigue vivo');
    } finally { if (pid && vivo(pid)) { try { process.kill(pid); } catch { /* ya terminó */ } } p.limpiar(); }
  }
});
