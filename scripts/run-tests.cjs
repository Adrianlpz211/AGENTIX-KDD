#!/usr/bin/env node
'use strict';

/**
 * Corredor de tests portable entre versiones de Node.
 *
 * POR QUÉ EXISTE
 * --------------
 * `npm test` era `node --test "test/*.test.cjs"`. Eso funciona en Node 22 y
 * falla en Node 20 — el runner de Node no expande comodines hasta la v21, así
 * que en la v20 la cadena se toma como una ruta literal que no existe y el
 * paso muere sin ejecutar una sola aserción.
 *
 * Y el CI corre las dos versiones. Resultado: Node 20 en rojo, Node 22
 * cancelado en cascada, y ninguna pista de que la causa era el comodín y no el
 * código.
 *
 * Aquí la lista de archivos se resuelve en JavaScript, que se comporta igual en
 * todas las versiones, y se le pasa explícita al runner.
 *
 * Solo se recogen los `*.test.cjs` del directorio `test/`: NO se recorre en
 * profundidad, para que `test/helpers/` (ayudantes, no tests) no acabe
 * ejecutándose como si lo fuera.
 *
 *   npm test                    todos
 *   npm test -- error-cure      solo los que contengan ese texto
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const DIR = path.join(RAIZ, 'test');

const filtro = process.argv.slice(2).filter((a) => !a.startsWith('-'));

const archivos = fs.readdirSync(DIR)
  .filter((f) => f.endsWith('.test.cjs'))
  .filter((f) => !filtro.length || filtro.some((q) => f.includes(q)))
  .sort()
  .map((f) => path.join('test', f));

if (!archivos.length) {
  console.error('  Sin tests que correr' + (filtro.length ? ` para: ${filtro.join(', ')}` : '') + '.');
  process.exit(1);
}

console.log(`  ${archivos.length} archivo(s) de test · Node ${process.version}\n`);

const r = spawnSync(process.execPath, ['--test', ...archivos], {
  cwd: RAIZ,
  stdio: 'inherit',
});

process.exit(r.status === null ? 1 : r.status);
