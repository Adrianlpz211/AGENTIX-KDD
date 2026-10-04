'use strict';
/**
 * Regresión del flujo INDIVIDUAL `aa:` (lo que Agentix ya hacía antes de 3.20.1 y de TEAMS).
 *
 * Un proyecto temporal con una copia REAL del motor y una memoria.db real recorre el ciclo que sigue un agente cuando
 * el dueño escribe `aa: <tarea>`: sellar arranque → enricher → construir → post-cycle → medir tiempo. Después se comprueba
 * por SQL / archivos que TODO lo que el pipeline siempre registró sigue registrándose (ciclo, contratos, módulo en config,
 * spec, AST, layout, memoria KDD, línea de tiempo, dashboard) y que lo nuevo (memoria con procedencia) se añade SIN quitar nada.
 *
 * Nivel B: el «constructor» (escribir archivos) lo hace la prueba; los scripts del pipeline son los reales y corren como hijos.
 * Para correr TEAMS en una campaña real ver MATRIZ-3.20.1.md (nivel C, NO_EJECUTADO aquí).
 */
const test = require('node:test');
const { SIN_DRIVER } = require('./helpers/db-real.cjs');
if (SIN_DRIVER) { test(require('node:path').basename(__filename) + ' (omitido: ' + SIN_DRIVER + ')', { skip: SIN_DRIVER }, () => {}); return; }
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const { proyecto, REPO } = require('./helpers/memoria-proyecto.cjs');
const GRAFO = path.join(REPO, '.agentic', 'grafo');

const ENTORNO = Object.assign({}, process.env, { AKDD_NO_MEMORY_CAPTURE: '1', AKDD_SKIP_GATES: '1', AKDD_NO_HOOKS: '1', GIT_TERMINAL_PROMPT: '0' });

