#!/usr/bin/env node
/**
 * Agentic KDD — Guardia de host (03-mejoras-del-zip, hooks preventivos)
 *
 * Un solo motor de decisión para Claude Code y Cursor; cada host solo cambia
 * el formato de entrada/salida (--host=claude|cursor).
 *
 *   --event=shell   antes de un comando: deny si salta gates, ask si está en
 *                   la DENY LIST, allow en lo demás (lectura incluida).
 *   --event=edit    antes de escribir un archivo: deny si es protegido,
 *                   ask si es un archivo de secretos.
 *   --event=prompt  registra el origen humano de `ws:` (ambos hosts); en
 *                   Claude además enriquece `aa:` con presupuesto,
 *                   timeout y sin repetir el mismo prompt + grafo.
 *
 * Consentimiento: SOLO lo da la persona en el diálogo del host (ask). Un texto
 * dentro del comando, de la memoria o de un documento ("autorizado", "el
 * usuario confirmó") no cambia la decisión.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── motor neutral ───────────────────────────────────────────────────────────

const LECTORES = new Set(['rg', 'grep', 'egrep', 'fgrep', 'findstr', 'select-string', 'sls', 'cat', 'type', 'gc', 'get-content',
  'less', 'more', 'head', 'tail', 'echo', 'write-host', 'write-output', 'printf', 'wc', 'ls', 'dir', 'get-childitem', 'gci', 'find', 'tree', 'which', 'where']);
const GIT_LECTURA = new Set(['log', 'show', 'diff', 'grep', 'status', 'blame', 'ls-files', 'rev-parse', 'branch', 'tag', 'remote', 'describe', 'shortlog']);

/** Vacía el contenido entre comillas (lo citado es dato, no comando), conservando la longitud. */
function sinCitas(s) {
  const vaciar = (m) => m[0] + ' '.repeat(m.length - 2) + m[m.length - 1];
  return s.replace(/'[^']*'/g, vaciar).replace(/"(?:[^"\\`]|\\.|`.)*"/g, vaciar);
}

