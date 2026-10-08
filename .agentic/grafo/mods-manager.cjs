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
 * Ámbito GLOBAL (--global): la misma copia en la carpeta de usuario de Claude Code
 * (~/.claude/skills/<nombre>, o $CLAUDE_CONFIG_DIR/skills), para tenerlo en TODOS los
 * proyectos sin correr `akdd mod on` en cada uno. El registro va en
 * ~/.agentix/_mods-host.json ($AKDD_HOME lo cambia). La fuente es la del proyecto
 * actual si la trae, o la del propio paquete de Agentix. Si un proyecto tiene además
 * su copia local, Claude Code vería el mod dos veces: status y on lo avisan.
 *
 * CLI: node mods-manager.cjs on|off|status|list|refresh [--mod=<nombre>] [--global] [--quiet]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const FUENTE = path.join('.agentic', 'mods');
const DESTINO = path.join('.claude', 'skills');
const REGISTRO = path.join('.agentic', '_mods-host.json');
const MARCA = '.agentix-mod.json'; // dentro de la copia instalada: dice "esto lo puso Agentix"

/** Dónde está la fuente, dónde se instala y dónde se anota, según sea el ámbito del proyecto o el global. */
function ambito(root, global) {
  if (!global) return { global: false, fuente: path.join(root, FUENTE), destino: path.join(root, DESTINO), regFile: path.join(root, REGISTRO), etiqueta: DESTINO.replace(/\\/g, '/') };
  const cfg = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const casa = process.env.AKDD_HOME || path.join(os.homedir(), '.agentix');
  const propia = path.join(root, FUENTE);
  const fuente = fs.existsSync(propia) ? propia : path.join(__dirname, '..', 'mods');
  const destino = path.join(cfg, 'skills');
  return { global: true, fuente, destino, regFile: path.join(casa, '_mods-host.json'), etiqueta: destino.replace(/\\/g, '/') };
}

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

function registro(root, global) { try { return JSON.parse(fs.readFileSync(ambito(root, global).regFile, 'utf8')) || {}; } catch { return {}; } }
function guardarRegistro(root, r, global) {
  const f = ambito(root, global).regFile;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(r, null, 2) + '\n');
}

/** Los mods que trae esta instalación de Agentix (carpetas con manifiesto). */
function disponibles(root, opts = {}) {
  const dir = ambito(root, opts.global).fuente;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, '.claude-plugin', 'plugin.json')))
    .map((e) => e.name).sort();
}

function manifiesto(root, nombre, opts = {}) {
  try { return JSON.parse(fs.readFileSync(path.join(ambito(root, opts.global).fuente, nombre, '.claude-plugin', 'plugin.json'), 'utf8')); } catch { return {}; }
}

/** ¿La carpeta destino es nuestra? Vacía o inexistente también cuenta como libre. */
function esPropia(dest) {
  if (!fs.existsSync(dest)) return true;
  if (fs.existsSync(path.join(dest, MARCA))) return true;
  return fs.readdirSync(dest).length === 0;
}

function encender(root, nombre, opts = {}) {
  const a = ambito(root, opts.global);
  const src = path.join(a.fuente, nombre);
  if (!fs.existsSync(path.join(src, '.claude-plugin', 'plugin.json'))) return { mod: nombre, ok: false, reason_code: 'MOD_DESCONOCIDO' };
  const dest = path.join(a.destino, nombre);
  if (!esPropia(dest)) return { mod: nombre, ok: false, reason_code: 'AJENO', detalle: `${a.etiqueta}/${nombre} ya existe y no lo puso Agentix — no se toca` };
  const hash = hashCarpeta(src);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const rel of listarArchivos(src)) {
    const a = path.join(dest, rel);
    fs.mkdirSync(path.dirname(a), { recursive: true });
    fs.copyFileSync(path.join(src, rel), a);
  }
  fs.writeFileSync(path.join(dest, MARCA), JSON.stringify({ agentix: true, mod: nombre, hash, instalado: new Date().toISOString() }, null, 2) + '\n');
  const r = registro(root, opts.global);
  r[nombre] = { instalado: new Date().toISOString(), hash, destino: `${a.etiqueta}/${nombre}`.replace(/\\/g, '/') };
  guardarRegistro(root, r, opts.global);
  const res = { mod: nombre, ok: true, ambito: a.global ? 'global' : 'proyecto', destino: r[nombre].destino, hash, carga: a.global ? 'Claude Code lo carga en TODOS tus proyectos desde la próxima sesión (en las que ya están abiertas: reabrirlas)' : 'Claude Code lo carga solo en la próxima sesión de este proyecto (en la actual: reabrir la sesión)', host: 'claude' };
  if (a.global && fs.existsSync(path.join(root, DESTINO, nombre, MARCA))) res.aviso = `este proyecto también tiene su copia local (${DESTINO}/${nombre}): Claude Code vería el mod dos veces. Quítala con: akdd mod off`;
  return res;
}

