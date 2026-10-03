'use strict';

/**
 * Verificación FUNCIONAL tras migrar (3.20.1).
 *
 * No toca la memoria real: todo corre sobre una COPIA AISLADA — un proyecto
 * temporal con el motor ya actualizado y una copia coherente (VACUUM INTO) de
 * la base migrada. Así se prueba escribir y confirmar sin dejar "un aprendizaje
 * ficticio" en la memoria de nadie.
 *
 *   1. búsqueda real de conocimiento (kdd-memory recall) con el motor nuevo;
 *   2. compatibilidad MCP: initialize + tools/list + tools/call recall por stdio;
 *   3. escritura/lectura: INSERT + SELECT dentro de una transacción que se revierte;
 *   4. salud del proyecto (health-check): informativa, no bloquea.
 *
 * Cada comprobación devuelve PASS / FAIL / SKIP con su detalle. Lo que no se
 * pudo ejecutar queda como SKIP o NO_VERIFICADO: nunca se cuenta como PASS.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const SIN = (d, n) => ({ name: n, status: 'SKIP', detail: d });

function copiarMotor(origen, destino) {
  fs.mkdirSync(destino, { recursive: true });
  fs.cpSync(origen, destino, { recursive: true, filter: (s) => !/[\\/](vendor|graph-ui)([\\/]|$)/.test(s) });
}

/** Habla JSON-RPC por stdio con el servidor MCP del proyecto copiado. */
function rpcMcp(script, cwd, env, mensajes, esperar, timeoutMs) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [script], { cwd, env: Object.assign({}, process.env, env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const respuestas = []; let buf = ''; let hecho = false;
    const fin = (r) => { if (hecho) return; hecho = true; clearTimeout(t); try { p.stdin.end(); } catch { /* cerrado */ } try { p.kill(); } catch { /* terminado */ } resolve(r); };
    const t = setTimeout(() => fin({ ok: false, respuestas, error: 'tiempo de espera agotado' }), timeoutMs);
    p.stdout.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!l) continue;
        try { respuestas.push(JSON.parse(l)); } catch { /* línea de log */ }
        if (respuestas.length >= esperar) fin({ ok: true, respuestas });
      }
    });
    p.on('error', (e) => fin({ ok: false, respuestas, error: e.message }));
    p.on('exit', () => fin({ ok: respuestas.length >= esperar, respuestas, error: respuestas.length >= esperar ? null : 'el servidor terminó antes de responder' }));
    for (const m of mensajes) p.stdin.write(JSON.stringify(Object.assign({ jsonrpc: '2.0' }, m)) + '\n');
  });
}

/**
 * opts: { projectPath, cliRoot (para NODE_PATH y el adaptador), adapter, driver,
 *         expectedVersion, timeoutMs }
 */