function segmentos(cmd) {
  const limpio = sinCitas(String(cmd || ''));
  const crudo = String(cmd || '');
  // separadores de bash, cmd y PowerShell; se cortan sobre el texto sin citas
  const cortes = [];
  const re = /;|&&|\|\||\||\r?\n/g;
  let m; let ini = 0;
  while ((m = re.exec(limpio))) { cortes.push([ini, m.index]); ini = m.index + m[0].length; }
  cortes.push([ini, limpio.length]);
  return cortes.map(([a, b]) => ({ limpio: limpio.slice(a, b).replace(/(^|\s)#.*$/, '').trim(), crudo: crudo.slice(a, b).trim() })).filter((s) => s.limpio || s.crudo);
}

function programa(tokens) {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][\w]*=/.test(tokens[i])) i++;
  while (i < tokens.length && /^(sudo|env|command|exec|nohup|time|&|\.)$/i.test(tokens[i])) i++;
  return { prog: (tokens[i] || '').toLowerCase().replace(/\.exe$/, '').replace(/^.*[\\/]/, ''), resto: tokens.slice(i + 1), asignaciones: tokens.slice(0, i) };
}

const DENY = 'deny';
const ASK = 'ask';

function evaluarSegmento(seg) {
  const tokens = seg.limpio.split(/\s+/).filter(Boolean);
  const { prog, resto, asignaciones } = programa(tokens);
  const bajo = seg.limpio.toLowerCase();

  // Saltar gates: nunca, se diga lo que se diga en el comando.
  if (asignaciones.some((a) => /^AKDD_SKIP_GATES=/i.test(a)) || /\$env:akdd_skip_gates\s*=|\b(export|set)\s+akdd_skip_gates\s*=?/i.test(bajo)) {
    return { decision: DENY, reason: 'BYPASS_GATES', detalle: 'AKDD_SKIP_GATES desactiva los gates; solo la persona puede usarlo, fuera del agente' };
  }
  if (asignaciones.some((a) => /^HUSKY=0$/i.test(a))) return { decision: DENY, reason: 'BYPASS_GATES', detalle: 'HUSKY=0 desactiva los hooks' };
  if (prog === 'git') {
    const sub = resto.find((t) => !t.startsWith('-')) || '';
    const flags = resto;
    if (flags.some((t) => /^-c$/.test(t)) && /core\.hookspath/i.test(bajo)) return { decision: DENY, reason: 'BYPASS_GATES', detalle: 'cambiar core.hooksPath salta los hooks' };
    if (sub === 'config' && /core\.hookspath/i.test(bajo)) return { decision: DENY, reason: 'BYPASS_GATES', detalle: 'cambiar core.hooksPath salta los hooks' };
    if (['commit', 'push', 'merge', 'rebase', 'am', 'cherry-pick'].includes(sub)) {
      if (flags.includes('--no-verify') || (sub === 'commit' && flags.some((t) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(t) && !t.startsWith('--')))) {
        return { decision: DENY, reason: 'BYPASS_GATES', detalle: '--no-verify salta los gates de commit' };
      }
    }
    if (GIT_LECTURA.has(sub)) return { decision: 'allow' };
    if (sub === 'push' && flags.some((t) => /^(--force|--force-with-lease|-f|\+)/.test(t) || /^\+/.test(t))) return { decision: ASK, reason: 'FORCE_PUSH' };
    if (sub === 'reset' && flags.includes('--hard')) return { decision: ASK, reason: 'GIT_RESET_HARD' };
    if (sub === 'clean' && flags.some((t) => /^-[a-z]*f/i.test(t))) return { decision: ASK, reason: 'GIT_CLEAN' };
    return { decision: 'allow' };
  }
  if (LECTORES.has(prog)) {
    if (/>{1,2}\s*\S/.test(seg.limpio)) { /* redirige: cae a la revisión de escritura */ } else return { decision: 'allow' };
  }

  if ((prog === 'rm' && resto.some((t) => /^-[a-z]*r/i.test(t) || t === '--recursive'))
    || ((prog === 'rmdir' || prog === 'rd') && resto.some((t) => /^\/s$/i.test(t)))
    || (['remove-item', 'ri', 'del', 'erase', 'rmdir', 'rm'].includes(prog) && resto.some((t) => /^-r(ecurse)?$/i.test(t) || /^\/s$/i.test(t)))) {
    return { decision: ASK, reason: 'BORRADO_RECURSIVO' };
  }
  if (/^(npm|yarn|pnpm|bun)$/.test(prog) && resto[0] === 'publish') return { decision: ASK, reason: 'PUBLISH' };
  if (prog === 'docker' && (/^(rm|rmi)$/.test(resto[0]) || (resto[0] === 'system' && resto[1] === 'prune') || (/^(container|image)$/.test(resto[0]) && /^(rm|prune)$/.test(resto[1])))) return { decision: ASK, reason: 'DOCKER_BORRADO' };
  if (/\b(vercel|netlify)\b.*--prod\b|\bfly(ctl)?\s+deploy\b|\b(npm|pnpm|yarn)\s+run\s+deploy\b|\bkubectl\s+(apply|delete)\b|\bterraform\s+(apply|destroy)\b|\bgh\s+release\s+create\b/i.test(seg.limpio)) {
    return { decision: ASK, reason: 'DEPLOY' };
  }
  if (/\bprisma\s+(migrate\s+(deploy|reset)|db\s+push)\b|\bsupabase\s+db\s+(push|reset)\b/i.test(seg.limpio)) return { decision: ASK, reason: 'MIGRACION' };
  // SQL destructivo: aquí sí se mira el texto citado (el SQL viaja entre comillas)
  if (/\b(drop\s+(table|database|schema)|truncate\s+table|alter\s+table\s+\S+\s+drop\s+column)\b/i.test(seg.crudo)
    || /\bdelete\s+from\s+\w+\s*(;|"|'|$)/i.test(seg.crudo)) {
    return { decision: ASK, reason: 'SQL_DESTRUCTIVO' };
  }
  // Escribir archivos de secretos
  const destinos = [...seg.limpio.matchAll(/>{1,2}\s*(\S+)/g)].map((m) => m[1]);
  const escribe = /^(set-content|sc|add-content|ac|out-file|copy-item|cp|copy|move-item|mv|move|tee|remove-item|del|rm|new-item|ni)$/.test(prog) || (prog === 'sed' && resto.includes('-i'));
  const tocaEnv = (t) => /(^|[\\/])\.env(\.[\w.-]+)?$|(^|[\\/])secrets?\.[\w]+$/i.test(t.replace(/^['"]|['"]$/g, ''));
  if (destinos.some(tocaEnv) || (escribe && resto.some(tocaEnv))) return { decision: ASK, reason: 'SECRETOS' };
  return { decision: 'allow' };
}

const PESO = { allow: 0, ask: 1, deny: 2 };

function evaluarComando(cmd) {
  let peor = { decision: 'allow' };
  for (const s of segmentos(cmd)) {
    const r = evaluarSegmento(s);
    if (PESO[r.decision] > PESO[peor.decision]) peor = r;
  }
  return peor;
}

function evaluarEdicion(root, archivo) {
  if (!archivo) return { decision: 'allow' };
  const rel = path.relative(root, path.resolve(root, String(archivo))).replace(/\\/g, '/');
  if (rel.startsWith('../') || rel === '..' || path.isAbsolute(rel)) return { decision: 'allow', reason: 'FUERA_DEL_PROYECTO' };
  if (/^\.agentic\/_whatsapp\//i.test(rel)) return { decision: DENY, reason: 'WHATSAPP_ESTADO', detalle: 'el estado de WhatsApp solo cambia con ws: activar/desactivar escritos por la persona' };
  try {
    const pf = require('./protected-files.cjs').verificar(root, [rel]);
    if (pf.status === 'FAIL') return { decision: DENY, reason: 'ARCHIVO_PROTEGIDO', detalle: `${rel} está en el manifiesto de protegidos; cambiarlo requiere el flujo de restore/override, no una edición directa` };
    if (pf.status === 'ERROR') return { decision: ASK, reason: 'MANIFIESTO_PROTEGIDOS_ERROR', detalle: pf.reason_code || 'manifiesto ilegible' };
  } catch { /* sin manifiesto: nada protegido */ }
  if (/(^|\/)\.env(\.[\w.-]+)?$|(^|\/)secrets?\.[\w]+$/i.test(rel)) return { decision: ASK, reason: 'SECRETOS', detalle: `${rel} es un archivo de secretos` };
  return { decision: 'allow' };
}

// ─── enriquecimiento (Claude UserPromptSubmit) ───────────────────────────────

const ENRIQ = { timeoutMs: 8000, maxBytes: 6000, memoria: 50 };

function enriquecer(root, prompt) {
  if (!/^\s*aa:/i.test(String(prompt || ''))) return { contexto: null, motivo: 'NO_ES_AA' };
  // El enricher escribe en la base (marca de arranque, predicción): la llave se
  // guarda con la huella de DESPUÉS, así el mismo prompt sin cambios ajenos acierta.
  const huella = () => { try { return require('./kdd-memory.cjs').huellaGrafo(root); } catch { return '-'; } };
  const llave = (h) => crypto.createHash('sha256').update(String(prompt).trim() + '\0' + h).digest('hex');
  const clave = llave(huella());
  const f = path.join(root, '.agentic', '_context', 'hook-vistos.json');
  let vistos = [];
  try { vistos = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* primero */ }
  if (vistos.includes(clave)) return { contexto: null, motivo: 'YA_ENRIQUECIDO' };
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'context-enricher.cjs'), String(prompt).replace(/^\s*aa:\s*/i, '')], { cwd: root, timeout: ENRIQ.timeoutMs, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  if (r.error || r.status !== 0) {
    const motivo = r.error && /ETIMEDOUT/.test(r.error.code || r.error.message) ? 'TIMEOUT' : 'ERROR';
    return { contexto: `[agentix] enriquecimiento no disponible (${motivo}); seguir con el pipeline normal`, motivo };
  }
  let txt = String(r.stdout || '').trim();
  try { txt = require('./telemetry.cjs').redactar(txt); } catch { /* sin redactor: se recorta igual */ }
  let truncado = false;
  if (Buffer.byteLength(txt, 'utf8') > ENRIQ.maxBytes) { txt = Buffer.from(txt, 'utf8').subarray(0, ENRIQ.maxBytes).toString('utf8') + '\n[agentix] brief recortado al presupuesto del hook'; truncado = true; }
  vistos.push(llave(huella()));
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(vistos.slice(-ENRIQ.memoria))); } catch { /* sin disco: se repetirá */ }
  return { contexto: txt || null, motivo: truncado ? 'TRUNCADO' : 'OK' };
}

// ─── adaptadores de host ─────────────────────────────────────────────────────

function objetoDe(entrada) {
  for (const candidato of [
    entrada.tool_input,
    entrada.input,
    entrada.arguments,
    entrada.params,
  ]) {
    let objeto = candidato;
    if (typeof objeto === 'string') {
      try {
        objeto = JSON.parse(objeto);
      } catch {
        continue;
      }
    }
    if (
      objeto !== null &&
      typeof objeto === 'object' &&
      !Array.isArray(objeto) &&
      Object.keys(objeto).length > 0
    ) {
      return objeto;
    }
  }
  return {};
}

function rutaDe(entrada) {
  const ti = objetoDe(entrada);
  return ti.file_path || ti.path || ti.target_file ||
    ti.filePath || entrada.file_path || entrada.path || null;
}

function comandoDe(entrada) {
  const ti = objetoDe(entrada);
  return entrada.command || ti.command || ti.cmd || '';
}

function mensaje(r) {
  return `[agentix] ${r.reason}${r.detalle ? ': ' + r.detalle : ''}`;
}

/** `ws: ...` o la respuesta a "¿a qué contacto te escribo?" quedan como prueba de origen humano. */
function origenWhatsapp(root, prompt, host) {
  try {
    const tipo = require('./whatsapp-manager.cjs').origenDesdePrompt(root, prompt, host);
    if (tipo === 'comando') return '[agentix] orden ws: registrada como escrita por la persona';
    if (tipo === 'respuesta') return '[agentix] respuesta de la persona registrada para la activación de WhatsApp en curso';
    return null;
  } catch { return null; }
}

function salida(host, evento, r, extra) {
  if (evento === 'prompt') {
    if (host !== 'claude') return { continue: true };
    if (!extra) return null;
    return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: extra } };
  }
  if (host === 'claude') {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: r.decision, permissionDecisionReason: r.decision === 'allow' ? '' : mensaje(r) } };
  }
  const o = { permission: r.decision };
  if (r.decision !== 'allow') { o.user_message = mensaje(r); o.agent_message = mensaje(r) + (r.decision === 'deny' ? '. No reintentar por otra vía.' : '. Esperar la confirmación de la persona.'); }
  return o;
}

