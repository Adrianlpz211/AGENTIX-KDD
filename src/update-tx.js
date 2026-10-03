'use strict';

/**
 * update-tx — aplicar una versión del framework como una transacción.
 *
 * Windows no ofrece un rename atómico de muchos archivos, así que la
 * atomicidad se construye: journal en disco + copia de respaldo de cada
 * archivo que se va a tocar. Si algo falla a mitad, se revierte todo lo
 * escrito; si el proceso muere a mitad, la siguiente corrida encuentra el
 * journal en estado 'aplicando' y revierte antes de hacer nada.
 *
 *   staging    temp único por corrida (mkdtemp), nunca compartido
 *   validar    rutas confinadas, sin enlaces, motor presente y con sintaxis válida
 *   aplicar    backup → escribir → registrar; personalizados no se pisan
 *   obsoletos  solo se borran si los instaló Agentix y nadie los tocó
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { herramienta } = require('./run-safe');
const tx = require('./tar-extract');
const manifest = require('./managed-manifest');

const barra = (p) => String(p).split(path.sep).join('/');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const hashArchivo = (f) => sha256(fs.readFileSync(f));

function dirUpdate(projectPath) { return path.join(projectPath, '.agentic', '_update'); }
function ownedPath(projectPath) { return path.join(dirUpdate(projectPath), 'owned.json'); }

function leerJSON(f, def) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } }
function escribirJSON(f, v) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2));
  fs.renameSync(tmp, f);
}

// ── Staging ─────────────────────────────────────────────────────────────────

/** Nombre de una entrada del tar después de quitar el directorio raíz. */
function rutaTrasStrip(nombre) {
  const partes = String(nombre).replace(/\\/g, '/').split('/').filter((p) => p !== '' && p !== '.');
  return partes.slice(1).join('/');
}

function entradaHostil(nombre) {
  const n = String(nombre).replace(/\\/g, '/');
  if (/^\//.test(n) || /^[A-Za-z]:/.test(n)) return 'ruta absoluta';
  if (n.split('/').includes('..')) return 'sale del directorio (..)';
  if (/[\0]/.test(n)) return 'carácter nulo';
  return null;
}

/** Revisa el contenido del tar ANTES de extraer: un archivo hostil nunca se escribe. */
function revisarTar(archivo) {
  const nombres = tx.listarTarGz(archivo);
  const detalle = tx.listarTarGz(archivo, { detalle: true });
  const problemas = [];
  for (const n of nombres) {
    const p = entradaHostil(n);
    if (p) problemas.push(`${n}: ${p}`);
  }
  for (const linea of detalle) {
    if (/^[lh]/.test(linea) || / -> | link to /.test(linea)) problemas.push(`enlace en el archivo: ${linea.trim()}`);
  }
  return problemas;
}

/** Recorre el staging extraído: nada de enlaces ni rutas que resuelvan fuera. */
function revisarArbol(dir) {
  const real = fs.realpathSync(dir);
  const problemas = [];
  const pila = [dir];
  while (pila.length) {
    const d = pila.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) { problemas.push(`enlace: ${barra(path.relative(dir, p))}`); continue; }
      const rp = fs.realpathSync(p);
      if (rp !== real && !rp.startsWith(real + path.sep)) { problemas.push(`fuera del staging: ${barra(path.relative(dir, p))}`); continue; }
      if (st.isDirectory()) pila.push(p);
    }
  }
  return problemas;
}

function prepararStaging(archivo) {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-update-'));
  try {
    const hostiles = revisarTar(archivo);
    if (hostiles.length) throw codigo('ARCHIVO_HOSTIL', 'el archivo descargado trae entradas inseguras:\n    ' + hostiles.slice(0, 10).join('\n    '));
    tx.extractTarGz(archivo, staging);
    const arbol = revisarArbol(staging);
    if (arbol.length) throw codigo('ARCHIVO_HOSTIL', 'el contenido extraído no está confinado:\n    ' + arbol.slice(0, 10).join('\n    '));
    return staging;
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw e;
  }
}

