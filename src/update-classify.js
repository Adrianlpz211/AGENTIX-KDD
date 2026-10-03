'use strict';

/**
 * Clasificación de archivos del framework antes de un update (3.20.1).
 *
 * Cada archivo administrado del paquete nuevo se clasifica con una BASE
 * VERIFICABLE, no con una suposición:
 *
 *   base 1: .agentic/_update/owned.json (lo que Agentix instaló y su hash)
 *   base 2: src/release-manifests.json (hashes de las versiones PUBLICADAS)
 *
 * Sin ninguna base fiable el archivo se CONSERVA, la versión entrante se guarda
 * aparte y se informa el conflicto. Nunca se asume que es reemplazable.
 *
 * Clases: NUEVO · SIN_CAMBIOS · FRAMEWORK_SIN_CAMBIOS · PERSONALIZADO ·
 *         PROTEGIDO · DESCONOCIDO
 * Acciones: CREAR · ESCRIBIR · OMITIR · CONSERVAR_Y_APARTAR · NINGUNA
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const manifest = require('./managed-manifest');

let RELEASES = { files: {}, versions: [] };
try { RELEASES = require('./release-manifests.json'); } catch { /* sin manifiesto: solo owned.json */ }

/**
 * Archivos sin los cuales el motor nuevo no funciona. Si uno de ellos queda
 * conservado (personalizado, desconocido o protegido) el resultado sería un
 * motor a medias: se bloquea ANTES de aplicar nada.
 */
const ESENCIALES = [
  '.agentic/grafo/grafo.cjs', '.agentic/grafo/db-adapter.cjs', '.agentic/grafo/schema-catalog.cjs',
  '.agentic/grafo/schema-catalog.data.json', '.agentic/grafo/schema.sql', '.agentic/grafo/schema-columns.cjs',
  '.agentic/grafo/update-guard.cjs', '.agentic/grafo/memory-inventory.cjs', '.agentic/grafo/kdd-memory.cjs',
  '.agentic/grafo/mcp-server.cjs', '.agentic/grafo/framework.json',
];

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
/** Mismo hash que scripts/gen-release-manifests.cjs: contenido con CRLF→LF, 24 hex. */
function hashNorm(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return sha(Buffer.from(b.toString('latin1').replace(/\r\n/g, '\n'), 'latin1')).slice(0, 24);
}
const leer = (f) => fs.readFileSync(f);

/**
 * Parte un CLAUDE.md en (plantilla + marcador) y (texto del usuario).
 * Misma lógica que migrarInstruccionesUsuario en update.js (hay un test de paridad).
 */