const PAYLOAD_INVALIDO = { decision: DENY, reason: 'PAYLOAD_INVALIDO', detalle: 'la guardia no pudo leer la acción; sin saber qué hace no se permite' };

/** Rutas y comandos que trae una herramienta MCP en sus argumentos. */
function evaluarMcp(root, entrada) {
  const ti = entrada.tool_input || entrada.arguments || entrada.input || {};
  if (typeof ti !== 'object' || ti === null) return { decision: 'allow' };
  let peor = { decision: 'allow' };
  const ver = (r) => { if (PESO[r.decision] > PESO[peor.decision]) peor = r; };
  for (const [k, v] of Object.entries(ti)) {
    const vals = Array.isArray(v) ? v : [v];
    if (/^(path|paths|file|files|file_path|filepath|target_file|filename|destination)$/i.test(k)) for (const x of vals) if (typeof x === 'string') ver(evaluarEdicion(root, x));
    if (/^(command|cmd|script)$/i.test(k)) for (const x of vals) if (typeof x === 'string') ver(evaluarComando(x));
  }
  return peor;
}

/**
 * Raíz del proyecto Agentix: la primera carpeta (subiendo) que tiene
 * .agentic/grafo. El cwd de la terminal puede ser una subcarpeta: tomarlo tal
 * cual creaba un .agentic falso dentro de src/ que se coló al paquete npm
 * (atrapado por el release check el 03/10/2026). Sin proyecto: el primer
 * candidato, y anotarEvento no escribe nada.
 */
