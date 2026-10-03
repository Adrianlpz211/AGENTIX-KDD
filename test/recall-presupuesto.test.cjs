'use strict';

/* H32 — recall con presupuesto visible, sin relleno arbitrario, sin
   obsoletos, caché que se invalida con el grafo, detalle bajo demanda. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dba = require('../.agentic/grafo/db-adapter.cjs');
const mem = require('../.agentic/grafo/kdd-memory.cjs');

function proyecto({ fts = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-h32-'));
  fs.mkdirSync(path.join(root, '.agentic'));
  const db = dba.openWrite(path.join(root, '.agentic', 'memoria.db'));
  db.exec(`CREATE TABLE nodos (id INTEGER PRIMARY KEY, tipo TEXT, titulo TEXT, contenido TEXT, area TEXT,
    confianza TEXT, aplicado INTEGER DEFAULT 0, util INTEGER DEFAULT 0, estado TEXT, embedding TEXT,
    fecha_update TEXT, vigencia_tipo TEXT, archivos_aplica TEXT)`);
  if (fts) db.exec('CREATE VIRTUAL TABLE nodos_fts USING fts5(id UNINDEXED, titulo, contenido, area, tipo)');
  db.close();
  return root;
}

function insertar(root, filas) {
  const db = dba.openWrite(path.join(root, '.agentic', 'memoria.db'));
  const hayFts = !!db.get("SELECT 1 AS x FROM sqlite_master WHERE name='nodos_fts'");
  for (const f of filas) {
    db.run(`INSERT INTO nodos (tipo, titulo, contenido, area, confianza, aplicado, estado, fecha_update, vigencia_tipo, archivos_aplica)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, [f.tipo || 'error', f.titulo, f.contenido, f.area || 'auth', f.confianza || 'ALTA', f.aplicado || 0,
      f.estado || 'ACTIVO', new Date().toISOString(), f.vigencia || 'VIGENTE', f.archivos ? JSON.stringify(f.archivos) : null]);
    const id = db.get('SELECT last_insert_rowid() AS id').id;
    if (hayFts) db.run('INSERT INTO nodos_fts (id, titulo, contenido, area, tipo) VALUES (?,?,?,?,?)', [id, f.titulo, f.contenido, f.area || 'auth', f.tipo || 'error']);
  }
  db.close();
}

test('H32: query irrelevante devuelve vacío, no las entradas más usadas', async () => {
  for (const fts of [true, false]) {
    const root = proyecto({ fts });
    insertar(root, [
      { titulo: 'Refresh token JWT expira', contenido: 'Causa: reloj del servidor. Solución: tolerancia de 30s.', aplicado: 99 },
      { titulo: 'Pool de conexiones agotado', contenido: 'Solución: cerrar conexiones en finally.', aplicado: 50 },
    ]);
    const r = await mem.recall('cebra unicornio acuarela', {}, root);
    assert.deepStrictEqual(r.results, [], `fts=${fts}`);
    assert.strictEqual(r.source, 'sin_coincidencia');

    const ok = await mem.recall('el refresh del token jwt falla al expirar', {}, root);
    assert.strictEqual(ok.results.length, 1, `fts=${fts}: tarea larga encuentra por términos`);
    assert.strictEqual(ok.results[0].titulo, 'Refresh token JWT expira');
  }
});

test('H32: entrada enorme respeta el presupuesto y el truncamiento se ve', async () => {
  const root = proyecto();
  const enorme = 'pago stripe webhook '.repeat(20000);
  insertar(root, Array.from({ length: 8 }, (_, i) => ({ titulo: `Webhook de pago ${i}`, contenido: enorme, archivos: [`src/pagos/w${i}.ts`] })));
  const r = await mem.recall('webhook pago stripe', { topK: 8, presupuestoTokens: 300 }, root);
  assert.ok(r.presupuesto.usados <= 300);
  assert.strictEqual(r.presupuesto.estimacion, 'bytes/4');
  assert.strictEqual(r.presupuesto.truncado, true);
  assert.strictEqual(r.results.length + r.presupuesto.omitidos, 8);
  const primero = r.results[0];
  assert.deepStrictEqual(Object.keys(primero).slice(0, 7), ['id', 'titulo', 'tipo', 'area', 'confianza', 'vigencia', 'archivos']);
  assert.ok(primero.resumen.length <= 200);
  assert.strictEqual(primero.contenido, undefined, 'el detalle es bajo demanda');
  assert.ok(JSON.stringify(r).length < 4000, 'la respuesta entera es chica');

  const d = mem.detalle(primero.id, root);
  assert.strictEqual(d.ok, true);
  assert.strictEqual(d.contenido.length, enorme.length);
  assert.deepStrictEqual(d.archivos, [primero.archivos[0]]);
});

test('H32: obsoleto no se aplica; sospechoso llega marcado', async () => {
  const root = proyecto();
  insertar(root, [
    { titulo: 'Bcrypt con 10 rondas', contenido: 'password hash bcrypt', vigencia: 'OBSOLETO' },
    { titulo: 'Bcrypt con 12 rondas', contenido: 'password hash bcrypt', vigencia: 'HISTORICO' },
    { titulo: 'Bcrypt viejo', contenido: 'password hash bcrypt', estado: 'OBSOLETO' },
    { titulo: 'Argon2 para password', contenido: 'password hash argon2', vigencia: 'SOSPECHOSO' },
  ]);
  const r = await mem.recall('password hash bcrypt argon2', {}, root);
  assert.deepStrictEqual(r.results.map((x) => x.titulo), ['Argon2 para password']);
  assert.strictEqual(r.results[0].verificar, true);
  assert.strictEqual(r.excluidos.obsoletos, 3);
  const db = dba.openReadOnly(path.join(root, '.agentic', 'memoria.db'));
  const idObsoleto = db.get("SELECT id FROM nodos WHERE titulo='Bcrypt con 10 rondas'").id;
  db.close();
  assert.strictEqual(mem.detalle(idObsoleto, root).reason, 'NO_VIGENTE');
});

test('H32: caché por query que se invalida cuando cambia el grafo; dedup entre roles', async () => {
  const root = proyecto();
  insertar(root, [{ titulo: 'Rate limit en login', contenido: 'login rate limit 5 por minuto' }]);
  const a = await mem.recall('login rate limit', {}, root);
  const b = await mem.recall('login rate limit', {}, root);
  assert.strictEqual(a.cache, 'miss');
  assert.strictEqual(b.cache, 'hit');
  assert.deepStrictEqual(b.results, a.results);

  await new Promise((r) => setTimeout(r, 20));
  insertar(root, [{ titulo: 'Login bloquea tras rate limit', contenido: 'login rate limit bloqueo' }]);
  const c = await mem.recall('login rate limit', {}, root);
  assert.strictEqual(c.cache, 'miss', 'el grafo cambió');
  assert.strictEqual(c.results.length, 2);

  const otroRol = await mem.recall('login rate limit', { excluir: c.results.slice(0, 1).map((x) => x.id) }, root);
  assert.strictEqual(otroRol.results.length, 1);
  assert.strictEqual(otroRol.excluidos.ya_entregados, 1);
});
