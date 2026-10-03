#!/usr/bin/env node
/**
 * Agentic KDD — Hooks de host (Claude Code y Cursor)
 *
 * Genera las entradas que llaman a host-guard.cjs en el archivo de hooks de
 * cada host, con MERGE: lo que ya había y no es nuestro no se toca. Las
 * entradas propias se reconocen porque su comando apunta a host-guard.cjs.
 * Desinstalar quita solo eso; el archivo se borra solo si lo creamos nosotros
 * y quedó vacío.
 *
 * Los hooks de un host no cubren al otro: cada uno se instala y se informa por
 * separado. Instalado ≠ verificado: VERIFIED exige probarlo en el host real.
 *
 * CLI: node host-hooks.cjs install|uninstall|status|smoke|coverage [--host=cursor|claude|all]
 */

'use strict';

const fs = require('fs');
const path = require('path');

const esPropio = (cmd) => typeof cmd === 'string'
  && (cmd.includes('host-guard.cjs') || (cmd.includes('goal-check.cjs') && cmd.includes('--hook=')));
const REGISTRO = path.join('.agentic', '_hooks-host.json');
/** Tope del bucle de stop en Cursor; goal-check además lleva sus propios turnos. */
const LOOP_LIMIT = 5;

/**
 * `node "<ruta absoluta con />"` funciona igual en bash, cmd y PowerShell, con
 * espacios en la ruta. Una variable del host ($CLAUDE_PROJECT_DIR) solo se
 * expande en bash; en PowerShell queda vacía y el hook no corre. Si el
 * proyecto se mueve, `estado` lo detecta y pide reinstalar.
 */
const script = (root, nombre) => `"${path.resolve(root || process.cwd(), '.agentic', 'grafo', nombre).replace(/\\/g, '/')}"`;

const HOSTS = {
  cursor: {
    archivo: path.join('.cursor', 'hooks.json'),
    vacio: () => ({ version: 1, hooks: {} }),
    entradas: ({ goal, root } = {}) => {
      const g = `node ${script(root, 'host-guard.cjs')} --host=cursor`;
      /* failClosed:false — decisión 2026-10-02: un payload que la guardia
         no lee no puede apagar la terminal ni la edición de Cursor. */
      return Object.assign({
        beforeShellExecution: [{ command: `${g} --event=shell`, timeout: 10, failClosed: false }],
        preToolUse: [{ command: `${g} --event=edit`, matcher: 'Write|Edit|MultiEdit|StrReplace|Delete', timeout: 10, failClosed: false }],
        beforeMCPExecution: [{ command: `${g} --event=mcp`, timeout: 10, failClosed: false }],
        beforeSubmitPrompt: [{ command: `${g} --event=prompt`, timeout: 10 }],
      }, goal ? { stop: [{ command: `node ${script(root, 'goal-check.cjs')} --hook=cursor`, timeout: 10, loop_limit: LOOP_LIMIT }] } : {});
    },
    propia: (e) => esPropio(e.command),
    comandos: (e) => [e.command],
    fail_closed: false,
    sin_enriquecimiento: 'Cursor no documenta un campo para añadir contexto al prompt: el enriquecimiento llega por el pipeline aa:; el hook de prompt solo registra el origen humano de teams: resolver',
  },
  claude: {
    archivo: path.join('.claude', 'settings.json'),
    vacio: () => ({ hooks: {} }),
    entradas: ({ goal, root } = {}) => {
      const cmd = (ev) => `node ${script(root, 'host-guard.cjs')} --host=claude --event=${ev}`;
      return Object.assign({
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: cmd('shell'), timeout: 10 }] },
          { matcher: 'Write|Edit|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: cmd('edit'), timeout: 10 }] },
          { matcher: 'mcp__.*', hooks: [{ type: 'command', command: cmd('mcp'), timeout: 10 }] },
        ],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: cmd('prompt'), timeout: 15 }] }],
      }, goal ? { Stop: [{ hooks: [{ type: 'command', command: `node ${script(root, 'goal-check.cjs')} --hook=claude`, timeout: 10 }] }] } : {});
    },
    propia: (e) => Array.isArray(e.hooks) && e.hooks.some((h) => esPropio(h.command)),
    comandos: (e) => (e.hooks || []).map((h) => h.command),
    /* Un hook que se cae (exit ≠ 0 y ≠ 2) no bloquea en Claude Code: el crash no falla cerrado. */
    fail_closed: false,
  },
};

