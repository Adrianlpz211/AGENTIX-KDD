'use strict';
/* H02 "Reutilización" — prueba 5 (relectura intacta reutiliza; cambio de hash invalida) y la caché de contexto
   por revisión de memoria, de código y versión de política.
   Fixture determinista con archivos y base reales; no hay host real: "receptor" es una cadena que identifica
   a quien recibe (tarea:rol:sesión). */
const test = require('node:test');
const { SIN_DRIVER } = require('./helpers/db-real.cjs');
if (SIN_DRIVER) { test(require('node:path').basename(__filename) + ' (omitido: ' + SIN_DRIVER + ')', { skip: SIN_DRIVER }, () => {}); return; }
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { proyecto, REPO } = require('./helpers/memoria-proyecto.cjs');
const G = path.join(REPO, '.agentic', 'grafo');
const reuse = require(path.join(G, 'context-reuse.cjs'));
const router = require(path.join(G, 'effort-router.cjs'));
const budget = require(path.join(G, 'effort-budget.cjs'));

const R = 'T-1:builder:ses-1';
function nuevo(nombre) {
  const p = proyecto(nombre);
  fs.writeFileSync(path.join(p.root, 'package.json'), JSON.stringify({ name: 'fx', version: '1.0.0' }));
  fs.mkdirSync(path.join(p.root, 'src'), { recursive: true });
  const lineas = Array.from({ length: 60 }, (_, i) => `const linea${i} = 'valor-unico-${i}';`);
  fs.writeFileSync(path.join(p.root, 'src', 'modulo.js'), lineas.join('\n') + '\n');
  return p;
}
const escribir = (p, rel, txt) => fs.writeFileSync(path.join(p.root, rel), txt);
const leerTxt = (p, rel) => fs.readFileSync(path.join(p.root, rel), 'utf8');

test('[prueba 5] relectura de archivo intacto → REFERENCIA (no se vuelve a entregar); cambio de hash → invalida', () => {
  const p = nuevo('reuse');
  try {
    const a = reuse.leer(p.root, 'src/modulo.js', { recipient: R });
    assert.equal(a.status, 'NUEVO');
    assert.ok(a.content.includes('valor-unico-30'));
    const b = reuse.leer(p.root, 'src/modulo.js', { recipient: R });
    assert.equal(b.status, 'REFERENCIA', 'el receptor ya lo tiene y no cambió');
    assert.equal(b.content, null);
    assert.equal(b.ref.hash, a.hash);
    assert.ok(b.saved_bytes > 1000, 'ahorro real descontando el marcador');
    // Un receptor distinto NO hereda lo entregado a otro.
    assert.equal(reuse.leer(p.root, 'src/modulo.js', { recipient: 'T-1:director:ses-9' }).status, 'NUEVO');
    // Si el receptor perdió su contexto (reinicio/compactación), vuelve a recibirlo.
    reuse.olvidarReceptor(p.root, R);
    assert.equal(reuse.leer(p.root, 'src/modulo.js', { recipient: R }).status, 'NUEVO');
    // Una lectura NECESARIA (reparar un bug) jamás se sustituye por una referencia.
    const f = reuse.leer(p.root, 'src/modulo.js', { recipient: R, necesario: true });
    assert.equal(f.status, 'FORZADO');
    assert.ok(f.content.length > 1000);

    // Cambia UNA línea: el hash cambió → jamás referencia; llega un delta corto y verificable.
    const antes = leerTxt(p, 'src/modulo.js');
    escribir(p, 'src/modulo.js', antes.replace("'valor-unico-30'", "'MODIFICADO'"));
    const c = reuse.leer(p.root, 'src/modulo.js', { recipient: R });
    assert.equal(c.status, 'CAMBIADO');
    assert.equal(c.previous_hash, a.hash);
    assert.notEqual(c.hash, a.hash);
    assert.ok(c.delta && c.content === null, 'se envía un delta, no el archivo entero');
    assert.ok(c.delta_bytes < c.bytes * 0.6);
    const aplicado = reuse.aplicarDelta(antes, c.delta);
    assert.equal(aplicado.ok, true);
    assert.equal(aplicado.texto, leerTxt(p, 'src/modulo.js'), 'el receptor reconstruye exactamente la versión nueva');
    // Si el receptor tiene OTRA base, el delta no se aplica: pide la versión completa.
    assert.equal(reuse.aplicarDelta(antes + 'x', c.delta).code, 'DELTA_BASE_DISTINTA');
    // Y ahora que recibió la nueva versión, releer es referencia otra vez.
    assert.equal(reuse.leer(p.root, 'src/modulo.js', { recipient: R }).status, 'REFERENCIA');

    // Mismo nombre, mismo TAMAÑO, otro contenido: la igualdad de nombre no oculta el cambio.
    const igualTam = leerTxt(p, 'src/modulo.js').replace("'valor-unico-5'", "'valor-unico-7'");
    assert.equal(Buffer.byteLength(igualTam), Buffer.byteLength(leerTxt(p, 'src/modulo.js')));
    escribir(p, 'src/modulo.js', igualTam);
    assert.equal(reuse.leer(p.root, 'src/modulo.js', { recipient: R }).status, 'CAMBIADO');

    // Un cambio grande: si el delta no compensa, se entrega la versión nueva COMPLETA.
    escribir(p, 'src/modulo.js', Array.from({ length: 60 }, (_, i) => `// otro archivo ${i}`).join('\n') + '\n');
    const g = reuse.leer(p.root, 'src/modulo.js', { recipient: R });
    assert.equal(g.status, 'CAMBIADO');
    assert.equal(g.delta, undefined);
    assert.ok(g.content.includes('otro archivo 59'));
    const st = reuse.estadisticas(p.root);
    assert.ok(st.reference_hits >= 2 && st.invalidations >= 3 && st.forced_reads === 1);
  } finally { p.limpiar(); }
});

