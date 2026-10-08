#!/usr/bin/env node
/**
 * Agentic KDD — Mods de Claude Code (órgano "mods")
 *
 * Un mod es un plugin de Claude Code con código que corre DENTRO del host: dibuja paneles al lado del chat y observa los eventos
 * (tokens, costo, herramientas). Es lo único que un hook clásico de settings.json NO puede dar: interfaz en vivo y el uso real.
 *
 * CÓMO SE INSTALA (documentación oficial, code.claude.com/docs/en/plugins/mods/overview): un mod se instala COMO PLUGIN, desde un
 * marketplace — `claude plugin install <plugin>@<marketplace>`. Una carpeta suelta en ~/.claude/skills solo carga el SKILL.md (el
 * comando /<carpeta>), NUNCA el módulo: por eso el panel y /agentix no aparecían (3.24.0/3.24.1 antes de este arreglo).
 *
 *   .agentic/mods/<nombre>/         fuente de verdad: viaja en el paquete npm y llega con `akdd update`.
 *   ~/.agentix/mods-marketplace/    marketplace local «agentix-mods» (.claude-plugin/marketplace.json + plugins/<nombre>/): la
 *                                   copia que Claude Code instala. Una sola, compartida por proyecto y global.
 *   .agentic/_mods-host.json        registro del PROYECTO (qué se encendió, cuándo y con qué hash). El global: ~/.agentix/_mods-host.json
 *
 * Ámbitos: proyecto → `--scope local` (solo este proyecto, no se commitea); --global → `--scope user` (todos tus proyectos).
 * Requisitos del host (documentados): Claude Code CLI ≥ 2.1.287 o app de escritorio ≥ 2.1.286 (`/status` en la pestaña Code);
 * no cargan en sesiones WSL de la app. Comprobar que cargó: `/plugin` muestra «1 mod active · agentix-live».
 *
 * Solo toca lo propio. Cursor no tiene mods: se informa, no se finge.
 * AKDD_MODS_SIN_CLAUDE=1: no invoca el CLI `claude` (pruebas, o quien lo hace a mano): deja la copia lista y dice los comandos.
 *
 * CLI: node mods-manager.cjs on|off|status|list|refresh [--mod=<nombre>] [--global] [--quiet]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawnSync } = require('child_process');

const FUENTE = path.join('.agentic', 'mods');
const DESTINO = path.join('.claude', 'skills'); // LEGADO: donde 3.24.0/3.24.1 copiaban el mod (no cargaba el módulo); se limpia
const REGISTRO = path.join('.agentic', '_mods-host.json');
const MARCA = '.agentix-mod.json'; // dentro de la copia: dice «esto lo puso Agentix»
const MERCADO = 'agentix-mods';

const casa = () => process.env.AKDD_HOME || path.join(os.homedir(), '.agentix');
const mercadoDir = () => path.join(casa(), 'mods-marketplace');

/** Dónde está la fuente, dónde está la copia que se instala y dónde se anota, según sea el ámbito del proyecto o el global. */
function ambito(root, global) {
  const cfg = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const propia = path.join(root, FUENTE);
  const fuente = fs.existsSync(propia) ? propia : path.join(__dirname, '..', 'mods');
  const destino = path.join(mercadoDir(), 'plugins');
  return {
    global: !!global, fuente, destino, scope: global ? 'user' : 'local',
    regFile: global ? path.join(casa(), '_mods-host.json') : path.join(root, REGISTRO),
    etiqueta: destino.replace(/\\/g, '/'),
    legado: global ? path.join(cfg, 'skills') : path.join(root, DESTINO),
  };
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

// ── el CLI de Claude Code ────────────────────────────────────────────────────────────────────────────────────────────

const sinClaude = () => process.env.AKDD_MODS_SIN_CLAUDE === '1';
const q = (s) => '"' + String(s).replace(/"/g, '\\"') + '"';
/** Corre `claude plugin …`. → { ok, salida, nodisponible }. Nunca lanza. */
function claude(args, cwd) {
  if (sinClaude()) return { ok: false, nodisponible: true, salida: 'AKDD_MODS_SIN_CLAUDE=1' };
  try {
    const r = spawnSync(process.env.AKDD_CLAUDE_BIN || 'claude', args.map((a) => (process.platform === 'win32' ? q(a) : a)), { cwd: cwd || process.cwd(), encoding: 'utf8', timeout: 60000, windowsHide: true, shell: process.platform === 'win32' });
    if (r.error) return { ok: false, nodisponible: /ENOENT/.test(String(r.error.code || r.error.message)), salida: String(r.error.message || r.error) };
    return { ok: r.status === 0, salida: String((r.stdout || '') + (r.stderr || '')).trim().slice(0, 600) };
  } catch (e) { return { ok: false, salida: String(e && e.message || e).slice(0, 300) }; }
}
const idPlugin = (nombre) => nombre + '@' + MERCADO;
function instaladoEnClaude(nombre, root, scope) {
  const r = claude(['plugin', 'list', '--json'], root);
  if (!r.ok) return null; // no se pudo saber
  return r.salida.includes(idPlugin(nombre));
}
const comandosManuales = (nombre, a) => [
  `claude plugin marketplace add "${mercadoDir()}"`,
  `claude plugin install ${idPlugin(nombre)} --scope ${a.scope}`,
];

/** Escribe .claude-plugin/marketplace.json con los plugins que haya en plugins/. */
function escribirMercado() {
  const dir = mercadoDir();
  const plugins = path.join(dir, 'plugins');
  const lista = fs.existsSync(plugins) ? fs.readdirSync(plugins, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(plugins, e.name, '.claude-plugin', 'plugin.json'))).map((e) => {
    let m = {}; try { m = JSON.parse(fs.readFileSync(path.join(plugins, e.name, '.claude-plugin', 'plugin.json'), 'utf8')); } catch { /* sin manifiesto legible */ }
    return { name: e.name, source: './plugins/' + e.name, description: m.description || ('Mod ' + e.name + ' de Agentix'), version: m.version || undefined };
  }) : [];
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: MERCADO, owner: { name: 'Agentix' }, description: 'Mods de Agentix (paneles de Claude Code)', plugins: lista }, null, 2) + '\n');
}

