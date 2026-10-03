'use strict';
/**
 * Consumidores REALES construidos con los motores PUBLICADOS en npm.
 *
 * El documento de la 3.20.1 exige probar con bases reales de 3.19.0 y 3.20.0,
 * no con esquemas escritos a mano. Aquí se descarga el paquete publicado (caché
 * en el temporal del sistema), se arma un proyecto con memoria Markdown y se
 * ejecutan los scripts del propio motor para que él cree su base: las tablas
 * perezosas aparecen porque el motor real las crea, no porque alguien las copió.
 *
 * Requiere red solo la primera vez (npm pack); después usa la caché.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { herramienta } = require('../../src/run-safe');
const { extractTarGz } = require('../../src/tar-extract');

const REPO = path.resolve(__dirname, '..', '..');
const dba = require(path.join(REPO, '.agentic', 'grafo', 'db-adapter.cjs'));
const CACHE = path.join(os.tmpdir(), 'agentix-legacy-cache-v2');
const TGZ = path.join(os.tmpdir(), 'agentix-release-cache');

function paquete(version) {
  const dir = path.join(CACHE, 'pkg-' + version);
  if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
  fs.mkdirSync(TGZ, { recursive: true });
  const tgz = path.join(TGZ, `agentic-kdd-${version}.tgz`);
  if (!fs.existsSync(tgz)) herramienta('npm', ['pack', `agentic-kdd@${version}`, '--ignore-scripts', '--silent', '--pack-destination', TGZ], { cwd: TGZ, timeout: 180000 });
  fs.mkdirSync(dir, { recursive: true });
  extractTarGz(tgz, dir);
  return dir;
}

function construir(version) {
  const proj = path.join(CACHE, 'proj-' + version);
  if (fs.existsSync(path.join(proj, '.agentic', 'memoria.db'))) return proj;
  const pkg = paquete(version);
  fs.rmSync(proj, { recursive: true, force: true });
  fs.mkdirSync(path.join(proj, '.agentic', 'memoria'), { recursive: true });
  fs.cpSync(path.join(pkg, '.agentic'), path.join(proj, '.agentic'), { recursive: true });
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'src', 'auth.js'), "const jwt = require('jwt');\nexports.login = (u) => jwt.sign({u});\n");
  fs.writeFileSync(path.join(proj, 'src', 'auth.test.js'), "const test=require('node:test');test('login',()=>{});\n");
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'consumidor', version: '1.0.0', scripts: { test: 'node --test' } }));
  fs.writeFileSync(path.join(proj, '.agentic', 'config.md'), `VERSION: ${version}\nCONFIGURADO: SI\nNombre: Consumidor privado\n## Comandos\ntest: node --test\n`);
  fs.writeFileSync(path.join(proj, '.agentic', 'memoria', 'patrones.md'), '# Patrones\n\n## [2026-07-01] [auth] — Tokens con expiración corta\nEstado: ACTIVO\nConfianza: ALTA\nAplicado: 3\nÚtil: 3\nContexto: src/auth.js\nRegla: expiresIn <= 15m\n');
  fs.writeFileSync(path.join(proj, '.agentic', 'memoria', 'errores.md'), '# Errores\n\n## [2026-07-02] [auth] — Login sin await\nEstado: RESUELTO\nConfianza: MEDIA\nAplicado: 1\nÚtil: 1\nContexto: src/auth.js\nSíntoma: promesa sin resolver\nCausa: faltó await\nSolución: await jwt.sign\nEvitar: olvidar await\nAplicar cuando: se toque auth\n');
  fs.writeFileSync(path.join(proj, '.agentic', 'memoria', 'decisiones.md'), '# Decisiones\n\n## [2026-07-03] [auth] — trial_days = 14\nEstado: ACTIVO\nConfianza: ALTA\nAplicado: 0\nÚtil: 0\nContexto: facturación\nDecisión: trial_days = 14\n');
  const env = { ...process.env, PROJECT_ROOT: proj, NODE_NO_WARNINGS: '1' };
  const run = (script, args = []) => spawnSync(process.execPath, [path.join(proj, '.agentic', 'grafo', script), ...args], { cwd: proj, env, encoding: 'utf8', timeout: 120000 });
  // Las tablas perezosas las crea el propio motor publicado al usarlas.
  for (const [s, a] of [['grafo.cjs', ['sync']], ['ast-indexer.cjs', []], ['schema-columns.cjs', ['fix']], ['gate-telemetry.cjs', ['stats']], ['regression-guard.cjs', ['status']],
    ['contract-guard.cjs', ['status']], ['creative-engine.cjs', ['level']], ['knowledge-validator.cjs', ['scan']], ['memory-audit.cjs', []], ['reasoning-bank.cjs', ['status']],
    ['prediccion-registro.cjs', ['precision']], ['ui-layout-memory.cjs', ['list']], ['mem-curator.cjs', ['report']], ['lock-manager.cjs', ['status']], ['metrics.cjs', []],
    ['post-cycle.cjs', ['auth', '--tests=1', '--task=prueba']]]) run(s, a);
  if (!fs.existsSync(path.join(proj, '.agentic', 'memoria.db'))) throw new Error('el motor ' + version + ' no creó memoria.db');
  // Se deja la base en un único archivo (sin -wal), consistente.
  const o = dba.openReadOnly(path.join(proj, '.agentic', 'memoria.db'));
  const compacta = path.join(proj, '.agentic', 'memoria.compacta.db');
  fs.rmSync(compacta, { force: true });
  o.backupTo(compacta);
  o.close();
  for (const suf of ['', '-wal', '-shm']) fs.rmSync(path.join(proj, '.agentic', 'memoria.db' + suf), { force: true });
  fs.renameSync(compacta, path.join(proj, '.agentic', 'memoria.db'));
  return proj;
}

/** Copia independiente (con su base) de un consumidor real. `version` = '3.19.0' | '3.20.0'. */
function proyectoReal(version, sufijo) {
  const base = construir(version);
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-real-' + version + '-' + (sufijo || '')));
  fs.cpSync(base, dest, { recursive: true });
  return { root: dest, dbPath: path.join(dest, '.agentic', 'memoria.db'), version };
}

/** Árbol de archivos propios + framework como mapa ruta → sha256 (para "no cambió nada"). */
function huellaArbol(root, { sinBase = false } = {}) {
  const crypto = require('crypto');
  const out = {};
  const omitir = new Set(['node_modules', '.git']);
  const caminar = (rel) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { if (!omitir.has(e.name)) caminar(r); continue; }
      if (!e.isFile()) continue;
      if (sinBase && /memoria\.db(-wal|-shm)?$/.test(e.name)) continue;
      out[r] = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, r))).digest('hex');
    }
  };
  caminar('');
  return out;
}

module.exports = { proyectoReal, construir, paquete, huellaArbol, REPO, CACHE };