function leerJSON(f) {
  if (!fs.existsSync(f)) return { existe: false, datos: null };
  const txt = fs.readFileSync(f, 'utf8');
  if (!txt.trim()) return { existe: true, datos: null };
  try { return { existe: true, datos: JSON.parse(txt) }; } catch (e) { return { existe: true, error: e.message }; }
}

function escribirJSON(f, datos) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(datos, null, 2) + '\n');
  fs.renameSync(tmp, f);
}

function registro(root) { try { return JSON.parse(fs.readFileSync(path.join(root, REGISTRO), 'utf8')); } catch { return {}; } }
function guardarRegistro(root, r) { escribirJSON(path.join(root, REGISTRO), r); }

function quitarPropias(h, cfg) {
  let quitadas = 0;
  for (const ev of Object.keys(cfg.hooks || {})) {
    if (!Array.isArray(cfg.hooks[ev])) continue;
    const antes = cfg.hooks[ev].length;
    cfg.hooks[ev] = cfg.hooks[ev].filter((e) => !h.propia(e));
    quitadas += antes - cfg.hooks[ev].length;
    if (!cfg.hooks[ev].length) delete cfg.hooks[ev];
  }
  return quitadas;
}

/**
 * `goal: true` añade el hook de stop que persigue un goal por fase; sin un
 * goal activado con `goal-check activar --sprint=S` no hace nada.
 */
function instalar(root, host, { goal = false } = {}) {
  const h = HOSTS[host];
  if (!h) return { host, ok: false, reason_code: 'HOST_DESCONOCIDO' };
  const f = path.join(root, h.archivo);
  const l = leerJSON(f);
  if (l.error) return { host, ok: false, reason_code: 'ARCHIVO_ILEGIBLE', detalle: `${h.archivo}: ${l.error} — no se sobrescribe` };
  const cfg = l.datos || h.vacio();
  if (host === 'cursor' && cfg.version === undefined) cfg.version = 1;
  if (!cfg.hooks || typeof cfg.hooks !== 'object') cfg.hooks = {};
  quitarPropias(h, cfg);
  const nuevas = h.entradas({ goal, root });
  for (const [ev, lista] of Object.entries(nuevas)) cfg.hooks[ev] = [...(cfg.hooks[ev] || []), ...lista];
  escribirJSON(f, cfg);
  const r = registro(root);
  if (!r[host]) r[host] = { creado_por_agentix: !l.existe };
  r[host].instalado = new Date().toISOString();
  r[host].ruta = path.resolve(root).replace(/\\/g, '/');
  delete r[host].smoke;
  guardarRegistro(root, r);
  return { host, ok: true, archivo: h.archivo, eventos: Object.keys(nuevas), verificado: 'NO_VERIFICADO', nota: h.sin_enriquecimiento || null };
}

function desinstalar(root, host) {
  const h = HOSTS[host];
  if (!h) return { host, ok: false, reason_code: 'HOST_DESCONOCIDO' };
  const f = path.join(root, h.archivo);
  const l = leerJSON(f);
  if (l.error) return { host, ok: false, reason_code: 'ARCHIVO_ILEGIBLE', detalle: l.error };
  if (!l.datos) return { host, ok: true, quitadas: 0 };
  const cfg = l.datos;
  const quitadas = quitarPropias(h, cfg);
  const r = registro(root);
  const nuestro = r[host] && r[host].creado_por_agentix;
  const vacio = !Object.keys(cfg.hooks || {}).length && Object.keys(cfg).every((k) => k === 'hooks' || k === 'version');
  if (nuestro && vacio) fs.unlinkSync(f);
  else if (quitadas) escribirJSON(f, cfg);
  delete r[host];
  guardarRegistro(root, r);
  return { host, ok: true, quitadas, archivo_borrado: !!(nuestro && vacio) };
}

