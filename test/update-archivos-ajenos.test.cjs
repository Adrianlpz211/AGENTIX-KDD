'use strict';
/* Un update correcto no se revierte por cambios que HIZO OTRO PROGRAMA mientras corría (3.20.2).
 *
 * Caso real (komerza, 04/10/2026): una base antigua tenía un `memoria.db-journal` (el archivo transitorio que SQLite crea y borra solo)
 * al inventariar; desapareció durante el update y la verificación lo tomó por «archivo propio perdido» → ROLLED_BACK de una
 * actualización buena. Dos defensas: (1) los acompañantes transitorios de SQLite no son archivos del proyecto; (2) un archivo propio
 * que cambia o desaparece SIN que el update lo haya tocado (el journal anota todo lo que escribe) es un aviso, no un fallo.
 * Si el update SÍ lo tocó, sigue siendo fallo y se revierte. */
const test = require('node:test');
const { SIN_DRIVER } = require('./helpers/db-real.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { update } = require('../src/update.js');
const legacy = require('./helpers/legacy-real.cjs');
const real = require('./helpers/db-real.cjs');
const inventory = require(path.join(real.REPO, '.agentic', 'grafo', 'memory-inventory.cjs'));

const escribir = (root, rel, texto) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, texto); return f; };
const opcionesBase = (root, extra) => Object.assign({ projectPath: root, salir: false, silent: true, __sinFuncional: true }, extra);

test('inventario: los acompañantes transitorios de SQLite y los temporales no son archivos del proyecto', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-inv-'));
  for (const n of ['memoria.db-journal', 'memoria.db-wal', 'memoria.db-shm', 'otra.db-journal', 'x.sqlite-wal', 'nota.tmp', '.nota.swp', 'doc.md~']) escribir(root, '.agentic/' + n, 'x');
  escribir(root, '.agentic/mi-regla.md', 'cosa del usuario');
  escribir(root, '.agentic/memoria - copia.db', 'copia hecha por el usuario');
  const inv = inventory.inventoryFiles(root, {});
  assert.deepEqual(Object.keys(inv).sort(), ['.agentic/memoria - copia.db', '.agentic/mi-regla.md'], 'solo lo que de verdad es del usuario');
});

test('update real: un memoria.db-journal que existe al empezar y SQLite borra solo NO tumba la actualización', { skip: SIN_DRIVER, timeout: 300000 }, async () => {
  const p = legacy.proyectoReal('3.20.0', 'journal');
  escribir(p.root, '.agentic/memoria.db-journal', '');
  const r = await update(opcionesBase(p.root, { __hooks: { tras_archivos: () => { try { fs.unlinkSync(path.join(p.root, '.agentic', 'memoria.db-journal')); } catch { /* ya no está */ } } } }));
  assert.ok(r.ok, 'no debía revertirse: ' + r.status + ' ' + JSON.stringify(r.errors));
  assert.ok(!['ROLLED_BACK', 'RECOVERY_REQUIRED', 'BLOCKED'].includes(r.status), r.status);
});

test('update real: un archivo propio que OTRO programa cambia o borra mientras corre es un aviso; el update correcto no se revierte', { skip: SIN_DRIVER, timeout: 300000 }, async () => {
  const p = legacy.proyectoReal('3.20.0', 'ajeno');
  escribir(p.root, '.claude/settings.local.json', '{"permissions":{"allow":[]}}');
  escribir(p.root, '.cursor/mi-regla.mdc', 'regla propia');
  const r = await update(opcionesBase(p.root, { __hooks: { tras_archivos: () => {
    fs.writeFileSync(path.join(p.root, '.claude', 'settings.local.json'), '{"permissions":{"allow":["Bash(ls)"]}}'); // Claude Code guarda un permiso
    fs.unlinkSync(path.join(p.root, '.cursor', 'mi-regla.mdc'));                                                  // el usuario borra un archivo
  } } }));
  assert.ok(r.ok, 'no debía revertirse: ' + r.status + ' ' + JSON.stringify(r.errors));
  const avisos = (r.warnings || []).join(' | ');
  assert.match(avisos, /settings\.local\.json/); assert.match(avisos, /mi-regla\.mdc/);
  assert.match(avisos, /no lo tocó/);
  assert.equal(fs.readFileSync(path.join(p.root, '.claude', 'settings.local.json'), 'utf8'), '{"permissions":{"allow":["Bash(ls)"]}}', 'se conserva como lo dejó el otro programa');
  assert.ok(!fs.existsSync(path.join(p.root, '.cursor', 'mi-regla.mdc')), 'y lo que el usuario borró no reaparece');
});

test('update real: si el update SÍ tocó un archivo propio (consta en su journal) y cambia, sigue siendo fallo y se revierte', { skip: SIN_DRIVER, timeout: 300000 }, async () => {
  const p = legacy.proyectoReal('3.20.0', 'tocado');
  escribir(p.root, '.claude/algo-del-usuario.json', '{"a":1}');
  const r = await update(opcionesBase(p.root, { __hooks: { tras_archivos: (ctx) => {
    // Simula un fallo del propio actualizador: anota en su journal que escribió este archivo y lo deja distinto.
    ctx.journal.datos.entradas.push({ rel: '.claude/algo-del-usuario.json', existia: true, accion: 'escribir' });
    fs.writeFileSync(path.join(p.root, '.claude', 'algo-del-usuario.json'), '{"a":2}');
  } } }));
  assert.equal(r.ok, false);
  assert.ok(['ROLLED_BACK', 'RECOVERY_REQUIRED'].includes(r.status), r.status);
  assert.match(JSON.stringify(r.errors), /algo-del-usuario\.json/);
});