function raizProyecto(candidatos) {
  // Manda el PRIMER candidato disponible (mismo orden de siempre); solo se
  // sube desde él hasta la raíz. No se salta a otro candidato.
  const base = candidatos.find((c) => typeof c === 'string' && c && !c.includes('${')) || process.cwd();
  let dir = path.resolve(base);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.agentic', 'grafo'))) return dir;
    const padre = path.dirname(dir);
    if (padre === dir) return base;
    dir = padre;
  }
}

/** Huella de cada ejecución real: instalado no es verificado, ejecutado sí se mide. */
function anotarEvento(root, host, evento, entrada, r) {
  try {
    if (!fs.existsSync(path.join(root, '.agentic'))) return; // no es un proyecto Agentix: no se siembra .agentic
    const id = entrada.tool_use_id || entrada.generation_id || entrada.hook_event_id || entrada.conversation_id || null;
    const f = path.join(root, '.agentic', '_hooks-eventos.jsonl');
    try { if (fs.statSync(f).size > 512 * 1024) fs.renameSync(f, f + '.1'); } catch { /* nuevo */ }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), host, evento, event_id: id, decision: r ? r.decision : null, origen: process.env.AKDD_HOOK_SMOKE ? 'smoke' : 'host' }) + '\n');
  } catch { /* sin disco: no frena la decisión */ }
  capturarEnMemoria(root, host, evento, entrada, r);
}