test('selector por líneas: un cambio FUERA del intervalo no invalida; dentro, sí', () => {
  const p = nuevo('selector');
  try {
    const sel = { line_from: 1, line_to: 10 };
    assert.equal(reuse.leer(p.root, 'src/modulo.js', { recipient: R, selector: sel }).status, 'NUEVO');
    escribir(p, 'src/modulo.js', leerTxt(p, 'src/modulo.js').replace("'valor-unico-50'", "'toco-otra-zona'"));
    assert.equal(reuse.leer(p.root, 'src/modulo.js', { recipient: R, selector: sel }).status, 'REFERENCIA', 'el intervalo pedido no cambió');
    escribir(p, 'src/modulo.js', leerTxt(p, 'src/modulo.js').replace("'valor-unico-3'", "'toco-esta-zona'"));
    const d = reuse.leer(p.root, 'src/modulo.js', { recipient: R, selector: sel });
    assert.equal(d.status, 'CAMBIADO');
    // El archivo completo es OTRA clave: no comparte lo entregado del intervalo.
    assert.equal(reuse.leer(p.root, 'src/modulo.js', { recipient: R }).status, 'NUEVO');
    // Selector por bytes: referencia/ cambio por el hash de ese tramo.
    assert.equal(reuse.leer(p.root, 'src/modulo.js', { recipient: R, selector: { offset: 0, length: 100 } }).status, 'NUEVO');
    assert.equal(reuse.leer(p.root, 'src/modulo.js', { recipient: R, selector: { offset: 0, length: 100 } }).status, 'REFERENCIA');
  } finally { p.limpiar(); }
});

