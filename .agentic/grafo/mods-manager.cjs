#!/usr/bin/env node
/**
 * Agentic KDD — Mods de Claude Code (órgano "mods")
 *
 * Un mod es un plugin de function hooks de Claude Code: dibuja paneles al lado
 * del chat y observa los eventos del host (tokens, costo, herramientas). Es lo
 * único que un hook clásico de settings.json NO puede dar: interfaz en vivo y
 * el uso que reporta el propio host.
 *
 * Dónde vive cada cosa, y por qué:
 *   .agentic/mods/<nombre>/      fuente de verdad: viaja en el paquete npm y
 *                                 llega a cada cliente con `akdd update`.
 *   .claude/skills/<nombre>/     copia instalada: Claude Code carga solo los
 *                                 plugins de esa carpeta del proyecto, sin
 *                                 flags ni variables de entorno. Es un
 *                                 artefacto de instalación (como
 *                                 .claude/settings.json), no se commitea.
 *   .agentic/_mods-host.json     registro: qué se instaló, cuándo y con qué
 *                                 hash, para que `status` distinga "al día" de
 *                                 "desactualizado" y `akdd update` lo refresque
 *                                 solo si el dueño lo había encendido.
 *
 * Solo toca lo propio: una carpeta ajena en .claude/skills/ con el mismo nombre
 * no se pisa (reason_code AJENO). Cursor no tiene mods: se informa, no se finge.
 *
 * CLI: node mods-manager.cjs on|off|status|list [--mod=<nombre>] [--quiet]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FUENTE = path.join('.agentic', 'mods');
const DESTINO = path.join('.claude', 'skills');
const REGISTRO = path.join('.agentic', '_mods-host.json');
const MARCA = '.agentix-mod.json'; // dentro de la copia instalada: dice "esto lo puso Agentix"

function listarArchivos(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listarArchivos(p, base));
    else out.push(path.relative(base, p).replace(/\\/g, '/'));
  }
  return out.sort();
}

function hashCarpeta(dir) {
  const h = crypto.createHash('sha256');
  for (const rel of listarArchivos(dir)) {
    if (rel === MARCA) continue;
    h.update(rel + '\0').update(fs.readFileSync(path.join(dir, rel))).update('\0');
  }
  return h.digest('hex').slice(0, 16);
}

function registro(root) { try { return JSON.parse(fs.readFileSync(path.join(root, REGISTRO), 'utf8')) || {}; } catch { return {}; } }
function guardarRegistro(root, r) {
  const f = path.join(root, REGISTRO);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(r, null, 2) + '\n');
}

/** Los mods que trae esta instalación de Agentix (carpetas con manifiesto). */
function disponibles(root) {
  const dir = path.join(root, FUENTE);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, '.claude-plugin', 'plugin.json')))
    .map((e) => e.name).sort();
}

function manifiesto(root, nombre) {
  try { return JSON.parse(fs.readFileSync(path.join(root, FUENTE, nombre, '.claude-plugin', 'plugin.json'), 'utf8')); } catch { return {}; }
}

/** ¿La carpeta destino es nuestra? Vacía o inexistente también cuenta como libre. */
function esPropia(dest) {
  if (!fs.existsSync(dest)) return true;
  if (fs.existsSync(path.join(dest, MARCA))) return true;
  return fs.readdirSync(dest).length === 0;
}

