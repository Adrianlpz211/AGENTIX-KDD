'use strict';

const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');
const ora = require('ora');
const os = require('os');
const { nodo, herramienta } = require('./run-safe');
const txm = require('./update-tx');

const GITHUB_REPO = 'Adrianlpz211/AGENTIX-KDD';
const REPO_URL = `https://github.com/${GITHUB_REPO}`;

/**
 * Actualiza el framework del proyecto como una transacción (src/update-tx.js).
 *
 *   ref        rama, tag o SHA; se resuelve a un commit concreto y se descarga
 *              ESE commit (por defecto 'main', pero lo aplicado queda fijado)
 *   archivo    .tar.gz local en vez de descargar (sin red, o una release propia)
 *   sha256     si se da, el archivo debe coincidir o no se toca nada
 *   migrate    migrar el esquema de memoria.db (nunca automático)
 *   deps       reconstruir/instalar dependencias nativas (nunca automático)
 *   salir      false = devolver el resultado en vez de process.exit (pruebas)
 */
async function update(opts = {}) {
  const projectPath = opts.projectPath || process.cwd();
  const salir = opts.salir !== false;
  const fin = (code, r) => { if (salir && code) process.exit(code); return r; };

  console.log('\n' + chalk.bold.blue('  Agentic KDD') + chalk.gray(' — updating...\n'));

  if (!fs.existsSync(path.join(projectPath, '.agentic', 'config.md'))) {
    console.log(chalk.yellow('  Agentic KDD is not installed in this project.'));
    console.log(chalk.gray('  Run akdd init to install it.\n'));
    return fin(1, { ok: false, reason: 'NOT_INSTALLED' });
  }

  const recuperados = txm.recuperarPendientes(projectPath);
  for (const r of recuperados) {
    console.log(chalk.yellow(`  ↺ Un update anterior quedó a medias (${r.id}): revertidos ${r.revertidos} archivo(s).`));
  }

  const configPath = path.join(projectPath, '.agentic', 'config.md');
  const userState  = preserveUserState(projectPath, configPath);
  const spinner = ora({ text: 'Preparing update...', color: 'blue' }).start();

  let staging = null;
  let descarga = null;
  let journal = null;
  try {
    // ── 1. Origen fijado e íntegro ─────────────────────────────────────────
    let archivo = opts.archivo;
    let commit = null;
    if (!archivo && !opts.ref) {
      const bundled = txm.prepararBundle(opts.bundleRoot || path.join(__dirname, '..'));
      staging = bundled.staging;
      archivo = null;
    }
    if (!staging && !archivo) {
      const ref = opts.ref || 'main';
      spinner.text = `Resolving ${ref}...`;
      commit = txm.resolverRef(REPO_URL, ref);
      descarga = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-download-'));
      archivo = path.join(descarga, `${commit}.tar.gz`);
      spinner.text = `Downloading ${commit.slice(0, 12)}...`;
      herramienta('curl', ['-sfL', `${REPO_URL}/archive/${commit}.tar.gz`, '-o', archivo]);
    }
    const digest = staging ? txm.sha256(JSON.stringify(require('./managed-manifest').archivos(staging).map(rel => [rel, txm.hashArchivo(path.join(staging, rel))]))) : txm.hashArchivo(archivo);
    if (opts.sha256 && opts.sha256.toLowerCase() !== digest) {
      throw codigo('INTEGRIDAD', `sha256 del archivo ${digest} ≠ esperado ${opts.sha256}`);
    }

    // ── 2. Staging confinado y validado ANTES de tocar el proyecto ─────────
    spinner.text = 'Checking the downloaded framework...';
    if (!staging) staging = txm.prepararStaging(archivo);
    const valido = txm.validarStaging(staging);
    if (!valido.ok) throw codigo('STAGING_INVALIDO', 'la versión descargada no es válida:\n    ' + valido.problemas.slice(0, 10).join('\n    '));

    const proteccion = guardiaProtegidos(projectPath, staging);
    if (!proteccion.ok) throw codigo('PROTEGIDOS', proteccion.message);
    const filtro = (rel) => proteccion.filtro(null, path.join(projectPath, rel));

    // ── 3. Aplicar dentro del journal ──────────────────────────────────────
    spinner.text = 'Updating system files (keeping your memory intact)...';
    const userInstrPath = path.join(projectPath, '.agentic', 'INSTRUCCIONES-PROYECTO.md');
    journal = txm.abrirJournal(projectPath, { ref: opts.ref || null, origin: opts.archivo ? 'archive' : opts.ref ? 'github' : 'installed-package', commit, sha256: digest, version: valido.version });
    txm.respaldar(journal, projectPath, barra(path.relative(projectPath, configPath)), 'config');
    txm.respaldar(journal, projectPath, '.agentic/INSTRUCCIONES-PROYECTO.md', 'instrucciones');
    migrarInstruccionesUsuario(projectPath, userInstrPath);

    const res = txm.aplicar(projectPath, staging, journal, { filtro, fallarTras: opts.fallarTras });

    // CLAUDE.md llega como plantilla; lo del usuario vive en
    // .agentic/INSTRUCCIONES-PROYECTO.md (que Agentix solo lee) y se vuelve a
    // pegar debajo del marcador.
    if (fs.existsSync(userInstrPath) && res.escritos.includes('CLAUDE.md')) {
      const propio = fs.readFileSync(userInstrPath, 'utf8').trim();
      if (propio) fs.appendFileSync(path.join(projectPath, 'CLAUDE.md'), '\n' + propio + '\n');
    }
    restoreUserState(configPath, userState);

    txm.respaldar(journal, projectPath, '.agentic/_update/owned.json', 'registro');
    txm.registrarOwned(projectPath, res.hashes, { version: valido.version, commit, sha256: digest }, ['CLAUDE.md']);
    txm.cerrarJournal(journal, { resumen: {
      escritos: res.escritos.length, sinCambios: res.sinCambios.length,
      personalizados: res.personalizados, protegidos: res.protegidos,
      obsoletosBorrados: res.obsoletosBorrados, obsoletosConservados: res.obsoletosConservados,
    } });
    txm.podar(projectPath);

    // ── 4. Fuera de la transacción: hooks (no pisa hooks ajenos) ───────────
    const grafoDest = path.join(projectPath, '.agentic', 'grafo');
    try { nodo(path.join(grafoDest, 'install-hooks.cjs'), ['--quiet'], { cwd: projectPath, timeout: 15000 }); }
    catch { /* hooks: el estado se ve con akdd health */ }

    const pasos = [];
    if (opts.migrate) {
      spinner.text = 'Migrating knowledge graph schema...';
      try { nodo(path.join(grafoDest, 'grafo.cjs'), ['migrate'], { cwd: projectPath, timeout: 60000 }); pasos.push('esquema migrado'); }
      catch (e) { pasos.push('migración FALLÓ: ' + e.message); }
    }
    if (opts.deps) {
      spinner.text = 'Rebuilding native dependencies...';
      try { herramienta('npm', ['rebuild', 'better-sqlite3'], { cwd: projectPath }); pasos.push('better-sqlite3 reconstruido'); }
      catch (e) { pasos.push('npm rebuild FALLÓ: ' + e.message); }
    }

    spinner.succeed(chalk.green(`Updated to ${valido.version || 'unknown'}${commit ? ' @ ' + commit.slice(0, 12) : ''}`));
    console.log(chalk.gray(`  ${res.escritos.length} archivo(s) actualizados, ${res.sinCambios.length} sin cambios · sha256 ${digest.slice(0, 16)}…`));
    if (res.protegidos.length) console.log(chalk.yellow(`  🔒 No se actualizaron (están en .agentic/protected_files): ${res.protegidos.join(', ')}`));
    if (res.personalizados.length) {
      console.log(chalk.yellow(`  ✋ Personalizados, se dejaron como estaban (${res.personalizados.length}): ${res.personalizados.join(', ')}`));
      console.log(chalk.gray(`     La versión nueva de cada uno quedó en ${barra(path.relative(projectPath, path.join(journal.dir, 'personalizados')))}/`));
    }
    if (res.obsoletosBorrados.length) console.log(chalk.gray(`  − Retirados (ya no son del framework): ${res.obsoletosBorrados.join(', ')}`));
    if (res.obsoletosConservados.length) console.log(chalk.yellow(`  ! Ya no son del framework pero tienen cambios tuyos, se conservan: ${res.obsoletosConservados.join(', ')}`));
    for (const p of pasos) console.log(chalk.gray('  · ' + p));
    if (!opts.migrate) console.log(chalk.gray('  · Esquema de memoria.db sin migrar — cuando quieras: akdd update --migrate (o node .agentic/grafo/grafo.cjs migrate)'));
    console.log(chalk.gray('  · Tu memoria, config.md, conocimiento, PLAN.md y memoria.db no se tocaron.'));
    console.log(chalk.gray(`  · Para volver atrás: akdd update --rollback\n`));

    const failedSteps = pasos.filter(p => p.includes('FALLÓ'));
    return fin(failedSteps.length ? 1 : 0, { ok: !failedSteps.length, reason: failedSteps.length ? 'POST_UPDATE_FAILED' : undefined, failedSteps, version: valido.version, commit, sha256: digest, journal: journal.archivo, ...res });
  } catch (err) {
    let revertidos = 0;
    if (journal) {
      try { revertidos = txm.revertir(projectPath, journal.archivo).revertidos; } catch { /* se reintenta en la próxima corrida */ }
    }
    spinner.fail(chalk.red('Update failed' + (journal ? ` — revertido (${revertidos} archivo(s))` : ' — no se tocó nada')));
    console.error(chalk.red('\n  Error: ' + err.message + '\n'));
    return fin(1, { ok: false, reason: err.code || 'ERROR', message: err.message, revertidos });
  } finally {
    if (staging) fs.rmSync(staging, { recursive: true, force: true });
    if (descarga) fs.rmSync(descarga, { recursive: true, force: true });
  }
}