function partirInstrucciones(texto) {
  const lineas = String(texto).split('\n');
  const sinCR = (l) => l.replace(/\r$/, '');
  const i = lineas.findIndex((l) => /^#\s*INSTRUCCIONES DEL PROYECTO/.test(sinCR(l)));
  if (i < 0) return { encontrado: false, cabeza: texto, usuario: '' };
  let r = i + 1;
  while (r < lineas.length && /^#(?!#)/.test(sinCR(lineas[r]))) r++;
  let borde = i;
  for (let k = r - 1; k > i; k--) if (/^#\s*={5,}\s*$/.test(sinCR(lineas[k]))) { borde = k; break; }
  const cabeza = lineas.slice(0, borde + 1).join('\n') + '\n';
  const usuario = lineas.slice(borde + 1).join('\n').replace(/^(?:[ \t]*\r?\n)+/, '').replace(/\s+$/, '');
  return { encontrado: true, cabeza, usuario, borde };
}

function versionesConocidas(rel, hash) {
  const hs = RELEASES.files && RELEASES.files[rel];
  return hs && hs[hash] ? hs[hash] : null;
}
const habiaEnReleases = (rel) => !!(RELEASES.files && RELEASES.files[rel]);

/**
 * Plan completo y SIN escribir. Devuelve una entrada por archivo administrado
 * del paquete entrante, más los conflictos y los bloqueos.
 *
 * opts: { projectPath, staging, owned (objeto owned.json), filtro (rel => bool, false = protegido) }
 */
function clasificar(opts) {
  const { projectPath, staging, filtro } = opts;
  const previos = (opts.owned && opts.owned.archivos) || {};
  const hayOwned = Object.keys(previos).length > 0;
  const entradas = [], conflictos = [], bloqueos = [];

  for (const rel of manifest.archivos(staging)) {
    const src = path.join(staging, rel);
    const dest = path.join(projectPath, rel);
    const nuevoNorm = hashNorm(leer(src));
    const e = { rel, clase: null, accion: null, base: null, motivo: '', hash_nuevo: sha(leer(src)), hash_actual: null };

    if (filtro && !filtro(rel)) { Object.assign(e, { clase: 'PROTEGIDO', accion: 'OMITIR', motivo: 'declarado en .agentic/protected_files' }); entradas.push(e); continue; }
    if (!fs.existsSync(dest)) { Object.assign(e, { clase: 'NUEVO', accion: 'CREAR', motivo: 'no existía en el proyecto' }); entradas.push(e); continue; }

    const actualBuf = leer(dest);
    e.hash_actual = sha(actualBuf);
    if (e.hash_actual === e.hash_nuevo) { Object.assign(e, { clase: 'SIN_CAMBIOS', accion: 'NINGUNA', motivo: 'ya es la versión nueva' }); entradas.push(e); continue; }
    const actualNorm = hashNorm(actualBuf);
    if (actualNorm === nuevoNorm) { Object.assign(e, { clase: 'SIN_CAMBIOS', accion: 'NINGUNA', motivo: 'solo difieren los finales de línea' }); entradas.push(e); continue; }

    // CLAUDE.md: lo del usuario va debajo del marcador; se compara la plantilla.
    let comparable = actualNorm;
    if (rel === 'CLAUDE.md') {
      const p = partirInstrucciones(actualBuf.toString('utf8'));
      if (p.encontrado) comparable = hashNorm(Buffer.from(p.cabeza, 'utf8'));
    }

    if (hayOwned && previos[rel]) {
      // Base 1: lo que Agentix instaló (hash registrado del archivo final).
      if (e.hash_actual === previos[rel]) {
        Object.assign(e, { clase: 'FRAMEWORK_SIN_CAMBIOS', accion: 'ESCRIBIR', base: 'owned.json', motivo: 'coincide con lo que Agentix instaló' });
      } else if (versionesConocidas(rel, comparable) || versionesConocidas(rel, actualNorm)) {
        const v = versionesConocidas(rel, comparable) || versionesConocidas(rel, actualNorm);
        Object.assign(e, { clase: 'FRAMEWORK_SIN_CAMBIOS', accion: 'ESCRIBIR', base: 'release:' + v.join(','), motivo: 'coincide con una versión publicada' });
      } else {
        Object.assign(e, { clase: 'PERSONALIZADO', accion: 'CONSERVAR_Y_APARTAR', base: 'owned.json', motivo: 'cambió desde que Agentix lo instaló' });
      }
    } else {
      // Base 2: versiones publicadas.
      const v = versionesConocidas(rel, comparable) || versionesConocidas(rel, actualNorm);
      if (v) {
        Object.assign(e, { clase: 'FRAMEWORK_SIN_CAMBIOS', accion: 'ESCRIBIR', base: 'release:' + v.join(','), motivo: 'coincide con una versión publicada de Agentix' });
      } else if (habiaEnReleases(rel)) {
        Object.assign(e, { clase: 'PERSONALIZADO', accion: 'CONSERVAR_Y_APARTAR', base: 'release-manifests', motivo: 'no coincide con ninguna versión publicada: tiene cambios propios' });
      } else {
        Object.assign(e, { clase: 'DESCONOCIDO', accion: 'CONSERVAR_Y_APARTAR', base: null, motivo: 'sin base fiable para saber si es del framework o suyo' });
      }
    }
    if (e.accion === 'CONSERVAR_Y_APARTAR') conflictos.push({ file: rel, clase: e.clase, motivo: e.motivo });
    entradas.push(e);
  }

  // Un esencial conservado deja un motor mezclado: no se aplica nada.
  for (const e of entradas) {
    if (!ESENCIALES.includes(e.rel)) continue;
    if (e.accion === 'CONSERVAR_Y_APARTAR' || e.accion === 'OMITIR') {
      bloqueos.push({ code: 'ESENCIAL_CONSERVADO', file: e.rel, clase: e.clase, message: `${e.rel} es indispensable para el motor nuevo y está ${e.clase === 'PROTEGIDO' ? 'protegido' : 'personalizado'}: actualizar dejaría un motor a medias. Revise la copia nueva o quite la protección y repita.` });
    }
  }
  // Archivos que Agentix instaló y el paquete nuevo ya no trae: solo se retiran si nadie los tocó.
  const enNuevo = new Set(entradas.map((e) => e.rel));
  const obsoletos = [];
  for (const rel of Object.keys(previos)) {
    if (enNuevo.has(rel) || !manifest.esManaged(rel)) continue;
    const abs = path.join(projectPath, rel);
    if (!fs.existsSync(abs)) continue;
    if (filtro && !filtro(rel)) { obsoletos.push({ rel, accion: 'OMITIR' }); continue; }
    obsoletos.push({ rel, accion: sha(leer(abs)) === previos[rel] ? 'BORRAR' : 'CONSERVAR' });
  }
  const cuenta = {};
  for (const e of entradas) cuenta[e.clase] = (cuenta[e.clase] || 0) + 1;
  return { entries: entradas, obsolete: obsoletos, conflicts: conflictos, blockers: bloqueos, counts: cuenta, reliable_base: hayOwned || Object.keys(RELEASES.files || {}).length > 0, base: { owned_files: Object.keys(previos).length, release_versions: (RELEASES.versions || []).map((v) => v.version) } };
}

module.exports = { clasificar, partirInstrucciones, hashNorm, ESENCIALES, versionesConocidas };
