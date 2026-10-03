#!/usr/bin/env node
/**
 * prepublish-check.js — "cinturón de seguridad" de publicación de Agentic KDD.
 *
 * Se ejecuta SOLO via el hook `prepublishOnly` de npm, justo antes de `npm publish`.
 * Si algo está mal, BLOQUEA la publicación (exit 1). Así es imposible publicar:
 *   - un motor sin los fixes (copia vieja),
 *   - con la versión descuadrada entre package.json y el README,
 *   - con la copia muerta src/grafo.cjs (rompería la fuente única),
 *   - filtrando datos del proyecto (memoria.db).
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const errors = [];

// 1. El motor canónico existe y trae el fix del parser (CAMPO_RE)
const enginePath = path.join(ROOT, '.agentic', 'grafo', 'grafo.cjs');
if (!fs.existsSync(enginePath)) {
  errors.push('Falta el motor canónico: .agentic/grafo/grafo.cjs');
} else if (!fs.readFileSync(enginePath, 'utf8').includes('CAMPO_RE')) {
  errors.push('El motor no tiene el fix del parser (CAMPO_RE) — parece una copia vieja.');
}

// 2. Versión coherente entre package.json y el badge del README
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const ver = pkg.version;
const readmePath = path.join(ROOT, 'README.es.md');
if (fs.existsSync(readmePath)) {
  const m = fs.readFileSync(readmePath, 'utf8').match(/Agentic_KDD-v([0-9][0-9.]*)/);
  if (m && m[1] !== ver) {
    errors.push(`Versión descuadrada: package.json=${ver} pero el badge del README dice v${m[1]}.`);
  }
}

// 3. Fuente única: no debe existir la copia muerta del motor
if (fs.existsSync(path.join(ROOT, 'src', 'grafo.cjs'))) {
  errors.push('src/grafo.cjs existe — es copia muerta. La fuente única es .agentic/grafo/. Bórrala.');
}

// 4. No filtrar datos del proyecto
const npmignorePath = path.join(ROOT, '.npmignore');
const npmignore = fs.existsSync(npmignorePath) ? fs.readFileSync(npmignorePath, 'utf8') : '';
if (!/memoria\.db/.test(npmignore)) {
  errors.push('.npmignore no excluye .agentic/memoria.db — riesgo de publicar datos del proyecto.');
}

// 5. Versión única: framework.json, servidor MCP y derivados sin deriva
const deriva = require('./sync-version.cjs').check(ROOT);
for (const p of deriva.problemas) errors.push('Deriva de versión/documentos: ' + p + ' (corre: node scripts/sync-version.cjs)');

if (errors.length) {
  console.error('\n⛔ prepublish-check FALLÓ — publicación bloqueada:\n');
  errors.forEach(e => console.error('   • ' + e));
  console.error('\nArregla lo anterior y reintenta `npm publish`.\n');
  process.exit(1);
}

console.log(`✅ prepublish-check OK — Agentic KDD v${ver} listo para publicar.`);