const cap = () => require('./capacidad-estado.cjs');
const hashGuardia = () => cap().hashArchivos([path.join(__dirname, 'host-guard.cjs'), path.join(__dirname, 'protected-files.cjs')]);

function propiasDe(h, cfg) {
  const out = {};
  for (const [ev, lista] of Object.entries(cfg.hooks || {})) {
    if (!Array.isArray(lista)) continue;
    const p = lista.filter((e) => h.propia(e));
    if (p.length) out[ev] = p;
  }
  return out;
}

function eventosHost(root, host, desde) {
  let txt = '';
  try { txt = fs.readFileSync(path.join(root, '.agentic', '_hooks-eventos.jsonl'), 'utf8'); } catch { return []; }
  return txt.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && e.host === host && e.origen === 'host' && e.event_id && (!desde || e.at >= desde));
}

function estado(root) {
  const r = registro(root);
  return Object.keys(HOSTS).map((host) => {
    const h = HOSTS[host];
    const l = leerJSON(path.join(root, h.archivo));
    if (l.error) return { host, instalado: false, reason_code: 'ARCHIVO_ILEGIBLE', capacidad: cap().evaluar({}) };
    const cfg = l.datos || { hooks: {} };
    const propias = propiasDe(h, cfg);
    const eventos = Object.keys(propias);
    const reg = r[host] || {};
    const degradado = [];
    const aqui = path.resolve(root).replace(/\\/g, '/');
    const cmds = Object.values(propias).flat().flatMap((e) => h.comandos(e)).filter(Boolean);
    if (cmds.length && !cmds.every((c) => c.includes(aqui) || !/^node\s+"/.test(c))) degradado.push('RUTA_MOVIDA: reinstalar los hooks');
    if (!h.fail_closed) degradado.push('CRASH_NO_FALLA_CERRADO: si la guardia se cae, el host deja pasar la acción');
    const hash_config = cap().hashArchivos([path.join(root, h.archivo)]);
    const verificaciones = [];
    if (reg.smoke && reg.smoke.ok) verificaciones.push({ scope: 'fixture', execution_id: reg.smoke.execution_id, hash_modulo: reg.smoke.hash_guardia, hash_config: reg.smoke.hash_config, host });
    const reales = eventosHost(root, host, reg.instalado);
    for (const e of reales) verificaciones.push({ scope: 'host', execution_id: e.event_id, hash_modulo: reg.smoke ? reg.smoke.hash_guardia : null, hash_config, host });
    const capacidad = cap().evaluar({ instalado: eventos.length > 0, configurado: eventos.length > 0, disponible: eventos.length > 0, degradado, verificaciones }, { hash_modulo: hashGuardia(), hash_config, host });
    const porEvento = {};
    for (const e of reales) porEvento[e.evento] = (porEvento[e.evento] || 0) + 1;
    return {
      host, instalado: eventos.length > 0, eventos, archivo: h.archivo,
      verificado: capacidad.estado === 'VERIFIED' ? 'VERIFICADO_HOST' : (capacidad.verification_scope === 'fixture' ? 'VERIFICADO_FIXTURE' : 'NO_VERIFICADO'),
      ejecuciones_reales: porEvento, capacidad,
    };
  });
}

/** Payload mínimo de cada host para un evento de la guardia. */
function payload(host, evento, root, dato) {
  if (evento === 'shell') return host === 'claude' ? { tool_name: 'Bash', tool_input: { command: dato }, cwd: root } : { command: dato, hook_event_name: 'beforeShellExecution', workspace_roots: [root] };
  if (evento === 'edit') return host === 'claude' ? { tool_name: 'Write', tool_input: { file_path: dato }, cwd: root } : { tool_name: 'Write', tool_input: { path: dato }, workspace_roots: [root] };
  return host === 'claude' ? { tool_name: 'mcp__fs__write', tool_input: { path: dato }, cwd: root } : { tool_name: 'write', tool_input: { path: dato }, workspace_roots: [root] };
}

function decisionDe(host, salida) {
  try {
    const o = JSON.parse(salida || 'null');
    if (!o) return null;
    return host === 'claude' ? o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision : o.permission;
  } catch { return 'SALIDA_INVALIDA'; }
}

/**
 * Smoke en fixture: ejecuta la guardia como la ejecutaría el host (proceso
 * aparte, JSON por stdin, ruta con espacios) y comprueba cada decisión. Es
 * scope fixture: no prueba que el host real la llame — eso lo dicen los
 * eventos reales con su event_id.
 */
function smoke(root, host, { timeoutMs = 10000 } = {}) {
  const h = HOSTS[host];
  if (!h) return { host, ok: false, reason_code: 'HOST_DESCONOCIDO' };
  const os = require('os');
  const { spawnSync } = require('child_process');
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd smoke '));
  fs.mkdirSync(path.join(fx, '.agentic', '_teams'), { recursive: true });
  fs.mkdirSync(path.join(fx, 'src con espacio'), { recursive: true });
  const guardia = path.join(__dirname, 'host-guard.cjs');
  const casos = [
    { id: 'edicion-segura', evento: 'edit', dato: path.join(fx, 'src con espacio', 'a.js'), espera: 'allow' },
    { id: 'edicion-protegida', evento: 'edit', dato: path.join(fx, '.agentic', '_teams', 'origen-humano.jsonl'), espera: 'deny' },
    { id: 'shell-seguro', evento: 'shell', dato: 'git status', espera: 'allow' },
    { id: 'shell-salta-gates', evento: 'shell', dato: 'git commit --no-verify -m x', espera: 'deny' },
    { id: 'mcp-protegido', evento: 'mcp', dato: path.join(fx, '.agentic', '_teams', 'origen-humano.jsonl'), espera: 'deny' },
    { id: 'payload-malformado', evento: 'edit', crudo: '{"tool_input": {"path": ', espera: 'allow' },
  ];
  const resultados = casos.map((c) => {
    const entrada = c.crudo != null ? c.crudo : JSON.stringify(payload(host, c.evento, fx, c.dato));
    const t0 = Date.now();
    const p = spawnSync(process.execPath, [guardia, `--host=${host}`, `--event=${c.evento}`], { input: entrada, cwd: fx, encoding: 'utf8', timeout: timeoutMs, windowsHide: true, env: Object.assign({}, process.env, { AKDD_HOOK_SMOKE: '1' }) });
    const ms = Date.now() - t0;
    const obtenida = p.error ? (/ETIMEDOUT/.test(p.error.code || '') ? 'TIMEOUT' : 'ERROR') : decisionDe(host, p.stdout);
    return { id: c.id, espera: c.espera, obtenida, ms, ok: obtenida === c.espera && p.status === 0 };
  });
  try { fs.rmSync(fx, { recursive: true, force: true }); } catch { /* temporal */ }
  const ok = resultados.every((x) => x.ok);
  const r = registro(root);
  const execution_id = 'smoke-' + host + '-' + Date.now().toString(36);
  if (r[host]) {
    r[host].smoke = { at: new Date().toISOString(), scope: 'fixture', ok, execution_id, hash_guardia: hashGuardia(), hash_config: cap().hashArchivos([path.join(root, h.archivo)]), node: process.version, casos: resultados };
    guardarRegistro(root, r);
  }
  return { host, ok, scope: 'fixture', execution_id, casos: resultados, registrado: !!r[host], fail_closed_en_crash: h.fail_closed };
}

/**
 * Cada vía por la que algo puede escribir en el proyecto y qué la controla.
 * Un hook de host no prueba que ninguna otra vía escriba: lo que no tiene
 * control previo se dice, y el enforcement nunca se declara completo.
 */
function cobertura(root) {
  const st = Object.fromEntries(estado(root).map((s) => [s.host, s]));
  const conHook = (ev) => Object.values(st).filter((s) => s.eventos.some((e) => ev.test(e))).map((s) => `${s.host}:${s.verificado}`);
  const gitHook = (() => { try { return /agentix|akdd|canario|pre-commit-gates/i.test(fs.readFileSync(path.join(root, '.git', 'hooks', 'pre-commit'), 'utf8')); } catch { return false; } })();
  const ci = (() => { try { return fs.readdirSync(path.join(root, '.github', 'workflows')).some((f) => /run-tests|npm test/.test(fs.readFileSync(path.join(root, '.github', 'workflows', f), 'utf8'))); } catch { return false; } })();
  const fila = (via, controles, previo) => ({ via, controles, estado: previo && controles.length ? 'CUBIERTO' : (controles.length ? 'SOLO_POSTERIOR' : 'SIN_CONTROL') });
  const posterior = [gitHook ? 'git pre-commit' : null, ci ? 'CI' : null].filter(Boolean);
  const filas = [
    fila('edición por herramienta del agente', conHook(/^(preToolUse|PreToolUse)$/), conHook(/^(preToolUse|PreToolUse)$/).length > 0),
    fila('shell del agente', conHook(/^(beforeShellExecution|PreToolUse)$/), conHook(/^(beforeShellExecution|PreToolUse)$/).length > 0),
    fila('herramientas MCP', conHook(/^(beforeMCPExecution|PreToolUse)$/), conHook(/^(beforeMCPExecution|PreToolUse)$/).length > 0),
    fila('scripts lanzados por shell', [...conHook(/^(beforeShellExecution|PreToolUse)$/).map((x) => x + ' (solo el comando, no lo que el script escribe)'), ...posterior], false),
    fila('git staged / commit', posterior, gitHook),
    fila('akdd update', ['protected-files en update', ...posterior], true),
    fila('aa: / sprint / TEAMS (PRE_CLOSE)', ['gates de cierre (post-cycle, teams verificar) — detectan después de escribir, no evitan la escritura'], false),
    fila('aa: / sprint / TEAMS (POST_DETECTION)', posterior, false),
    fila('edición manual fuera del agente', posterior, false),
  ];
  const huecos = filas.filter((f) => f.estado !== 'CUBIERTO').map((f) => f.via);
  return { enforcement: huecos.length ? 'DEGRADED' : 'COMPLETO', huecos, filas, hosts: st };
}

module.exports = { instalar, desinstalar, estado, smoke, cobertura, HOSTS, LOOP_LIMIT };

if (require.main === module) {
  const [cmd = 'status', ...rest] = process.argv.slice(2);
  const conocidos = new Set(['cursor', 'claude', 'all']);
  const pos = rest.filter((a) => !a.startsWith('--') && !a.startsWith('/'));
  const extra = pos.filter((a) => !conocidos.has(a));
  const flags = rest.filter((a) => a.startsWith('--') && !a.startsWith('--host=') && a !== '--goal');
  if (extra.length || flags.length) {
    console.error(JSON.stringify({ ok: false, reason_code: 'ARG_DESCONOCIDO', extra, flags }));
    process.exit(2);
  }
  const flagHost = rest.find((a) => a.startsWith('--host='));
  const arg = flagHost ? flagHost.slice(7) : (pos.find((a) => conocidos.has(a)) || 'all');
  if (!conocidos.has(arg)) {
    console.error(JSON.stringify({ ok: false, reason_code: 'HOST_DESCONOCIDO', host: arg }));
    process.exit(2);
  }
  const hosts = arg === 'all' ? Object.keys(HOSTS) : [arg];
  const root = process.cwd();
  let out;
  if (cmd === 'install') out = hosts.map((x) => instalar(root, x, { goal: rest.includes('--goal') }));
  else if (cmd === 'uninstall') out = hosts.map((x) => desinstalar(root, x));
  else if (cmd === 'smoke') out = hosts.map((x) => smoke(root, x));
  else if (cmd === 'coverage' || cmd === 'cobertura') out = cobertura(root);
  else out = estado(root);
  console.log(JSON.stringify(out, null, 2));
  if (Array.isArray(out) && out.some((x) => x.ok === false)) process.exitCode = 1;
}
