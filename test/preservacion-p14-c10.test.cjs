'use strict';

/* P14 memoria vigente · P15 alcance proporcional · P16/C09 enforcement por vía
   · C08 estados de capacidad · C10 runtime y Git. Todo en fixtures. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const G = path.join(__dirname, '..', '.agentic', 'grafo');
const vig = require(path.join(G, 'memoria-vigente.cjs'));
const mem = require(path.join(G, 'kdd-memory.cjs'));
const dba = require(path.join(G, 'db-adapter.cjs'));
const imp = require(path.join(G, 'alcance-impacto.cjs'));
const router = require(path.join(G, 'effort-router.cjs'));
const cache = require(path.join(G, 'evidence-cache.cjs'));
const hg = require(path.join(G, 'host-guard.cjs'));
const hh = require(path.join(G, 'host-hooks.cjs'));
const cap = require(path.join(G, 'capacidad-estado.cjs'));
const rt = require(path.join(G, 'runtime-check.cjs'));

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// ─── P14 ─────────────────────────────────────────────────────────────────────

function memoria(filas) {
  const root = tmp('akdd-p14-');
  fs.mkdirSync(path.join(root, '.agentic'));
  const db = dba.openWrite(path.join(root, '.agentic', 'memoria.db'));
  db.exec(`CREATE TABLE nodos (id INTEGER PRIMARY KEY, tipo TEXT, titulo TEXT, contenido TEXT, area TEXT, confianza TEXT,
    aplicado INTEGER DEFAULT 0, util INTEGER DEFAULT 0, estado TEXT, embedding TEXT, fecha_update TEXT, vigencia_tipo TEXT, archivos_aplica TEXT)`);
  for (const f of filas) {
    db.run('INSERT INTO nodos (tipo, titulo, contenido, area, confianza, estado, fecha_update, vigencia_tipo) VALUES (?,?,?,?,?,?,?,?)',
      [f.tipo, f.titulo, f.contenido, 'api', 'ALTA', f.estado || 'ACTIVO', new Date().toISOString(), f.vigencia || 'VIGENTE']);
  }
  db.close();
  return root;
}

test('P14: patrón de otro framework no se aplica sin validar; fuente e incertidumbre visibles', async () => {
  const root = memoria([{ tipo: 'patron', titulo: 'Middleware de validacion de pedidos', contenido: 'stack: express\nfuente: ciclo 12\nUsar middleware de validacion para pedidos.' }]);
  const r = await mem.recall('validacion de pedidos middleware', { contexto: { stack: 'fastify' } }, root);
  assert.strictEqual(r.results.length, 1);
  const a = r.results[0].aplicabilidad;
  assert.strictEqual(a.aplicable, 'VALIDAR');
  assert.ok(a.motivos.includes('OTRO_STACK'));
  assert.strictEqual(a.clase, 'RECOMENDACION');
  assert.strictEqual(a.fuente, 'ciclo 12');
  assert.strictEqual(a.sustituye_ejecucion, false);
  const mismo = await mem.recall('validacion de pedidos middleware', { contexto: { stack: 'Express' } }, root);
  assert.strictEqual(mismo.results[0].aplicabilidad.aplicable, 'SI', 'misma pila: aplica');
});

test('P14: contrato protegido antiguo sigue exigible; uno común obsoleto desaparece', async () => {
  const root = memoria([
    { tipo: 'contrato', titulo: 'Total del pedido redondea a centavos', contenido: 'contract_id: PED-001\nEl total redondea a dos decimales.', estado: 'ACTIVO', vigencia: 'OBSOLETO' },
    { tipo: 'patron', titulo: 'Total del pedido con reduce', contenido: 'Sumar el total con reduce.', vigencia: 'OBSOLETO' },
  ]);
  const r = await mem.recall('total del pedido', {}, root);
  assert.deepStrictEqual(r.results.map((x) => x.titulo), ['Total del pedido redondea a centavos']);
  assert.strictEqual(r.results[0].verificar, true);
  assert.strictEqual(r.results[0].aplicabilidad.exigible, true);
  assert.ok(r.results[0].aplicabilidad.motivos.includes('EDAD_NO_DESACTIVA_PROTEGIDO'));
  assert.strictEqual(vig.edadPuedeDesactivar({ tipo: 'contrato' }), false);
  assert.strictEqual(vig.edadPuedeDesactivar({ tipo: 'patron', contenido: 'criticidad: alta' }), false);
  assert.strictEqual(vig.edadPuedeDesactivar({ tipo: 'patron' }), true);
});

test('P14: sujeto nuevo invalida el PASS viejo; otro proyecto no se filtra', () => {
  const hecho = { tipo: 'error', contenido: 'subject_hash: aaa\nfuente: tdd-gate\nproject_id: tienda' };
  assert.strictEqual(vig.evaluar(hecho, { subject_hash: 'aaa' }).aplicable, 'SI');
  const nuevo = vig.evaluar(hecho, { subject_hash: 'bbb' });
  assert.strictEqual(nuevo.aplicable, 'VALIDAR');
  assert.ok(nuevo.motivos.includes('SUJETO_CAMBIO'));
  assert.strictEqual(vig.evaluar(hecho, { project_id: 'clinica' }).aplicable, 'NO');
  assert.strictEqual(vig.claseDe({ tipo: 'regla' }), 'REGLA_NEGOCIO');
  assert.strictEqual(vig.claseDe(hecho), 'HECHO_OBSERVADO');
});

test('P14: la caché de recall no mezcla proyectos', async () => {
  const a = memoria([{ tipo: 'patron', titulo: 'Cache de catalogo', contenido: 'Proyecto A: cache de catalogo por tienda.' }]);
  const b = memoria([{ tipo: 'patron', titulo: 'Cache de catalogo', contenido: 'Proyecto B: cache de catalogo por sucursal.' }]);
  const fa = path.join(a, '.agentic', 'memoria.db');
  const fb = path.join(b, '.agentic', 'memoria.db');
  const t = new Date('2026-01-01T00:00:00Z');
  fs.utimesSync(fa, t, t); fs.utimesSync(fb, t, t);
  const ra = await mem.recall('cache de catalogo', {}, a);
  const rb = await mem.recall('cache de catalogo', {}, b);
  assert.match(ra.results[0].resumen, /Proyecto A/);
  assert.match(rb.results[0].resumen, /Proyecto B/, 'misma huella de archivo, otro proyecto: no sale de la caché ajena');
});

// ─── P15 ─────────────────────────────────────────────────────────────────────

function front() {
  const root = tmp('akdd-p15-');
  const w = (f, t) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), t); };
  w('styles/tokens.css', ':root { --color-primario: #0a66c2; --radio: 4px; }\n');
  w('styles/botones.css', '.btn { background: var(--color-primario); }\n');
  w('pages/index.jsx', "import '../styles/botones.css';\nexport default () => 'Inicio';\n");
  w('pages/compras.jsx', "export default () => <div style={{ borderRadius: 'var(--radio)' }}>Compras</div>;\n");
  w('pages/acerca.jsx', "export default () => 'Acerca';\n");
  return root;
}

test('P15: texto local no abre auditoría global; token global amplía a sus consumidores', () => {
  const root = front();
  const local = imp.alcance(root, ['pages/acerca.jsx']);
  assert.strictEqual(local.nivel, 'LOCAL');
  assert.deepStrictEqual(local.rutas, ['/acerca']);
  assert.strictEqual(local.suite, 'DIRIGIDA');
  assert.strictEqual(local.auditoria_global, false);

  const antes = ':root { --color-primario: #000000; --radio: 4px; }\n';
  const token = imp.alcance(root, ['styles/tokens.css'], { antes: { 'styles/tokens.css': antes } });
  assert.strictEqual(token.nivel, 'AMPLIADO');
  assert.deepStrictEqual(token.tokens, ['--color-primario']);
  assert.deepStrictEqual(token.rutas, ['/'], 'solo la vista que consume el token cambiado (vía la hoja que lo usa)');
  assert.strictEqual(token.browser.smoke_critico, true);

  const desconocido = imp.alcance(root, ['components/Comun.jsx']);
  assert.strictEqual(desconocido.suite, 'COMPLETA', 'sin ruta conocida no se adivina: suite completa');
  assert.ok(desconocido.motivos.includes('INDICE_INSEGURO'));

  const d = router.decidir({ intent: 'cambia el texto de acerca', paths: ['pages/acerca.jsx'] }, { root });
  assert.strictEqual(d.verification_scope.nivel, 'LOCAL');
});

test('P15: LOW en auth no salta permisos; caché con cuerpo cambiado no evita la prueba', () => {
  const root = tmp('akdd-p15b-');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'auth.js'), 'module.exports = (u) => u.rol === "admin";\n');
  const d = router.decidir({ intent: 'cambia una línea en auth', paths: ['src/auth.js'], requested_tier: 'LOW' }, { root });
  assert.strictEqual(d.requested_tier_rejected, 'MIN_SEGURIDAD');
  assert.strictEqual(d.risk, 'HIGH');
  const q = { comando: 'node --test test/auth.test.js', alcance: ['src/auth.js'], tipo: 'dirigido' };
  cache.guardar(root, q, { status: 'PASS', pass: 3, fail: 0 });
  assert.strictEqual(cache.buscar(root, q).hit, true);
  fs.writeFileSync(path.join(root, 'src', 'auth.js'), 'module.exports = (u) => true;\n');
  const b = cache.buscar(root, q);
  assert.strictEqual(b.hit, false);
  assert.match(b.motivo, /SUJETO_CAMBIO/);
});

// ─── P16 / C09 ───────────────────────────────────────────────────────────────

test('P16: stdin vacío no ladrilla; sin ruta o MCP protegido sí se niega', () => {
  const root = tmp('akdd p16 ');
  fs.mkdirSync(path.join(root, '.agentic', '_teams'), { recursive: true });
  const dec = (host, ev, e) => { const o = hg.procesar(host, ev, e, root); return host === 'claude' ? o.hookSpecificOutput.permissionDecision : o.permission; };
  assert.strictEqual(dec('cursor', 'edit', null), 'allow', 'transporte roto no apaga Cursor');
  assert.strictEqual(dec('cursor', 'edit', { tool_input: {} }), 'deny', 'sin ruta no se sabe qué escribe');
  assert.strictEqual(dec('claude', 'shell', { tool_input: {} }), 'deny');
  assert.strictEqual(dec('cursor', 'edit', { tool_input: { path: path.join(root, 'src con espacio', 'a.js') } }), 'allow');
  assert.strictEqual(dec('cursor', 'mcp', { tool_input: { path: path.join(root, '.agentic', '_teams', 'origen-humano.jsonl') } }), 'deny');
  assert.strictEqual(dec('claude', 'mcp', { tool_input: { query: 'select 1' } }), 'allow');
  const ev = fs.readFileSync(path.join(root, '.agentic', '_hooks-eventos.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(ev.length >= 5 && ev.every((e) => e.origen === 'host'), 'cada ejecución deja huella');
});

test('C09: instalar usa ruta absoluta entre comillas, incluye MCP, y el smoke real decide el estado', () => {
  const root = tmp('akdd c09 con espacios ');
  fs.mkdirSync(path.join(root, '.agentic'));
  hh.instalar(root, 'cursor');
  hh.instalar(root, 'claude');
  const cur = JSON.parse(fs.readFileSync(path.join(root, '.cursor', 'hooks.json'), 'utf8'));
  const cl = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
  const ruta = path.resolve(root).replace(/\\/g, '/');
  assert.ok(cur.hooks.beforeMCPExecution[0].command.includes(`"${ruta}/.agentic/grafo/host-guard.cjs"`));
  assert.strictEqual(cur.hooks.beforeShellExecution[0].failClosed, false, 'Cursor no puede cerrar el IDE si la guardia no lee el payload');
  assert.ok(!JSON.stringify(cl).includes('$CLAUDE_PROJECT_DIR'), 'sin variables que dependan del shell');
  assert.ok(cl.hooks.PreToolUse.some((e) => e.matcher === 'mcp__.*'));

  const antes = hh.estado(root).find((s) => s.host === 'cursor');
  assert.strictEqual(antes.verificado, 'NO_VERIFICADO', 'instalado no es verificado');
  const s = hh.smoke(root, 'cursor');
  assert.strictEqual(s.ok, true, JSON.stringify(s.casos));
  assert.ok(s.casos.find((c) => c.id === 'payload-malformado').obtenida === 'allow');
  const despues = hh.estado(root).find((x) => x.host === 'cursor');
  assert.strictEqual(despues.verificado, 'VERIFICADO_FIXTURE');
  assert.strictEqual(despues.capacidad.estado, 'DEGRADED', 'Cursor no falla cerrado: no puede ladrillar el IDE');
  const sc = hh.smoke(root, 'claude');
  assert.strictEqual(sc.ok, true, JSON.stringify(sc.casos));
  assert.strictEqual(hh.estado(root).find((x) => x.host === 'claude').capacidad.estado, 'DEGRADED', 'Claude no falla cerrado si la guardia se cae');

  const cob = hh.cobertura(root);
  assert.strictEqual(cob.enforcement, 'DEGRADED');
  assert.ok(cob.huecos.includes('edición manual fuera del agente'));
  assert.ok(cob.huecos.includes('scripts lanzados por shell'));

  hh.desinstalar(root, 'cursor');
  assert.ok(!fs.existsSync(path.join(root, '.cursor', 'hooks.json')), 'desinstala solo lo propio');
});

// ─── C08 ─────────────────────────────────────────────────────────────────────

test('C08: mock no hace VERIFIED; cambio de cuerpo invalida; execution_id repetido no suma', () => {
  const base = { instalado: true, configurado: true, disponible: true };
  const actual = { hash_modulo: 'm1', hash_config: 'c1', host: 'cursor' };
  const fx = { scope: 'fixture', execution_id: 'e1', hash_modulo: 'm1', hash_config: 'c1', host: 'cursor' };
  assert.strictEqual(cap.evaluar({ ...base, verificaciones: [fx] }, actual).estado, 'AVAILABLE');
  const hostV = { ...fx, scope: 'host', execution_id: 'h1' };
  assert.strictEqual(cap.evaluar({ ...base, verificaciones: [fx, hostV] }, actual).estado, 'VERIFIED');
  const cambio = cap.evaluar({ ...base, verificaciones: [hostV] }, { ...actual, hash_modulo: 'm2' });
  assert.strictEqual(cambio.estado, 'AVAILABLE');
  assert.match(cambio.invalidadas[0].motivo, /MODULO_CAMBIO/);
  assert.strictEqual(cap.evaluar({ ...base, verificaciones: [hostV, hostV, hostV] }, actual).verificaciones_vigentes, 1);
  assert.strictEqual(cap.evaluar({ instalado: true }).estado, 'INSTALLED');
});

test('C08: TEAMS no acepta los gates que manda el constructor; verifica el director', () => {
  const tm = require(path.join(G, 'teams-manager.cjs'));
  const ad = require(path.join(G, 'teams-adapters.cjs'));
  const { createGateResult } = require(path.join(G, 'gate-result.cjs'));
  const root = tmp('akdd-c08-');
  fs.mkdirSync(path.join(root, '.agentic'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'a.js'), "module.exports = 1;\n");
  fs.writeFileSync(path.join(root, '.agentic', 'config.md'), 'CONFIGURADO: SI\n');
  dba.openWrite(path.join(root, '.agentic', 'memoria.db')).close();
  assert.strictEqual(tm.init(root, { aprobarMigracion: true }).status, 'ACTIVO');
  tm.crearPlan(root, { id: 'P', objective: 'x', sprints: [{ id: 'S', tasks: [{ id: 'A', objective: 'a', acceptance: ['ok'], allowed_files: ['src/a.js'], risk: 'LOW', change_type: 'text' }] }] });
  const falsos = (t0) => { const t = tm.leerTarea(root, t0.id); return tm.gatesRequeridos(t).map((gate) => createGateResult({ gate, status: 'PASS', subject_hash: 'h-A', execution_id: 'del-builder-' + gate, evidence: [{ kind: 'fixture', subject_hash: 'h-A' }] })); };
  const builder = new ad.AdapterPrueba({ producir: (a) => ({ files: a.task.allowed_files, subject_hash: 'h-A', evidence: falsos(a.task), gates: falsos(a.task) }) });
  let directorCalls = 0;
  const director = (res) => { directorCalls++; const t = tm.leerTarea(root, res.task_id); return tm.gatesRequeridos(t).map((gate) => createGateResult({ gate, status: 'FAIL', subject_hash: t.subject_hash, execution_id: 'dir-' + gate, evidence: [{ kind: 'ejecucion' }] })); };
  let v = null;
  for (let i = 0; i < 3 && !v; i++) v = ad.tick(root, { builder, verificador: director, puntos: false }).find((p) => p.paso === 'verificar');
  assert.ok(v, 'el director llegó a verificar');
  assert.ok(directorCalls > 0, 'el constructor no puede sustituir al comprobador del director');
  assert.notStrictEqual(v.status, 'DONE_VERIFIED', 'los PASS declarados por el constructor no cuentan');
  assert.notStrictEqual(tm.leerTarea(root, 'A').state, 'DONE_VERIFIED');
});

// ─── C10 ─────────────────────────────────────────────────────────────────────

test('C10: Node viejo y falta de driver se diagnostican por separado; engines sin CI es propuesta', () => {
  const root = tmp('akdd-c10-');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ engines: { node: '>=18.0.0' } }));
  fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), "strategy:\n  matrix:\n    node-version: ['20', '22', '24']\n");
  const sinGit = () => ({ error: new Error('ENOENT') });
  const viejo = rt.diagnostico(root, { version: 'v16.20.0', ejecutarGit: sinGit });
  assert.strictEqual(viejo.status, 'NO_SOPORTADO');
  assert.deepStrictEqual(viejo.problemas.map((p) => p.codigo), ['NODE_NO_SOPORTADO']);
  const sinDriver = rt.diagnostico(root, { version: 'v22.1.0', probar: () => { throw Object.assign(new Error('x'), { code: 'MODULE_NOT_FOUND' }); }, ejecutarGit: sinGit });
  assert.deepStrictEqual(sinDriver.problemas.map((p) => p.codigo), ['SIN_DRIVER_SQLITE']);
  const ok = rt.diagnostico(root, { version: 'v22.1.0', probar: (m) => { if (m !== 'sql.js') throw new Error('no'); }, ejecutarGit: sinGit });
  assert.strictEqual(ok.status, 'SOPORTADO_SIN_CI');
  assert.strictEqual(ok.driver, 'sql.js');
  assert.strictEqual(ok.propuesta.codigo, 'ENGINES_SIN_CI');
  assert.strictEqual(ok.propuesta.decide, 'la persona');
});

test('C10: dubious ownership da la ruta exacta y la opción acotada, nunca el comodín', () => {
  const stderr = "fatal: detected dubious ownership in repository at 'D:/Desarrollo/Mi Proyecto'\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory 'D:/Desarrollo/Mi Proyecto'\n";
  const g = rt.diagnosticoGit('.', () => ({ status: 128, stderr, stdout: '' }));
  assert.strictEqual(g.status, 'DUBIOUS_OWNERSHIP');
  assert.strictEqual(g.ruta, 'D:/Desarrollo/Mi Proyecto');
  assert.strictEqual(g.opcion_acotada, 'git config --global --add safe.directory "D:/Desarrollo/Mi Proyecto"');
  assert.ok(!g.opcion_acotada.includes('*'));
  assert.match(g.requiere, /autorización/);
  const plan = rt.planPiloto('.', null);
  assert.ok(plan.nunca.some((x) => /komerza/.test(x)));
});
