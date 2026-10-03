'use strict';

/**
 * Soporte de las pruebas de TEAMS v2. Los constructores y los recibos de gate son SIMULADOS (AdapterPrueba y fixtureGate):
 * sirven para probar mecanismo (A) y campañas fixture (B). No certifican un host real ni una campaña Claude Code + Cursor (C).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const G = path.join(__dirname, '..', '..', '.agentic', 'grafo');
const tm = require(path.join(G, 'teams-manager.cjs'));
const ad = require(path.join(G, 'teams-adapters.cjs'));
const corr = require(path.join(G, 'teams-correcciones.cjs'));
const rev = require(path.join(G, 'teams-revision.cjs'));
const cierre = require(path.join(G, 'teams-cierre.cjs'));
const bld = require(path.join(G, 'teams-builder.cjs'));
const { fixtureGate } = require('./gates.cjs');

const ARCHIVOS = {
  'src/a.js': 'module.exports = { v: 0 };\n',
  'src/b.js': 'module.exports = { v: 0 };\n',
  'src/c.js': 'module.exports = { v: 0 };\n',
  'src/d.js': 'module.exports = { v: 0 };\n',
  'test/x.test.js': "const t = require('node:test'); const a = require('node:assert'); t('ok', () => a.equal(1, 1));\n",
};

/** Proyecto fixture con una suite real mínima (el verificador real corre `npm test`). */
function proyecto({ git = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-teams-v2-'));
  fs.mkdirSync(path.join(root, '.agentic'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agentic', 'config.md'), 'CONFIGURADO: SI\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node --test' } }));
  for (const [f, c] of Object.entries(ARCHIVOS)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), c);
  }
  require(path.join(G, 'db-adapter.cjs')).openWrite(path.join(root, '.agentic', 'memoria.db')).close();
  if (git) {
    const g = (...a) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: root, encoding: 'utf8' });
    g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'base');
  }
  return root;
}

function activar(root, o = {}) {
  const r = tm.init(root, { aprobarMigracion: true, ...o });
  if (r.status !== 'ACTIVO') throw new Error('init: ' + JSON.stringify(r));
  return r;
}

const tarea = (id, extra) => Object.assign({ id, objective: 'tarea ' + id, acceptance: ['criterio de ' + id], allowed_files: ['src/' + id.toLowerCase() + '.js'], risk: 'LOW' }, extra);

/** Plan canónico del ejemplo obligatorio: Sprint1 Fase1 → Fase2 → Sprint2 Fase1 (cadena de dependencias). */
function planSecuencial() {
  return {
    id: 'P-SEC', objective: 'campaña de prueba', referencias: [{ url: 'https://example.com/spec', nota: 'spec del dueño' }],
    sprints: [
      { id: 'S1', objective: 'sprint uno', phases: [
        { id: 'F1', tasks: [tarea('A', { criterios_de_revision: ['el valor no es negativo'] })] },
        { id: 'F2', tasks: [tarea('B', { depends_on: ['A'] })] },
      ] },
      { id: 'S2', objective: 'sprint dos', tasks: [tarea('C', { depends_on: ['B'], phase: 'F1' })] },
    ],
  };
}

/** Constructor simulado: escribe su archivo, entrega con comprobaciones básicas (o sin ellas) y deja la tarea en VERIFYING. */
function constructor(root, { owner_id = 'cursor-1', comprobaciones = ['tests=PASS'], escribir = true } = {}) {
  return new ad.AdapterPrueba({
    owner_id,
    producir: (a) => {
      const f = a.task.allowed_files[0];
      if (escribir && f) fs.writeFileSync(path.join(root, f), 'module.exports = { v: "' + a.task.id + '" };\n');
      return { files: a.task.allowed_files, subject_hash: 'h-' + a.task.id + '-' + Date.now().toString(36), evidence: comprobaciones };
    },
  });
}

const paso = (root, builder, verificador) => ad.tick(root, { builder, puntos: false, verificador });

/** Gates PASS con recibo (fixtureGate: SIMULADO) para todos los gates requeridos por la tarea, sobre el sujeto vigente. */
function gatesPass(root, id) {
  const t = tm.leerTarea(root, id);
  return tm.gatesRequeridos(t).map((gate) => fixtureGate(root, {
    gate, status: 'PASS', subject_hash: t.subject_hash, execution_id: 'x-' + gate,
    evidence: [{ kind: 'fixture', subject_hash: t.subject_hash }],
  }, t.allowed_files));
}

let nVer = 0;
const verificarTarea = (root, id) => tm.verificar(root, { task_id: id, event_id: 'ver-' + id + '-' + (nVer++), gates: gatesPass(root, id) });

/** Lleva una tarea READY a VERIFYING con el constructor simulado (un pase del scheduler). */
function entregarConstructor(root, builder = constructor(root)) {
  const log = paso(root, builder);
  return { log, builder };
}

/** Registra a los tres revisores como subagentes con identidad propia. */
function revisores(root) {
  return ['frontend', 'backend', 'negocio'].map((role) => rev.registrar(root, { role, agent_id: 'ag-' + role, modality: 'SUBAGENTE', scope: [role] }));
}

/** Los tres revisores dan PASS sobre el sujeto FINAL vigente. */
function revisionFinalPass(root) {
  const f = rev.sujetoFinalDe(root);
  return ['frontend', 'backend', 'negocio'].map((role) => rev.informar(root, { role, scope_kind: 'FINAL', subject_hash: f.hash, verdict: 'PASS' }));
}

/** El director declara "sin efecto" (con razón) las revalidaciones pendientes de tareas ya verificadas. */
function revalidarTodo(root, razon = 'la corrección no cambia el comportamiento de esta tarea (revisado)') {
  const hechas = [];
  for (const t of tm.estado(root).tareas.filter((x) => x.revalidar && x.revalidar.length && x.state === 'DONE_VERIFIED')) {
    const r = tm.revalidar(root, { task_id: t.id, sin_efecto: razon });
    if (r.status !== 'REVALIDADA') throw new Error(t.id + ' ' + JSON.stringify(r));
    hechas.push(t.id);
  }
  return hechas;
}

/** Corre un script en un proceso NUEVO sobre el proyecto (reinicio real: nada vive en memoria). */
function enProcesoNuevo(root, codigo) {
  const r = spawnSync(process.execPath, ['-e', codigo], { cwd: root, encoding: 'utf8', env: Object.assign({}, process.env, { NODE_TEST_CONTEXT: '' }) });
  if (r.status !== 0) throw new Error('proceso nuevo falló: ' + r.stderr);
  return JSON.parse(r.stdout);
}

/** Lleva A, B y C a DONE_VERIFIED con el constructor simulado y recibos de gate simulados. */
function campanaVerificada(root) {
  activar(root);
  const p = tm.crearPlan(root, planSecuencial());
  if (p.status !== 'PLAN_GUARDADO') throw new Error(JSON.stringify(p));
  const b = constructor(root);
  for (let i = 0; i < 3; i++) paso(root, b);
  for (const id of ['A', 'B', 'C']) {
    const v = verificarTarea(root, id);
    if (v.status !== 'DONE_VERIFIED') throw new Error(id + ' ' + JSON.stringify(v));
  }
  return b;
}

module.exports = { G, tm, ad, corr, rev, cierre, bld, proyecto, activar, tarea, planSecuencial, constructor, paso, gatesPass, verificarTarea, entregarConstructor, revisores, revisionFinalPass, enProcesoNuevo, campanaVerificada, revalidarTodo, fixtureGate };
