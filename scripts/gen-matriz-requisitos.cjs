#!/usr/bin/env node
'use strict';
/**
 * Matriz requisito → prueba → plataforma → artefacto de 3.20.1.
 *
 *   node scripts/gen-matriz-requisitos.cjs            escribe MATRIZ-3.20.1.md y comprueba que cada prueba existe
 *   node scripts/gen-matriz-requisitos.cjs --check    solo comprueba (sale 1 si alguna prueba citada no existe)
 *
 * Por qué existe: "no basta contar tests". Cada requisito de los seis documentos de la especificación
 * (C01, C02, C03, H01, H02, H03) se enlaza con la prueba que lo cubre, con el ALCANCE de esa prueba
 * (proceso real, fixture, simulado, host real NO_EJECUTADO) y con la plataforma y el artefacto del último
 * `npm run release:check`. Una prueba citada que no existe hace fallar la comprobación: la matriz no se pudre.
 *
 * "Implementado" no equivale a "verificado", ni "verificado" a "publicado": esta matriz no dice lo tercero.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const datos = JSON.parse(fs.readFileSync(path.join(__dirname, 'requisitos-3.20.1.json'), 'utf8'));

function archivoDe(nombre) {
  const candidatos = [path.join(ROOT, 'test', nombre + '.test.cjs'), path.join(ROOT, 'scripts', nombre + '.cjs')];
  return candidatos.find((f) => fs.existsSync(f)) || null;
}

function comprobar() {
  const huecos = [];
  const docs = new Set();
  for (const r of datos.requisitos) {
    docs.add(r.doc);
    // Un requisito NO_EJECUTADO (host real) puede no tener prueba: se DECLARA pendiente, no se cubre con una prueba que no es suya.
    if ((!r.pruebas || !r.pruebas.length) && !/NO_EJECUTADO/.test(r.alcance)) huecos.push({ id: r.id, motivo: 'sin pruebas' });
    for (const [archivo, titulo] of r.pruebas || []) {
      const f = archivoDe(archivo);
      if (!f) { huecos.push({ id: r.id, motivo: 'no existe el archivo ' + archivo }); continue; }
      if (!fs.readFileSync(f, 'utf8').includes(titulo)) huecos.push({ id: r.id, motivo: 'no aparece "' + titulo + '" en ' + path.relative(ROOT, f) });
    }
  }
  for (const d of ['C01', 'C02', 'C03', 'H01', 'H02', 'H03']) if (!docs.has(d)) huecos.push({ id: d, motivo: 'el documento no tiene requisitos' });
  return huecos;
}

function informeRelease() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, '_output', 'release-' + datos.version, 'verification.json'), 'utf8')); } catch { return null; }
}

function markdown() {
  const rel = informeRelease();
  const l = [];
  l.push('# Matriz de requisitos — Agentix ' + datos.version);
  l.push('');
  l.push(datos.nota);
  l.push('');
  if (rel) {
    l.push('**Último release check:** ' + rel.status + ' · ' + (rel.platform || 'plataforma n/d') + ' · Node ' + (rel.node || 'n/d') + (rel.package ? ' · artefacto `' + rel.package.file + '` sha256 `' + rel.package.sha256 + '`' : '') + (rel.finished_at ? ' · ' + rel.finished_at : ''));
    l.push('');
    l.push('El informe dice en qué plataforma y Node corrió: **no se infiere de otras**. Linux y Node 20/22 están en la matriz de CI y no se ejecutaron en esta máquina.');
  } else {
    l.push('**Último release check:** no hay informe en `_output/` (ejecuta `npm run release:check`). Sin informe no hay plataforma ni artefacto certificados.');
  }
  l.push('');
  for (const doc of ['C01', 'C02', 'C03', 'H01', 'H02', 'H03', 'TEAMS']) {
    const lista = datos.requisitos.filter((r) => r.doc === doc);
    l.push('## ' + doc + ' (' + lista.length + ' requisitos)');
    l.push('');
    l.push('| Id | Requisito | Prueba (archivo › título) | Alcance | Nota |');
    l.push('|---|---|---|---|---|');
    for (const r of lista) {
      const pruebas = (r.pruebas.length ? r.pruebas : [['(ninguna)', 'pendiente: host real']]).map(([a, t]) => '`' + a + '` › ' + t.replace(/\|/g, '\\|')).join('<br>');
      l.push('| ' + r.id + ' | ' + r.requisito.replace(/\|/g, '\\|') + ' | ' + pruebas + ' | ' + r.alcance + ' | ' + (r.nota || '') + ' |');
    }
    l.push('');
  }
  const noHost = datos.requisitos.filter((r) => /NO_EJECUTADO/.test(r.alcance));
  l.push('## Lo que NO está verificado');
  l.push('');
  l.push('- **Hosts reales (Cursor, Claude Code):** ' + (noHost.length ? noHost.map((r) => r.id).join(', ') + ' quedan `NO_EJECUTADO`. ' : '') + 'Los receptores/constructores/directores de TEAMS en las pruebas son simulados; el protocolo y la base son reales.');
  l.push('- **Campañas con modelos reales:** `NO_EJECUTADO` (cuestan dinero y requieren autorización). El benchmark es determinista y mide payload.');
  l.push('- **Publicación:** esta matriz no afirma que 3.20.1 esté publicada: `npm view agentic-kdd version` y `npm run release:verify` lo dicen.');
  l.push('');
  return l.join('\n');
}

if (require.main === module) {
  const huecos = comprobar();
  if (huecos.length) { console.error('Matriz con huecos:\n' + huecos.map((h) => '  · ' + h.id + ': ' + h.motivo).join('\n')); process.exit(1); }
  if (!process.argv.includes('--check')) {
    fs.writeFileSync(path.join(ROOT, 'MATRIZ-' + datos.version + '.md'), markdown());
    console.log('MATRIZ-' + datos.version + '.md escrita · ' + datos.requisitos.length + ' requisitos · todas las pruebas citadas existen');
  } else console.log(datos.requisitos.length + ' requisitos · todas las pruebas citadas existen');
}

module.exports = { comprobar, markdown, datos };