/**
 * Captura PASIVA en la memoria con procedencia (C01): lo que el host realmente entrega por sus hooks ya
 * validados (shell, edición, MCP). Es una actividad con su job en la misma transacción. No instala nada,
 * no llama a ningún modelo y NO cambia la decisión de la guardia: ante cualquier fallo (sin tablas, base
 * ocupada, update en curso) se calla y la acción sigue su curso. Una simulación se etiqueta como tal
 * (host '-smoke') para que nadie la cuente como verificación dentro de Cursor/Claude.
 */
function capturarEnMemoria(root, host, evento, entrada, r) {
  try {
    // Aislamiento de pruebas (scripts/run-tests.cjs): una prueba contra el propio repo no escribe en su memoria real.
    if (process.env.AKDD_NO_MEMORY_CAPTURE === '1') return;
    const tipo = { shell: 'shell_command', edit: 'file_edit', mcp: 'mcp_call' }[evento];
    if (!tipo || !entrada || typeof entrada !== 'object') return;
    const core = require('./memory-core.cjs');
    const ruta = evento === 'edit' ? rutaDe(entrada) : null;
    const hid = entrada.tool_use_id || entrada.generation_id || entrada.hook_event_id || null;
    core.capturar(root, {
      host: process.env.AKDD_HOOK_SMOKE ? host + '-smoke' : host,
      session_id: String(entrada.session_id || entrada.conversation_id || 'host-session'),
      host_event_id: hid, event_type: tipo,
      paths: typeof ruta === 'string' && ruta ? [ruta] : [],
      input: evento === 'shell' ? comandoDe(entrada) : { tool: entrada.tool_name || entrada.toolName || null },
      output: r ? { decision: r.decision, reason: r.reason } : null,
    });
  } catch { /* la captura es auxiliar: jamás convierte nada en deny */ }
}

function procesar(host, evento, entrada, root) {
  if (entrada === null || typeof entrada !== 'object' || Array.isArray(entrada)) {
    if (evento === 'prompt') {
      return salida(host, evento, null, null);
    }
    return salida(host, evento, {
      decision: 'allow',
      reason: 'TRANSPORT_SIN_PAYLOAD',
      detalle: 'entrada ausente o inválida; acción no inspeccionada',
    });
  }
  let r;
  try {
    if (evento === 'shell') {
      const cmd = comandoDe(entrada);
      r = typeof cmd === 'string' && cmd.trim() ? evaluarComando(cmd) : PAYLOAD_INVALIDO;
    } else if (evento === 'edit') {
      const ruta = rutaDe(entrada);
      r = typeof ruta === 'string' && ruta ? evaluarEdicion(root, ruta) : PAYLOAD_INVALIDO;
    } else if (evento === 'mcp') r = evaluarMcp(root, entrada);
  } catch (e) {
    r = { decision: DENY, reason: 'GUARDIA_ERROR', detalle: String(e && e.message || e).slice(0, 200) };
  }
  if (r) { anotarEvento(root, host, evento, entrada, r); return salida(host, evento, r); }
  if (evento === 'prompt') {
    const prompt = entrada.prompt || entrada.user_prompt || '';
    const ws = origenWhatsapp(root, prompt, host);
    if (ws) return salida(host, evento, null, ws);
    return salida(host, evento, null, host === 'claude' ? enriquecer(root, prompt).contexto : null);
  }
  return null;
}

module.exports = { raizProyecto, anotarEvento, evaluarComando, evaluarEdicion, evaluarMcp, enriquecer, procesar, origenWhatsapp, sinCitas, ENRIQ };

if (require.main === module) {
  const opt = Object.fromEntries(process.argv.slice(2).map((a) => /^--([^=]+)=(.*)$/.exec(a)).filter(Boolean).map((m) => [m[1], m[2]]));
  let datos = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { datos += c; });
  process.stdin.on('end', () => {
    let entrada = null;
    try { entrada = datos.trim() ? JSON.parse(datos) : null; } catch { entrada = null; }
    const e = entrada && typeof entrada === 'object' ? entrada : {};
    const root = raizProyecto([Array.isArray(e.workspace_roots) ? e.workspace_roots[0] : null, e.cwd, process.env.CLAUDE_PROJECT_DIR, process.cwd()]);
    const out = procesar(opt.host === 'claude' ? 'claude' : 'cursor', opt.event || 'shell', entrada, root);
    if (out) process.stdout.write(JSON.stringify(out));
    process.exitCode = 0;
  });
}