/** Limpia la copia LEGADA (3.24.0/3.24.1: skills/<nombre>), solo si la puso Agentix: ahí solo cargaba el SKILL.md y duplicaba el comando. */
function limpiarLegado(a, nombre) {
  const dest = path.join(a.legado, nombre);
  if (fs.existsSync(path.join(dest, MARCA))) { fs.rmSync(dest, { recursive: true, force: true }); return true; }
  return false;
}

function encender(root, nombre, opts = {}) {
  const a = ambito(root, opts.global);
  const src = path.join(a.fuente, nombre);
  if (!fs.existsSync(path.join(src, '.claude-plugin', 'plugin.json'))) return { mod: nombre, ok: false, reason_code: 'MOD_DESCONOCIDO' };
  const dest = path.join(a.destino, nombre);
  const hash = hashCarpeta(src);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const rel of listarArchivos(src)) {
    const t = path.join(dest, rel);
    fs.mkdirSync(path.dirname(t), { recursive: true });
    fs.copyFileSync(path.join(src, rel), t);
  }
  fs.writeFileSync(path.join(dest, MARCA), JSON.stringify({ agentix: true, mod: nombre, hash, instalado: new Date().toISOString() }, null, 2) + '\n');
  escribirMercado();
  const limpio = limpiarLegado(a, nombre);

  // Claude Code: registrar el marketplace local e instalar el plugin (o actualizarlo si ya estaba).
  const pasos = [];
  let carga = null;
  const yaEstaba = instaladoEnClaude(nombre, root, a.scope);
  if (yaEstaba === null && sinClaude()) carga = 'PENDIENTE_CLAUDE_CLI';
  else {
    const add = claude(['plugin', 'marketplace', 'add', mercadoDir()], root);
    if (add.nodisponible) carga = 'PENDIENTE_CLAUDE_CLI';
    else {
      if (!add.ok) claude(['plugin', 'marketplace', 'update', MERCADO], root); // ya estaba añadido: se refresca
      const inst = yaEstaba ? claude(['plugin', 'update', idPlugin(nombre), '--scope', a.scope], root) : claude(['plugin', 'install', idPlugin(nombre), '--scope', a.scope], root);
      pasos.push(inst.salida);
      carga = inst.ok ? 'INSTALADO' : 'FALLO_INSTALAR';
      if (!inst.ok && yaEstaba) { const re = claude(['plugin', 'install', idPlugin(nombre), '--scope', a.scope], root); pasos.push(re.salida); carga = re.ok ? 'INSTALADO' : 'FALLO_INSTALAR'; }
    }
  }
  const r = registro(root, opts.global);
  r[nombre] = { instalado: new Date().toISOString(), hash, destino: `${a.etiqueta}/${nombre}`.replace(/\\/g, '/'), scope: a.scope, carga };
  guardarRegistro(root, r, opts.global);
  const res = { mod: nombre, ok: carga !== 'FALLO_INSTALAR', ambito: a.global ? 'global' : 'proyecto', scope: a.scope, destino: r[nombre].destino, hash, carga };
  if (limpio) res.legado_quitado = true;
  if (carga === 'INSTALADO') res.siguiente = 'Escribe /reload-plugins en la sesión abierta (o abre una nueva) y comprueba con /plugin: debe decir «1 mod active · ' + nombre + '». Después, /agentix abre el panel.';
  if (carga === 'PENDIENTE_CLAUDE_CLI') res.siguiente = 'No encontré el comando `claude`. Haz esto a mano en una terminal:\n  ' + comandosManuales(nombre, a).join('\n  ');
  if (carga === 'FALLO_INSTALAR') { res.reason_code = 'FALLO_INSTALAR'; res.detalle = pasos.filter(Boolean).join(' | ').slice(0, 500); res.siguiente = 'Prueba a mano:\n  ' + comandosManuales(nombre, a).join('\n  '); }
  res.requisitos = 'Claude Code CLI ≥ 2.1.287 o app de escritorio ≥ 2.1.286 (comprueba con /status en la pestaña Code). No carga en sesiones WSL de la app.';
  return res;
}