async function verificarFuncional(opts) {
  const { projectPath, adapter, driver } = opts;
  const timeoutMs = opts.timeoutMs || 60000;
  const dbReal = path.join(projectPath, '.agentic', 'memoria.db');
  const checks = [];
  const advertencias = [];
  if (!fs.existsSync(dbReal)) return { ok: true, checks: [SIN('el proyecto aún no tiene memoria.db: se creará al primer uso', 'base')], warnings: [] };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-verify-'));
  const env = { PROJECT_ROOT: tmp };
  if (opts.cliRoot) env.NODE_PATH = path.join(opts.cliRoot, 'node_modules');
  try {
    // ── copia aislada: motor actualizado + base migrada ───────────────────
    copiarMotor(path.join(projectPath, '.agentic', 'grafo'), path.join(tmp, '.agentic', 'grafo'));
    const origen = adapter.openReadOnly(dbReal, { drivers: [driver] });
    try { origen.backupTo(path.join(tmp, '.agentic', 'memoria.db')); } finally { origen.close(); }
    const dbCopia = path.join(tmp, '.agentic', 'memoria.db');

    // ── 1. búsqueda real ────────────────────────────────────────────────
    let consulta = 'memoria';
    let nodos = 0;
    {
      const lector = adapter.openReadOnly(dbCopia, { drivers: [driver] });
      try {
        nodos = Number(lector.get('SELECT count(*) AS n FROM nodos').n);
        const fila = lector.get("SELECT titulo FROM nodos WHERE estado = 'ACTIVO' ORDER BY id LIMIT 1") || lector.get('SELECT titulo FROM nodos ORDER BY id LIMIT 1');
        if (fila && fila.titulo) consulta = String(fila.titulo).split(/\s+/).filter((w) => w.length > 3)[0] || String(fila.titulo);
      } finally { lector.close(); }
    }
    const r1 = spawnSync(process.execPath, [path.join(tmp, '.agentic', 'grafo', 'kdd-memory.cjs'), 'recall', consulta, '--top=3'], { cwd: tmp, env: Object.assign({}, process.env, env), encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
    if (r1.status !== 0) checks.push({ name: 'busqueda_real', status: 'FAIL', detail: `kdd-memory recall salió con ${r1.status}: ${(r1.stderr || '').split('\n').filter((l) => !/ExperimentalWarning|trace-warnings/.test(l)).slice(0, 2).join(' ')}` });
    else if (nodos === 0) { checks.push({ name: 'busqueda_real', status: 'PASS', detail: 'la búsqueda corre; la memoria no tiene nodos con los que probar aciertos' }); advertencias.push('la memoria está vacía: la búsqueda se probó sin aciertos posibles'); }
    else {
      const salida = String(r1.stdout || '');
      const hallazgos = /Found:\s*(\d+)/.exec(salida);
      const n = hallazgos ? Number(hallazgos[1]) : null;
      checks.push({ name: 'busqueda_real', status: n === null || n > 0 ? 'PASS' : 'FAIL', detail: n === null ? 'recall terminó correctamente (formato de salida no reconocido)' : `recall "${consulta}" devolvió ${n} resultado(s) con ${nodos} nodo(s) en la memoria` });
    }

    // ── 2. compatibilidad MCP ───────────────────────────────────────────
    const r2 = await rpcMcp(path.join(tmp, '.agentic', 'grafo', 'mcp-server.cjs'), tmp, env, [
      { id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
      { method: 'notifications/initialized' },
      { id: 2, method: 'tools/list' },
      { id: 3, method: 'tools/call', params: { name: 'recall', arguments: { query: consulta } } },
    ], 3, timeoutMs);
    if (!r2.ok) checks.push({ name: 'mcp', status: 'FAIL', detail: r2.error || 'sin respuesta del servidor MCP' });
    else {
      const [a, b, c] = r2.respuestas;
      const version = a && a.result && a.result.serverInfo && a.result.serverInfo.version;
      const tools = b && b.result && b.result.tools ? b.result.tools.length : 0;
      const llamada = c && c.result && c.result.content && !c.error;
      const problemas = [];
      if (!version) problemas.push('initialize sin serverInfo');
      if (opts.expectedVersion && version && version !== opts.expectedVersion) problemas.push(`el servidor anuncia ${version} y se esperaba ${opts.expectedVersion}`);
      if (!tools) problemas.push('tools/list vacío');
      if (!llamada) problemas.push('tools/call recall falló: ' + JSON.stringify((c && c.error) || c).slice(0, 120));
      checks.push({ name: 'mcp', status: problemas.length ? 'FAIL' : 'PASS', detail: problemas.length ? problemas.join('; ') : `initialize ${version}, ${tools} herramientas, recall responde` });
    }

    // ── 3. escritura / lectura sin dejar rastro ─────────────────────────
    try {
      const w = adapter.openWrite(dbCopia, { drivers: [driver], updateOwner: true });
      try {
        const antes = Number(w.get('SELECT count(*) AS n FROM nodos').n);
        let leido = null;
        try {
          w.transaction(() => {
            w.run('INSERT INTO nodos (tipo, titulo, contenido, area, confianza) VALUES (?,?,?,?,?)', ['patron', '__verificacion_update__', 'prueba transaccional', 'update', 'BAJA']);
            leido = w.get("SELECT titulo FROM nodos WHERE titulo = '__verificacion_update__'");
            throw Object.assign(new Error('revertir'), { code: 'REVERTIR_PRUEBA' });
          })();
        } catch (e) { if (!e || e.code !== 'REVERTIR_PRUEBA') throw e; }
        const despues = Number(w.get('SELECT count(*) AS n FROM nodos').n);
        if (!leido) checks.push({ name: 'escritura_lectura', status: 'FAIL', detail: 'lo insertado no se pudo leer dentro de la transacción' });
        else if (antes !== despues) checks.push({ name: 'escritura_lectura', status: 'FAIL', detail: 'la transacción de prueba dejó filas' });
        else checks.push({ name: 'escritura_lectura', status: 'PASS', detail: 'INSERT + lectura dentro de una transacción revertida; la base de prueba queda igual' });
      } finally { w.close(); }
    } catch (e) { checks.push({ name: 'escritura_lectura', status: 'FAIL', detail: e.message }); }

    // ── 4. salud (informativa) ──────────────────────────────────────────
    const r4 = spawnSync(process.execPath, [path.join(tmp, '.agentic', 'grafo', 'health-check.cjs')], { cwd: tmp, env: Object.assign({}, process.env, env), encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
    const score = /Score:\s*(\d+)%/.exec(String(r4.stdout || ''));
    if (r4.error || (!score && r4.status !== 0)) checks.push({ name: 'salud', status: 'FAIL', detail: 'health-check no pudo ejecutarse con el motor nuevo: ' + ((r4.error && r4.error.message) || (r4.stderr || '').slice(0, 120)) });
    else checks.push({ name: 'salud', status: 'PASS', detail: score ? `health-check corre con el motor nuevo (puntaje ${score[1]}%, informativo)` : 'health-check corre con el motor nuevo' });
  } catch (e) {
    checks.push({ name: 'copia_aislada', status: 'FAIL', detail: e.message });
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temporal: no bloquea */ }
  }
  const falla = checks.some((c) => c.status === 'FAIL');
  return { ok: !falla, checks, warnings: advertencias };
}

module.exports = { verificarFuncional, rpcMcp };