test('seguridad: no entrega ni cachea rutas privadas, binarios, enlaces fuera del proyecto ni rutas ../; no guarda contenido en la caché', () => {
  const p = nuevo('seg');
  try {
    escribir(p, '.env', 'API_KEY=sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd\n');
    assert.equal(reuse.leer(p.root, '.env', { recipient: R }).code, 'PRIVATE_NOT_DELIVERED');
    assert.equal(reuse.leer(p.root, '../fuera.txt', { recipient: R }).code, 'DENIED');
    assert.equal(reuse.leer(p.root, 'src/no-existe.js', { recipient: R }).code, 'NOT_FOUND');
    assert.equal(reuse.leer(p.root, 'src', { recipient: R }).code, 'DENIED', 'un directorio no es un archivo');
    fs.writeFileSync(path.join(p.root, 'src', 'datos.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
    assert.equal(reuse.leer(p.root, 'src/datos.bin', { recipient: R }).code, 'BINARY_NOT_DELIVERED');
    assert.equal(reuse.leer(p.root, 'src/modulo.js', {}).code, 'RECIPIENT_REQUERIDO', 'sin receptor no se sabe qué tiene ya');
    // Un enlace que apunta fuera del proyecto (si el sistema deja crearlo sin privilegios).
    const fuera = path.join(path.dirname(p.root), 'akdd-fuera-' + process.pid + '.txt');
    fs.writeFileSync(fuera, 'secreto de otro proyecto');
    try {
      fs.symlinkSync(fuera, path.join(p.root, 'src', 'enlace.txt'));
      assert.equal(reuse.leer(p.root, 'src/enlace.txt', { recipient: R }).code, 'DENIED');
    } catch (e) { if (!/EPERM|EACCES|ENOTSUP/.test(String(e.code))) throw e; /* sin permiso de enlaces: se omite solo esta comprobación */ }
    finally { try { fs.rmSync(fuera); } catch { /* ya no está */ } }
    // La ruta absoluta DENTRO del proyecto sí vale; la caché no guarda contenido de archivos.
    assert.equal(reuse.leer(p.root, path.join(p.root, 'src', 'modulo.js'), { recipient: R }).status, 'NUEVO');
    const guardado = fs.readFileSync(path.join(p.root, '.agentic', '_context', 'reuse', 'estado.json'), 'utf8');
    assert.ok(!guardado.includes('valor-unico-30'), 'solo hashes: ningún contenido de archivos en la caché');
    assert.ok(!guardado.includes('sk-ant-api03'));
  } finally { p.limpiar(); }
});

test('una caché corrupta o ausente solo cuesta volver a entregar: jamás omite', () => {
  const p = nuevo('corrupta');
  try {
    assert.equal(reuse.leer(p.root, 'src/modulo.js', { recipient: R }).status, 'NUEVO');
    fs.writeFileSync(path.join(p.root, '.agentic', '_context', 'reuse', 'estado.json'), '{no es json');
    assert.equal(reuse.leer(p.root, 'src/modulo.js', { recipient: R }).status, 'NUEVO', 'sin caché fiable se entrega');
    fs.rmSync(path.join(p.root, '.agentic', '_context', 'reuse'), { recursive: true });
    assert.equal(reuse.leer(p.root, 'src/modulo.js', { recipient: R }).status, 'NUEVO');
    assert.equal(reuse.leer(p.root, 'src/modulo.js', { recipient: R }).status, 'REFERENCIA');
  } finally { p.limpiar(); }
});

test('las relecturas evitadas, los cambios y los bytes ahorrados se anotan en el presupuesto acumulado de la tarea', () => {
  const p = nuevo('presup');
  try {
    router.decidirYGuardar(p.root, { task_id: 'rr-1', intent: 'cambia el texto del título', paths: ['src/modulo.js'], index_coverage: 'COMPLETE' });
    const o = { recipient: R, task_id: 'rr-1', role: 'builder' };
    const a = reuse.leer(p.root, 'src/modulo.js', o);
    reuse.leer(p.root, 'src/modulo.js', o);
    reuse.leer(p.root, 'src/modulo.js', o);
    let e = budget.estado(p.root, 'rr-1');
    assert.equal(e.uso.file_reads, 1, 'solo la primera lectura es una lectura');
    assert.equal(e.uso.rereads_avoided, 2);
    assert.ok(e.uso.context_bytes < a.bytes + 1000, 'dos referencias pesan marcadores, no el archivo');
    assert.equal(e.medicion.by_kind.cache_hit.calls, 2);
    escribir(p, 'src/modulo.js', leerTxt(p, 'src/modulo.js').replace("'valor-unico-1'", "'x'"));
    reuse.leer(p.root, 'src/modulo.js', o);
    e = budget.estado(p.root, 'rr-1');
    assert.equal(e.uso.cache_invalidations, 1);
    assert.equal(e.uso.file_reads, 2);
  } finally { p.limpiar(); }
});

test('contexto por revisión: referencia al mismo receptor, reutilizado para otro, invalidado por código / política / memoria', async () => {
  const p = nuevo('ctx');
  try {
    let builds = 0;
    const spec = (o = {}) => ({ task_id: 'T-9', role: 'builder', recipient: R, paths: ['src/modulo.js'], policy_version: 1, build: async () => { builds++; return { objetivo: 'x', n: builds }; }, ...o });
    const a = await reuse.contexto(p.root, spec());
    assert.equal(a.status, 'NUEVO');
    assert.equal(builds, 1);
    const b = await reuse.contexto(p.root, spec());
    assert.equal(b.status, 'REFERENCIA', 'el receptor ya lo tiene');
    assert.equal(b.context_ref.body_hash, a.body_hash);
    assert.equal(builds, 1, 'no se reconstruyó');
    const c = await reuse.contexto(p.root, spec({ recipient: 'T-9:director:ses-2' }));
    assert.equal(c.status, 'REUTILIZADO', 'otro receptor recibe el contexto ya armado');
    assert.deepEqual(c.context, a.context);
    assert.equal(builds, 1);

    // El registro de consumo escribe en la base: eso NO debe invalidar el contexto (no cambió el conocimiento).
    router.decidirYGuardar(p.root, { task_id: 'T-9', intent: 'cambia el texto del título', paths: ['src/modulo.js'], index_coverage: 'COMPLETE' });
    budget.registrar(p.root, 'T-9', { kind: 'tool_call', role: 'builder' });
    assert.equal((await reuse.contexto(p.root, spec())).status, 'REFERENCIA', 'escribir uso no es cambiar memoria');

    // Cambió el CÓDIGO que cita → invalida y reconstruye.
    escribir(p, 'src/modulo.js', leerTxt(p, 'src/modulo.js') + '// nuevo\n');
    const d = await reuse.contexto(p.root, spec());
    assert.equal(d.status, 'NUEVO');
    assert.deepEqual(d.invalidado.map((i) => i.motivos), [['code_revision']]);
    assert.equal(builds, 2);
    // Cambió la VERSIÓN DE POLÍTICA.
    const e = await reuse.contexto(p.root, spec({ policy_version: 2 }));
    assert.deepEqual(e.invalidado.map((i) => i.motivos), [['policy_version']]);
    // Cambió la MEMORIA de conocimiento (un nodo nuevo).
    const w = p.abrirW();
    try { w.run('INSERT INTO nodos (tipo, titulo, contenido, area, confianza, estado, vigencia_tipo) VALUES (?,?,?,?,?,?,?)', ['decision', 'NUEVA', 'una decisión nueva', 'auth', 'ALTA', 'ACTIVO', 'VIGENTE']); } finally { w.close(); }
    const f = await reuse.contexto(p.root, spec({ policy_version: 2 }));
    assert.deepEqual(f.invalidado.map((i) => i.motivos), [['memory_revision']]);
    // Un fallo al construir no deja nada cacheado ni lanza.
    const roto = await reuse.contexto(p.root, spec({ task_id: 'T-10', build: async () => { throw new Error('boom'); } }));
    assert.equal(roto.ok, false);
    assert.equal(roto.code, 'REUSE_FAILED');
    assert.equal(reuse.estadisticas(p.root).contextos, 1, 'solo el contexto vigente de T-9');
    // Spec incompleta: rechazo claro.
    assert.equal((await reuse.contexto(p.root, { task_id: 'x' })).code, 'SPEC_INVALIDA');
  } finally { p.limpiar(); }
});

test('invalidarPorCambio: un evento externo descarta contextos y lo "ya entregado" de esos archivos', async () => {
  const p = nuevo('inval');
  try {
    await reuse.contexto(p.root, { task_id: 'T-3', role: 'builder', recipient: R, paths: ['src/modulo.js'], policy_version: 1, build: () => ({ a: 1 }) });
    reuse.leer(p.root, 'src/modulo.js', { recipient: R });
    assert.equal(reuse.leer(p.root, 'src/modulo.js', { recipient: R }).status, 'REFERENCIA');
    const r = reuse.invalidarPorCambio(p.root, { paths: ['src/modulo.js'], reason: 'RESTORE' });
    assert.equal(r.contextos_invalidados, 1);
    assert.equal(r.lecturas_invalidadas, 1);
    assert.equal(reuse.leer(p.root, 'src/modulo.js', { recipient: R }).status, 'NUEVO', 'tras el evento no se da nada por entregado');
    assert.equal(reuse.limpiar(p.root).ok, true);
  } finally { p.limpiar(); }
});

test('una lectura para reparar un bug (reparacion:true) tampoco se sustituye por una referencia', () => {
  const p = nuevo('reparar');
  try {
    reuse.leer(p.root, 'src/modulo.js', { recipient: R });
    const r = reuse.leer(p.root, 'src/modulo.js', { recipient: R, reparacion: true });
    assert.equal(r.status, 'FORZADO');
    assert.ok(r.content.includes('valor-unico-59'));
  } finally { p.limpiar(); }
});