function montar(nombre) {
  const p = proyecto('aa-' + nombre, { nodos: 2 });
  fs.cpSync(GRAFO, path.join(p.root, '.agentic', 'grafo'), {
    recursive: true,
    filter: (src) => !/[\\/](vendor|graph-ui)([\\/]|$)/.test(src) && !/post-cycle\.log$/.test(src),
  });
  fs.mkdirSync(path.join(p.root, '.agentic', 'memoria'), { recursive: true });
  fs.writeFileSync(path.join(p.root, '.agentic', 'config.md'), '# Config\nCONFIGURADO: SI\nNombre: proyecto-aa\n\n## Módulos\n### Implementados\n_Ninguno aún._\n\n### Pendientes\n_Ninguno aún._\n');
  fs.writeFileSync(path.join(p.root, '.agentic', 'memoria', 'trabajo.md'), '# Trabajo\n');
  for (const f of ['errores.md', 'patrones.md', 'decisiones.md']) fs.writeFileSync(path.join(p.root, '.agentic', 'memoria', f), '# ' + f + '\n');
  fs.mkdirSync(path.join(p.root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(p.root, 'public'), { recursive: true });
  fs.mkdirSync(path.join(p.root, 'test'), { recursive: true });
  fs.writeFileSync(path.join(p.root, 'package.json'), JSON.stringify({ name: 'proyecto-aa', version: '0.0.0', private: true, scripts: { test: 'node --test' } }));
  fs.writeFileSync(path.join(p.root, 'src', 'precio.js'), 'function total(base, iva) { return base + base * iva; }\nmodule.exports = { total };\n');
  fs.writeFileSync(path.join(p.root, 'public', 'estilo.css'), '#barra-lateral { width: 280px; padding: 8px; }\n');
  fs.writeFileSync(path.join(p.root, 'test', 'precio.test.js'), "const t = require('node:test'); const assert = require('node:assert');\nconst { total } = require('../src/precio.js');\nt('el total suma el IVA', () => assert.strictEqual(total(100, 0.19), 119));\n");
  const git = (...a) => cp.execFileSync('git', a, { cwd: p.root, encoding: 'utf8', env: ENTORNO });
  git('init', '-q'); git('config', 'user.email', 'prueba@local'); git('config', 'user.name', 'prueba'); git('config', 'commit.gpgsign', 'false');
  git('add', '-A'); git('commit', '-q', '-m', 'feat(precio): total con IVA', '--no-verify');
  return { p, git };
}

const nodo = (p, ...args) => cp.spawnSync(process.execPath, args, { cwd: p.root, encoding: 'utf8', env: ENTORNO, timeout: 540000 });
const sql = (p, q, ...a) => { const d = p.abrirR(); try { return d.all(q, ...a); } finally { d.close(); } };
const n = (p, TABLA, DONDE) => sql(p, ['SELECT count(*) AS n FROM', TABLA, DONDE ? ['WHERE', DONDE].join(' ') : ''].join(' '))[0].n;

test('aa: individual — el ciclo completo sigue registrando TODO lo de siempre, y la memoria con procedencia se SUMA', { timeout: 900000 }, () => {
  const { p, git } = montar('ciclo');
  try {
    const tarea = 'agregar total con IVA al módulo de precios';
    // 0 · arranque (CLAUDE.md paso 0) y 0.1 · enricher: nunca bloquean
    const ini = nodo(p, '.agentic/grafo/linea-tiempo.cjs', 'inicio', '--actor=prueba', tarea);
    assert.equal(ini.status, 0, ini.stderr);
    const enr = nodo(p, '.agentic/grafo/context-enricher.cjs', tarea);
    assert.equal(enr.status, 0, enr.stderr);
    assert.ok((enr.stdout + enr.stderr).length > 0, 'el enricher imprime su brief');

    // construir (lo hace el agente): un cambio real + commit
    fs.writeFileSync(path.join(p.root, 'src', 'precio.js'), 'function total(base, iva) { return Math.round(base + base * iva); }\nfunction descuento(base, pct) { return base - base * pct; }\nmodule.exports = { total, descuento };\n');
    fs.writeFileSync(path.join(p.root, 'test', 'precio.test.js'), "const t = require('node:test'); const assert = require('node:assert');\nconst { total, descuento } = require('../src/precio.js');\nt('el total suma el IVA', () => assert.strictEqual(total(100, 0.19), 119));\nt('el descuento resta el porcentaje', () => assert.strictEqual(descuento(100, 0.1), 90));\n");
    fs.writeFileSync(path.join(p.root, 'public', 'estilo.css'), '#barra-lateral { width: 300px; padding: 8px; }\n');
    git('add', '-A'); git('commit', '-q', '-m', 'feat(precio): descuento y redondeo', '--no-verify');

    const antes = { ciclos: n(p, 'ciclos'), obs: n(p, 'mem_observations'), ev: n(p, 'mem_events') };

    // post-cycle REAL (el mismo cierre que usa `aa:`)
    const pc = nodo(p, '.agentic/grafo/post-cycle.cjs', 'precio', '--tests=2', '--task=' + tarea);
    assert.equal(pc.status, 0, (pc.stdout + pc.stderr).slice(-800));

    // — lo de SIEMPRE —
    assert.equal(n(p, 'ciclos'), antes.ciclos + 1, 'un ciclo registrado en BD');
    const c = sql(p, 'SELECT ciclo_id, area, estado, tests_pasando, tarea FROM ciclos ORDER BY rowid DESC LIMIT 1')[0];
    assert.equal(c.tests_pasando, 2);
    assert.match(c.tarea, /precios/);
    assert.ok(c.estado && c.estado !== 'EN_CURSO', 'ciclo cerrado: ' + c.estado);
    assert.ok(n(p, 'verified_contracts') >= 1, 'contratos acumulados por el TDD gate real');
    assert.ok(n(p, 'ast_symbols', "file LIKE '%precio.js'") >= 2, 'code structure (AST) de total y descuento');
    assert.ok(n(p, 'ui_layout_decisions', "element_id LIKE '%barra-lateral%'") >= 1, 'UI layout memory');
    assert.ok(fs.readFileSync(path.join(p.root, '.agentic', 'config.md'), 'utf8').includes('precio'), 'módulo documentado en config.md');
    assert.equal(n(p, 'module_registry', "name = 'precio'"), 1, 'módulo en module_registry');
    assert.ok(n(p, 'module_registry', "name = 'precio'") === 1, 'módulo en module_registry');
    assert.ok(fs.existsSync(path.join(p.root, '.agentic', 'specs')) && fs.readdirSync(path.join(p.root, '.agentic', 'specs')).some((f) => /precio/i.test(f)), 'spec del módulo generada');
    assert.ok(n(p, 'episodios') >= 1, 'episodio del ciclo');

    // — lo NUEVO se suma sin quitar lo anterior —
    assert.ok(n(p, 'mem_observations') >= antes.obs, 'la memoria con procedencia no pierde nada');
    assert.ok(n(p, 'mem_events') > antes.ev, 'el cierre del ciclo aa: quedó como actividad con procedencia');
    assert.equal(n(p, 'mem_events', "host = 'teams'"), 0, 'un ciclo individual NO se etiqueta como teams');
    assert.equal(n(p, 'mem_jobs', "state = 'DEAD_LETTER'"), 0, 'ningún job de memoria quedó en dead-letter');

    // — cierre de tiempo (CLAUDE.md paso 7) —
    const fin = nodo(p, '.agentic/grafo/linea-tiempo.cjs', 'fin', '--actor=prueba');
    assert.equal(fin.status, 0, fin.stderr);
    assert.match(fin.stdout, /\d/, 'reporta una duración');

    // — repetir post-cycle sobre el mismo commit no rompe ni corrompe la base —
    const pc2 = nodo(p, '.agentic/grafo/post-cycle.cjs', 'precio', '--tests=2', '--task=' + tarea + ' (repetido)');
    assert.equal(pc2.status, 0, (pc2.stdout + pc2.stderr).slice(-500));
    assert.equal(sql(p, 'PRAGMA integrity_check')[0].integrity_check, 'ok');
  } finally { p.limpiar(); }
});

test('aa: individual — memoria y consulta de siempre: grafo, regresión, bloqueos y salud siguen respondiendo', { timeout: 600000 }, () => {
  const { p } = montar('consulta');
  try {
    const sync = nodo(p, '.agentic/grafo/grafo.cjs', 'sync');
    assert.equal(sync.status, 0, (sync.stdout + sync.stderr).slice(-500));
    const busca = nodo(p, '.agentic/grafo/grafo.cjs', 'buscar', 'Memoria original');
    assert.equal(busca.status, 0, busca.stderr);
    // spec-gate / regression-guard / locks: los controles previos siguen vivos
    for (const [script, ...args] of [['regression-guard.cjs', 'status'], ['lock-manager.cjs', 'status'], ['hierro-papel.cjs'], ['ui-layout-memory.cjs', 'list']]) {
      const r = nodo(p, '.agentic/grafo/' + script, ...args);
      assert.ok(r.status === 0 || r.status === null || r.status === 1, script + ' falló al ejecutarse: ' + (r.stderr || r.stdout).slice(0, 300));
      assert.ok(!/Cannot find module|SyntaxError|TypeError/.test(r.stderr), script + ': ' + r.stderr.slice(0, 300));
    }
    assert.equal(sql(p, 'PRAGMA integrity_check')[0].integrity_check, 'ok');
    // tablas históricas intactas: ninguna de las que existían desapareció tras sumar la memoria con procedencia
    const tablas = sql(p, "SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => t.name);
    for (const t of ['nodos', 'ciclos', 'episodios', 'verified_contracts', 'ast_symbols', 'ui_layout_decisions', 'gate_events', 'prediction_log']) assert.ok(tablas.includes(t), 'falta la tabla histórica ' + t);
    for (const t of ['mem_events', 'mem_observations', 'mem_jobs']) assert.ok(tablas.includes(t), 'falta la tabla nueva ' + t);
  } finally { p.limpiar(); }
});

test('aa: individual — el dashboard sigue sirviendo el tablero de grafos y sus datos, y ahora trae las páginas nuevas como pestañas', () => {
  const src = fs.readFileSync(path.join(REPO, 'dashboard.cjs'), 'utf8');
  for (const tab of ["setMode('graph'", "setMode('docs'", "setMode('intel'", "setMode('tiempos'"]) assert.ok(src.includes(tab), 'pestaña histórica ausente: ' + tab);
  for (const m of ['memoria', 'contexto', 'actualizacion']) assert.ok(src.includes("setMode('" + m + "',this)"), 'el tablero no tiene la pestaña ' + m);
  // los grafos NO cambian: la API histórica sigue presente
  const api = require(path.join(GRAFO, 'dashboard-api.cjs'));
  assert.equal(typeof api, 'object');
});