/** Antes de aplicar: el motor existe, la versión se lee y todo .cjs/.js compila. */
function validarStaging(staging) {
  const problemas = [];
  for (const req of ['.agentic/grafo/grafo.cjs', '.agentic/agentes']) {
    if (!fs.existsSync(path.join(staging, req))) problemas.push(`falta ${req}`);
  }
  const fw = leerJSON(path.join(staging, '.agentic', 'grafo', 'framework.json'), null);
  for (const rel of manifest.archivos(staging)) {
    if (!/\.(c?js)$/.test(rel)) continue;
    const src = fs.readFileSync(path.join(staging, rel), 'utf8').replace(/^#!.*/, '');
    try { new vm.Script('(function(){' + src + '\n})', { filename: rel }); }
    catch (e) { problemas.push(`${rel}: no compila (${e.message})`); }
  }
  return { ok: problemas.length === 0, problemas, version: fw ? fw.version : null };
}

function prepararBundle(bundleRoot) {
  const root = path.resolve(bundleRoot);
  const pkg = leerJSON(path.join(root, 'package.json'), null);
  const fw = leerJSON(path.join(root, '.agentic/grafo/framework.json'), null);
  if (!pkg || pkg.name !== 'agentic-kdd' || !fw || fw.version !== pkg.version) throw codigo('BUNDLE_INVALIDO', 'El paquete y su motor deben declarar la misma versión.');
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-bundle-'));
  const archivos = manifest.archivos(root);
  try {
    for (const rel of archivos) {
      const src = path.join(root, rel);
      if (fs.lstatSync(src).isSymbolicLink()) throw codigo('BUNDLE_INVALIDO', 'No se permiten enlaces: ' + rel);
      const dest = path.join(staging, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
    fs.copyFileSync(path.join(root, 'package.json'), path.join(staging, 'package.json'));
    const seed = path.join(root, 'templates/seed');
    if (fs.existsSync(seed)) fs.cpSync(seed, path.join(staging, 'templates/seed'), { recursive: true, dereference: false });
    const valido = validarStaging(staging);
    if (!valido.ok) throw codigo('BUNDLE_INVALIDO', valido.problemas.join('\n'));
    const digest = sha256(JSON.stringify(archivos.map(rel => [rel, hashArchivo(path.join(staging, rel))])));
    return { staging, sha256: digest, version: fw.version };
  } catch (e) { fs.rmSync(staging, { recursive: true, force: true }); throw e; }
}

// ── Ref fijada ──────────────────────────────────────────────────────────────

/** Convierte una ref (rama/tag) en un commit concreto. Un SHA ya es fijo. */
function resolverRef(repoUrl, ref) {
  if (/^[0-9a-f]{40}$/i.test(ref)) return ref.toLowerCase();
  const out = herramienta('git', ['ls-remote', repoUrl, ref, `${ref}^{}`], { timeout: 30000 }).toString();
  const lineas = out.split(/\r?\n/).filter(Boolean).map((l) => l.split(/\s+/));
  const preferida = lineas.find((l) => l[1] === `refs/tags/${ref}^{}`)
    || lineas.find((l) => l[1] === `refs/tags/${ref}`)
    || lineas.find((l) => l[1] === `refs/heads/${ref}`);
  if (!preferida) throw codigo('REF_NO_EXISTE', `la ref '${ref}' no existe en ${repoUrl}`);
  return preferida[0].toLowerCase();
}

// ── Journal ─────────────────────────────────────────────────────────────────

function abrirJournal(projectPath, meta) {
  const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex');
  const dir = path.join(dirUpdate(projectPath), 'tx', id);
  fs.mkdirSync(path.join(dir, 'backup'), { recursive: true });
  const j = { id, dir, archivo: path.join(dir, 'journal.json'), datos: { estado: 'aplicando', inicio: new Date().toISOString(), ...meta, entradas: [] } };
  escribirJSON(j.archivo, j.datos);
  return j;
}

/** Anota y respalda ANTES de tocar el archivo: el journal siempre va por delante. */
function respaldar(j, projectPath, rel, accion) {
  if (j.datos.entradas.some((e) => e.rel === rel)) return;
  const abs = path.join(projectPath, rel);
  const existia = fs.existsSync(abs);
  if (existia) {
    const dest = path.join(j.dir, 'backup', rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(abs, dest);
  }
  j.datos.entradas.push({ rel, existia, accion });
  escribirJSON(j.archivo, j.datos);
}

function revertir(projectPath, journalFile) {
  const datos = leerJSON(journalFile, null);
  if (!datos) return { ok: false, revertidos: 0 };
  const dir = path.dirname(journalFile);
  let n = 0;
  for (const e of [...datos.entradas].reverse()) {
    const abs = path.join(projectPath, e.rel);
    if (e.existia) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.copyFileSync(path.join(dir, 'backup', e.rel), abs);
    } else {
      fs.rmSync(abs, { force: true });
    }
    n++;
  }
  datos.estado = 'revertido';
  datos.fin = new Date().toISOString();
  escribirJSON(journalFile, datos);
  return { ok: true, revertidos: n };
}

function cerrarJournal(j, extra) {
  Object.assign(j.datos, extra, { estado: 'aplicado', fin: new Date().toISOString() });
  escribirJSON(j.archivo, j.datos);
}

/** Un update que murió a mitad se revierte antes de empezar otro. */
function recuperarPendientes(projectPath) {
  const base = path.join(dirUpdate(projectPath), 'tx');
  const recuperados = [];
  let ids = [];
  try { ids = fs.readdirSync(base); } catch { return recuperados; }
  for (const id of ids) {
    const f = path.join(base, id, 'journal.json');
    const d = leerJSON(f, null);
    if (d && d.estado === 'aplicando') recuperados.push({ id, ...revertir(projectPath, f) });
  }
  return recuperados;
}

/** Se conservan las últimas transacciones aplicadas para poder volver atrás a mano. */
function podar(projectPath, conservar = 3) {
  const base = path.join(dirUpdate(projectPath), 'tx');
  let ids = [];
  try { ids = fs.readdirSync(base).sort(); } catch { return; }
  const cerradas = ids.filter((id) => {
    const d = leerJSON(path.join(base, id, 'journal.json'), null);
    return d && d.estado !== 'aplicando';
  });
  for (const id of cerradas.slice(0, Math.max(0, cerradas.length - conservar))) {
    fs.rmSync(path.join(base, id), { recursive: true, force: true });
  }
}

// ── Aplicar ─────────────────────────────────────────────────────────────────

/**
 * Copia los archivos managed del staging al proyecto dentro del journal.
 *
 *   filtro(rel)    false = protegido, no se toca
 *   fallarTras     solo pruebas: lanza después de N escrituras
 */
function aplicar(projectPath, staging, j, opts = {}) {
  const owned = leerJSON(ownedPath(projectPath), { archivos: {} });
  const previos = owned.archivos || {};
  const nuevos = manifest.archivos(staging);
  const enNueva = new Set(nuevos);
  const resultado = { escritos: [], sinCambios: [], personalizados: [], protegidos: [], obsoletosBorrados: [], obsoletosConservados: [] };
  const hashes = {};
  let escrituras = 0;
  const pendientes = path.join(j.dir, 'personalizados');

  for (const rel of nuevos) {
    const src = path.join(staging, rel);
    const dest = path.join(projectPath, rel);
    const nuevoHash = hashArchivo(src);
    if (opts.filtro && !opts.filtro(rel)) { resultado.protegidos.push(rel); continue; }
    if (fs.existsSync(dest)) {
      const actual = hashArchivo(dest);
      if (actual === nuevoHash) { hashes[rel] = actual; resultado.sinCambios.push(rel); continue; }
      if (previos[rel] && previos[rel] !== actual) {
        /* Lo instaló Agentix y alguien lo cambió: es del usuario ahora. */
        const copia = path.join(pendientes, rel);
        fs.mkdirSync(path.dirname(copia), { recursive: true });
        fs.copyFileSync(src, copia);
        hashes[rel] = previos[rel];
        resultado.personalizados.push(rel);
        continue;
      }
    }
    respaldar(j, projectPath, rel, 'escribir');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    hashes[rel] = nuevoHash;
    resultado.escritos.push(rel);
    escrituras++;
    if (opts.fallarTras && escrituras >= opts.fallarTras) throw codigo('FALLO_INYECTADO', `fallo inyectado tras ${escrituras} escrituras`);
  }

  for (const rel of Object.keys(previos)) {
    if (enNueva.has(rel) || !manifest.esManaged(rel)) continue;
    const abs = path.join(projectPath, rel);
    if (!fs.existsSync(abs)) continue;
    if (opts.filtro && !opts.filtro(rel)) { resultado.protegidos.push(rel); continue; }
    if (hashArchivo(abs) === previos[rel]) {
      respaldar(j, projectPath, rel, 'borrar');
      fs.rmSync(abs, { force: true });
      resultado.obsoletosBorrados.push(rel);
    } else {
      resultado.obsoletosConservados.push(rel);
    }
  }

  resultado.hashes = hashes;
  return resultado;
}

/** Tras escrituras posteriores (CLAUDE.md con lo del usuario), el hash vale el final. */
function registrarOwned(projectPath, hashes, meta, finales = []) {
  const h = { ...hashes };
  for (const rel of finales) {
    const abs = path.join(projectPath, rel);
    if (fs.existsSync(abs) && h[rel]) h[rel] = hashArchivo(abs);
  }
  escribirJSON(ownedPath(projectPath), { ...meta, actualizado: new Date().toISOString(), archivos: h });
}

function codigo(code, msg) { const e = new Error(msg); e.code = code; return e; }

module.exports = {
  prepararBundle, prepararStaging, validarStaging, revisarTar, revisarArbol, entradaHostil, rutaTrasStrip,
  resolverRef, abrirJournal, respaldar, revertir, cerrarJournal, recuperarPendientes, podar,
  aplicar, registrarOwned, ownedPath, dirUpdate, hashArchivo, sha256,
};