function encender(root, nombre) {
  const src = path.join(root, FUENTE, nombre);
  if (!fs.existsSync(path.join(src, '.claude-plugin', 'plugin.json'))) return { mod: nombre, ok: false, reason_code: 'MOD_DESCONOCIDO' };
  const dest = path.join(root, DESTINO, nombre);
  if (!esPropia(dest)) return { mod: nombre, ok: false, reason_code: 'AJENO', detalle: `${DESTINO}/${nombre} ya existe y no lo puso Agentix — no se toca` };
  const hash = hashCarpeta(src);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const rel of listarArchivos(src)) {
    const a = path.join(dest, rel);
    fs.mkdirSync(path.dirname(a), { recursive: true });
    fs.copyFileSync(path.join(src, rel), a);
  }
  fs.writeFileSync(path.join(dest, MARCA), JSON.stringify({ agentix: true, mod: nombre, hash, instalado: new Date().toISOString() }, null, 2) + '\n');
  const r = registro(root);
  r[nombre] = { instalado: new Date().toISOString(), hash, destino: `${DESTINO}/${nombre}`.replace(/\\/g, '/') };
  guardarRegistro(root, r);
  return { mod: nombre, ok: true, destino: r[nombre].destino, hash, carga: 'Claude Code lo carga solo en la próxima sesión de este proyecto (en la actual: reabrir la sesión)', host: 'claude' };
}

function apagar(root, nombre) {
  const dest = path.join(root, DESTINO, nombre);
  const r = registro(root);
  if (fs.existsSync(dest) && !fs.existsSync(path.join(dest, MARCA))) {
    return { mod: nombre, ok: false, reason_code: 'AJENO', detalle: `${DESTINO}/${nombre} no lo puso Agentix — no se borra` };
  }
  const habia = fs.existsSync(dest);
  fs.rmSync(dest, { recursive: true, force: true });
  delete r[nombre];
  guardarRegistro(root, r);
  return { mod: nombre, ok: true, quitado: habia };
}

function estado(root) {
  const r = registro(root);
  return disponibles(root).map((nombre) => {
    const m = manifiesto(root, nombre);
    const dest = path.join(root, DESTINO, nombre);
    const reg = r[nombre] || null;
    const instalado = fs.existsSync(path.join(dest, MARCA));
    const hashFuente = hashCarpeta(path.join(root, FUENTE, nombre));
    const hashInstalado = instalado ? hashCarpeta(dest) : null;
    let situacion = 'APAGADO';
    if (instalado && hashInstalado === hashFuente) situacion = 'AL_DIA';
    else if (instalado) situacion = 'DESACTUALIZADO';
    else if (fs.existsSync(dest) && fs.readdirSync(dest).length) situacion = 'AJENO';
    return {
      mod: nombre, version: m.version || null, descripcion: m.description || null,
      situacion, instalado, destino: `${DESTINO}/${nombre}`.replace(/\\/g, '/'),
      hash_fuente: hashFuente, hash_instalado: hashInstalado, instalado_en: reg ? reg.instalado : null,
      host: 'claude', nota_cursor: 'Cursor no tiene mods de este tipo: este órgano solo aplica a Claude Code',
    };
  });
}

/** Lo que llama `akdd update`: refresca SOLO los mods que el dueño ya tenía encendidos. */
function refrescar(root) {
  const r = registro(root);
  return Object.keys(r).filter((n) => disponibles(root).includes(n)).map((n) => encender(root, n));
}

module.exports = { disponibles, encender, apagar, estado, refrescar, hashCarpeta, FUENTE, DESTINO, REGISTRO, MARCA };

if (require.main === module) {
  const [cmd = 'status', ...rest] = process.argv.slice(2);
  const root = process.cwd();
  const flagMod = rest.find((a) => a.startsWith('--mod='));
  const quiet = rest.includes('--quiet');
  const mods = flagMod ? [flagMod.slice(6)] : disponibles(root);
  let out;
  if (cmd === 'on') out = mods.map((n) => encender(root, n));
  else if (cmd === 'off') out = mods.map((n) => apagar(root, n));
  else if (cmd === 'refresh') out = refrescar(root);
  else if (cmd === 'list') out = disponibles(root);
  else out = estado(root);
  if (!quiet) console.log(JSON.stringify(out, null, 2));
  if (Array.isArray(out) && out.some((x) => x && x.ok === false)) process.exitCode = 1;
}