function apagar(root, nombre, opts = {}) {
  const a = ambito(root, opts.global);
  const dest = path.join(a.destino, nombre);
  const r = registro(root, opts.global);
  if (fs.existsSync(dest) && !fs.existsSync(path.join(dest, MARCA))) {
    return { mod: nombre, ok: false, reason_code: 'AJENO', detalle: `${a.etiqueta}/${nombre} no lo puso Agentix — no se borra` };
  }
  const habia = fs.existsSync(dest);
  fs.rmSync(dest, { recursive: true, force: true });
  delete r[nombre];
  guardarRegistro(root, r, opts.global);
  return { mod: nombre, ok: true, ambito: a.global ? 'global' : 'proyecto', quitado: habia };
}

function estado(root, opts = {}) {
  const a = ambito(root, opts.global);
  const r = registro(root, opts.global);
  return disponibles(root, opts).map((nombre) => {
    const m = manifiesto(root, nombre, opts);
    const dest = path.join(a.destino, nombre);
    const reg = r[nombre] || null;
    const instalado = fs.existsSync(path.join(dest, MARCA));
    const hashFuente = hashCarpeta(path.join(a.fuente, nombre));
    const hashInstalado = instalado ? hashCarpeta(dest) : null;
    let situacion = 'APAGADO';
    if (instalado && hashInstalado === hashFuente) situacion = 'AL_DIA';
    else if (instalado) situacion = 'DESACTUALIZADO';
    else if (fs.existsSync(dest) && fs.readdirSync(dest).length) situacion = 'AJENO';
    return {
      mod: nombre, ambito: a.global ? 'global' : 'proyecto', version: m.version || null, descripcion: m.description || null,
      situacion, instalado, destino: `${a.etiqueta}/${nombre}`.replace(/\\/g, '/'),
      hash_fuente: hashFuente, hash_instalado: hashInstalado, instalado_en: reg ? reg.instalado : null,
      host: 'claude', nota_cursor: 'Cursor no tiene mods de este tipo: este órgano solo aplica a Claude Code',
      ...(a.global && fs.existsSync(path.join(root, DESTINO, nombre, MARCA)) ? { aviso: 'este proyecto también tiene su copia local: Claude Code vería el mod dos veces (akdd mod off la quita)' } : {}),
    };
  });
}

/** Lo que llama `akdd update`: refresca SOLO los mods que el dueño ya tenía encendidos. */
function refrescar(root, opts = {}) {
  const r = registro(root, opts.global);
  return Object.keys(r).filter((n) => disponibles(root, opts).includes(n)).map((n) => encender(root, n, opts));
}

module.exports = { disponibles, encender, apagar, estado, refrescar, hashCarpeta, ambito, FUENTE, DESTINO, REGISTRO, MARCA };

if (require.main === module) {
  const [cmd = 'status', ...rest] = process.argv.slice(2);
  const root = process.cwd();
  const flagMod = rest.find((a) => a.startsWith('--mod='));
  const quiet = rest.includes('--quiet');
  const opts = { global: rest.includes('--global') };
  const mods = flagMod ? [flagMod.slice(6)] : disponibles(root, opts);
  let out;
  if (cmd === 'on') out = mods.map((n) => encender(root, n, opts));
  else if (cmd === 'off') out = mods.map((n) => apagar(root, n, opts));
  else if (cmd === 'refresh') out = refrescar(root, opts);
  else if (cmd === 'list') out = disponibles(root, opts);
  else out = estado(root, opts);
  if (!quiet) console.log(JSON.stringify(out, null, 2));
  if (Array.isArray(out) && out.some((x) => x && x.ok === false)) process.exitCode = 1;
}
