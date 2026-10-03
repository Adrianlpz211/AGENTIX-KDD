#!/usr/bin/env node
'use strict';
/**
 * Genera src/release-manifests.json: los hashes de cada archivo del framework
 * en las versiones PUBLICADAS. Es la "plantilla verificable de la versión
 * anterior" que usa `akdd update` para clasificar un archivo cuando el proyecto
 * no tiene registro de propiedad (.agentic/_update/owned.json):
 *
 *   · su contenido (con finales de línea normalizados) coincide con ALGUNA
 *     versión publicada  → framework sin cambios: se puede reemplazar;
 *   · no coincide con ninguna → personalizado: se conserva y la versión nueva
 *     se guarda aparte.
 *
 * Los hashes salen del paquete real descargado de npm, no de una lista a mano.
 *
 *   node scripts/gen-release-manifests.cjs [versión ...]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { herramienta } = require('../src/run-safe');
const { extractTarGz } = require('../src/tar-extract');
const manifest = require('../src/managed-manifest');

const VERSIONES = process.argv.length > 2 ? process.argv.slice(2) : [
  '3.15.0', '3.15.1', '3.15.2', '3.16.0', '3.16.1', '3.16.5', '3.16.7', '3.16.9',
  '3.17.0', '3.18.0', '3.18.1', '3.19.0', '3.20.0',
];

/** Hash de contenido con CRLF → LF: un checkout de Windows no convierte un archivo en "personalizado". */
function hashNormalizado(buf) {
  const txt = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const norm = Buffer.from(txt.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
  return crypto.createHash('sha256').update(norm).digest('hex').slice(0, 24);
}

const cache = path.join(os.tmpdir(), 'agentix-release-cache');
fs.mkdirSync(cache, { recursive: true });
const archivos = {};
const hechas = [];
for (const v of VERSIONES) {
  const tgz = path.join(cache, `agentic-kdd-${v}.tgz`);
  if (!fs.existsSync(tgz)) {
    herramienta('npm', ['pack', `agentic-kdd@${v}`, '--ignore-scripts', '--silent', '--pack-destination', cache], { cwd: cache, timeout: 180000 });
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentix-rm-'));
  try {
    extractTarGz(tgz, dir);
    const lista = manifest.archivos(dir);
    for (const rel of lista) {
      const h = hashNormalizado(fs.readFileSync(path.join(dir, rel)));
      (archivos[rel] = archivos[rel] || {});
      (archivos[rel][h] = archivos[rel][h] || []).push(v);
    }
    hechas.push({ version: v, archivos: lista.length });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  process.stdout.write(`  ${v}\n`);
}

const salida = {
  schema: 1,
  hash: 'sha256 (24 hex) del contenido con CRLF→LF',
  generated_from: 'paquetes publicados en npm',
  versions: hechas,
  files: Object.fromEntries(Object.entries(archivos).sort(([a], [b]) => a.localeCompare(b)).map(([rel, hs]) => [rel, hs])),
};
const destino = path.join(__dirname, '..', 'src', 'release-manifests.json');
fs.writeFileSync(destino, JSON.stringify(salida) + '\n');
console.log(`escrito ${path.relative(process.cwd(), destino)} · ${Object.keys(salida.files).length} archivos · ${(fs.statSync(destino).size / 1024).toFixed(0)} KB`);
module.exports = { hashNormalizado };