/** Revierte la última transacción aplicada (sus backups siguen en disco). */
function rollback(opts = {}) {
  const projectPath = opts.projectPath || process.cwd();
  const base = path.join(txm.dirUpdate(projectPath), 'tx');
  let ids = [];
  try { ids = fs.readdirSync(base).sort(); } catch { /* sin transacciones */ }
  for (const id of ids.reverse()) {
    const f = path.join(base, id, 'journal.json');
    let d = null;
    try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    if (d.estado !== 'aplicado') continue;
    const r = txm.revertir(projectPath, f);
    console.log(chalk.green(`  ↺ Revertida la actualización ${id}: ${r.revertidos} archivo(s) restaurados.`));
    return { ok: true, id, ...r };
  }
  console.log(chalk.yellow('  No hay ninguna actualización aplicada que revertir.'));
  return { ok: false, reason: 'SIN_TRANSACCION' };
}

function codigo(code, msg) { const e = new Error(msg); e.code = code; return e; }
const barra = (p) => String(p).split(path.sep).join('/');

// ── preserveUserState ────────────────────────────────────────────────────────
// Lee el estado actual del usuario antes del update para restaurarlo después

function preserveUserState(projectPath, configPath) {
  const state = {
    configured:  false,
    name:        null,
    description: null,
    stack:       null,
    testCommand: null,
    rawSections: {},  // Secciones del usuario que no son del sistema
  };

  if (!fs.existsSync(configPath)) return state;

  try {
    const config = fs.readFileSync(configPath, 'utf8');

    // CONFIGURADO
    state.configured = /^CONFIGURADO:\s*SI/m.test(config);

    // Nombre del proyecto
    const nameMatch = config.match(/^Nombre:\s*(.+)$/m);
    if (nameMatch) state.name = nameMatch[1].trim();

    // Descripción
    const descMatch = config.match(/^Descripción:\s*([\s\S]+?)(?=\n##|\n[A-Z])/m);
    if (descMatch) state.description = descMatch[1].trim();

    // Stack completo (bloque ## Stack hasta el siguiente ##)
    const stackMatch = config.match(/^## Stack\n([\s\S]+?)(?=\n##|$)/m);
    if (stackMatch) state.stack = stackMatch[1].trim();

    // Test command — [^\S\n]* y no \s*: \s* cruzaba el salto de línea y con
    // config.md en formato YAML de bloque capturaba la línea siguiente (2026-07-19).
    const testMatch = config.match(/^[^\S\n]*test:[^\S\n]*(\S.*)$/m) || config.match(/^[^\S\n]*comando:[^\S\n]*(\S.*)$/m);
    if (testMatch && testMatch[1].trim() !== '—') {
      state.testCommand = testMatch[1].trim();
    }

    // Secciones de módulos y reglas del proyecto (todo lo que va después de ## Reglas)
    const userSections = config.match(/^## (Reglas del proyecto|Módulos|Archivos compartidos|Sinónimos)([\s\S]+?)(?=\n##|$)/gm) || [];
    for (const section of userSections) {
      const titleMatch = section.match(/^## (.+)/);
      if (titleMatch) state.rawSections[titleMatch[1]] = section;
    }

  } catch(e) { /* best-effort */ }

  return state;
}

// ── restoreUserState ─────────────────────────────────────────────────────────
// Restaura el estado del usuario en config.md después del update

function restoreUserState(configPath, state) {
  if (!fs.existsSync(configPath)) return;

  try {
    let config = fs.readFileSync(configPath, 'utf8');
    let changed = false;

    // Restaurar CONFIGURADO: SI
    if (state.configured && /^CONFIGURADO:\s*NO/m.test(config)) {
      config = config.replace(/^CONFIGURADO:\s*NO/m, 'CONFIGURADO: SI');
      changed = true;
    }

    // Restaurar nombre del proyecto
    if (state.name) {
      const currentName = config.match(/^Nombre:\s*(.+)$/m)?.[1]?.trim();
      if (!currentName || currentName === '—' || currentName === '') {
        config = config.replace(/^Nombre:\s*.*$/m, `Nombre: ${state.name}`);
        changed = true;
      }
    }

    // Restaurar test command ([^\S\n]*: no cruzar saltos de línea, 2026-07-19)
    if (state.testCommand) {
      const currentTest = config.match(/^[^\S\n]*test:[^\S\n]*(\S.*)$/m)?.[1]?.trim();
      if (!currentTest || currentTest === '—') {
        config = config.replace(/^(\s*test:)\s*.*$/m, `$1 ${state.testCommand}`);
        changed = true;
      }
    }

    // Restaurar stack si se perdió
    if (state.stack) {
      const hasStack = config.includes('## Stack') && !config.match(/^## Stack\s*\n—/m);
      if (!hasStack) {
        config = config.replace(/^## Stack[\s\S]*?(?=\n##)/m, `## Stack\n${state.stack}\n`);
        changed = true;
      }
    }

    // Restaurar secciones de usuario
    for (const [title, section] of Object.entries(state.rawSections)) {
      if (!config.includes(`## ${title}`)) {
        config += `\n${section}\n`;
        changed = true;
      }
    }

    if (changed) {
      fs.writeFileSync(configPath, config, 'utf8');
    }

  } catch(e) { /* best-effort */ }
}

/**
 * Lo que el proyecto declaró en .agentic/protected_files no lo pisa una
 * actualización. Manifiesto inválido = no se copia nada. Si hay manifiesto
 * pero no hay con qué leerlo, tampoco: no verificado no es permitido.
 */
function guardiaProtegidos(projectPath, fuente) {
  const candidatos = [fuente, projectPath, path.join(__dirname, '..')]
    .filter(Boolean)
    .map((base) => path.resolve(base, '.agentic', 'grafo', 'protected-files.cjs'));
  const modPath = candidatos.find((p) => fs.existsSync(p));
  const hayManifiesto = fs.existsSync(path.join(projectPath, '.agentic', 'protected_files'));
  if (!modPath) {
    if (hayManifiesto) return { ok: false, message: 'Hay .agentic/protected_files pero no se pudo cargar el verificador — update detenido' };
    return { ok: true, omitidos: [], filtro: () => true };
  }
  const pf = require(modPath);
  const m = pf.cargar(projectPath);
  if (!m.ok) return { ok: false, message: `.agentic/protected_files inválido (${m.message}${m.line ? ', línea ' + m.line : ''}) — update detenido, nada se copió` };
  const omitidos = [];
  const filtro = (_src, dest) => {
    const rel = path.relative(projectPath, dest);
    if (!rel || rel.startsWith('..')) return true;
    const r = pf.verificar(projectPath, [rel], { accion: 'update' });
    if (r.status === 'PASS') return true;
    omitidos.push(rel.replace(/\\/g, '/'));
    return false;
  };
  return { ok: true, omitidos, filtro };
}

module.exports = { update, rollback, guardiaProtegidos };


// ── migrarInstruccionesUsuario ───────────────────────────────────────────────
// Una sola vez: si el CLAUDE.md que hay en disco tiene texto del usuario
// debajo del marcador y todavía no existe .agentic/INSTRUCCIONES-PROYECTO.md,
// lo mueve allí. A partir de ese momento ese archivo es la única fuente y
// Agentix jamás lo escribe.
//
// Devuelve true si migró algo (para poder avisarlo por consola).

function migrarInstruccionesUsuario(projectPath, userInstrPath) {
  try {
    if (fs.existsSync(userInstrPath)) return false;   // ya migrado: no tocar

    const claudePath = path.join(projectPath, 'CLAUDE.md');
    if (!fs.existsSync(claudePath)) return false;

    const actual = fs.readFileSync(claudePath, 'utf8');

    // El marcador ha tenido dos redacciones; se aceptan ambas.
    const re = /^#\s*INSTRUCCIONES DEL PROYECTO.*$/gm;
    let ultimo = null, m;
    while ((m = re.exec(actual)) !== null) ultimo = m;
    if (!ultimo) return false;

    // Todo lo que va después del bloque de comentarios del marcador
    // Cortar por el CIERRE del marco (# =====), no por "lineas que empiezan
    // por #": el texto del usuario son titulos markdown (## Mi regla) y una
    // limpieza por # se los comia. Lo cazo la prueba de test/update-instrucciones.
    let resto = actual.slice(ultimo.index + ultimo[0].length);
    const cierre = resto.match(/^[^\n]*\n(?:#[ =]+\n)?/);
    if (cierre) resto = resto.slice(cierre[0].length);
    // saltar el resto del marco y los comentarios de ayuda, PERO parar en cuanto
    // aparezca algo que no sea una linea de marco (# === o # texto sin ##)
    resto = resto.replace(/^(?:#(?!#)[^\n]*\n|[ \t]*\n)+/, '');
    resto = resto.trim();

    if (!resto) return false;   // no había nada del usuario

    fs.ensureDirSync(path.dirname(userInstrPath));
    fs.writeFileSync(userInstrPath,
      '# Instrucciones del proyecto\n' +
      '#\n' +
      '# Este archivo es tuyo. Agentix NO lo escribe nunca.\n' +
      '# `akdd update` lo lee y lo pega al final de CLAUDE.md en cada actualización.\n' +
      '\n' + resto + '\n', 'utf8');
    return true;
  } catch {
    return false;   // fail-soft: nunca romper un update por esto
  }
}