function apagar(root, nombre, opts = {}) {
  const a = ambito(root, opts.global);
  const r = registro(root, opts.global);
  const legado = limpiarLegado(a, nombre);
  let desinstalado = null;
  if (!sinClaude()) { const u = claude(['plugin', 'uninstall', idPlugin(nombre), '--scope', a.scope], root); desinstalado = u.ok; }
  const habia = !!r[nombre];
  delete r[nombre];
  guardarRegistro(root, r, opts.global);
  // La copia del marketplace es compartida (proyecto y global): solo se borra si nadie más la tiene encendida.
  const otro = registro(root, !opts.global);
  if (!otro[nombre]) { fs.rmSync(path.join(a.destino, nombre), { recursive: true, force: true }); try { escribirMercado(); } catch { /* sin mercado */ } }
  return { mod: nombre, ok: true, ambito: a.global ? 'global' : 'proyecto', quitado: habia || legado, desinstalado_en_claude: desinstalado };
}

function estado(root, opts = {}) {
  const a = ambito(root, opts.global);
  const r = registro(root, opts.global);
  return disponibles(root, opts).map((nombre) => {
    const m = manifiesto(root, nombre, opts);
    const dest = path.join(a.destino, nombre);
    const reg = r[nombre] || null;
    const copiado = fs.existsSync(path.join(dest, MARCA));
    const hashFuente = hashCarpeta(path.join(a.fuente, nombre));
    const hashInstalado = copiado ? hashCarpeta(dest) : null;
    const enClaude = reg ? instaladoEnClaude(nombre, root, a.scope) : null; // true / false / null = no se pudo comprobar
    let situacion = 'APAGADO';
    if (reg && copiado && hashInstalado === hashFuente) situacion = enClaude === false ? 'NO_INSTALADO_EN_CLAUDE' : 'AL_DIA';
    else if (reg && copiado) situacion = 'DESACTUALIZADO';
    const legado = fs.existsSync(path.join(a.legado, nombre, MARCA));
    return {
      mod: nombre, ambito: a.global ? 'global' : 'proyecto', scope: a.scope, version: m.version || null, descripcion: m.description || null,
      situacion, instalado: !!reg && copiado, en_claude: enClaude, destino: `${a.etiqueta}/${nombre}`.replace(/\\/g, '/'),
      hash_fuente: hashFuente, hash_instalado: hashInstalado, instalado_en: reg ? reg.instalado : null,
      host: 'claude', nota_cursor: 'Cursor no tiene mods de este tipo: este órgano solo aplica a Claude Code',
      ...(situacion === 'NO_INSTALADO_EN_CLAUDE' ? { aviso: 'la copia está pero Claude Code no lo tiene instalado: corre `akdd mod on' + (a.global ? ' --global' : '') + '`' } : {}),
      ...(legado ? { aviso: 'queda una copia LEGADA en ' + a.legado.replace(/\\/g, '/') + '/' + nombre + ' (solo cargaba el skill): `akdd mod on` la quita' } : {}),
    };
  });
}

/** Lo que llama `akdd update`: refresca SOLO los mods que el dueño ya tenía encendidos. */
function refrescar(root, opts = {}) {
  const r = registro(root, opts.global);
  return Object.keys(r).filter((n) => disponibles(root, opts).includes(n)).map((n) => encender(root, n, opts));
}

module.exports = { disponibles, encender, apagar, estado, refrescar, hashCarpeta, ambito, FUENTE, DESTINO, REGISTRO, MARCA, MERCADO };

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
