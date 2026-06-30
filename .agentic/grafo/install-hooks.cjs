#!/usr/bin/env node
'use strict';
/**
 * install-hooks.cjs — Instala (o desinstala) los git hooks del framework Agentic KDD.
 * Copia .agentic/grafo/git-hooks/* a .git/hooks/.
 * Seguro: no-op sin .git, idempotente, y NUNCA sobrescribe un hook ajeno
 * (uno que no contenga el marcador de Agentic KDD).
 *
 * Uso:
 *   node .agentic/grafo/install-hooks.cjs            # instala
 *   node .agentic/grafo/install-hooks.cjs --uninstall
 *   node .agentic/grafo/install-hooks.cjs --status
 *   node .agentic/grafo/install-hooks.cjs --quiet    # silencioso (para sync/init/update)
 *
 * Exporta installHooks({ root, quiet, uninstall }) y statusHooks({ root }).
 */
const fs = require('node:fs');
const path = require('node:path');

const MARKER = '# Agentic KDD managed hook';
const HERE = __dirname;
const SRC = path.join(HERE, 'git-hooks');

function findGitDir(root) {
  const gitPath = path.join(root, '.git');
  if (!fs.existsSync(gitPath)) return null;
  let stat;
  try { stat = fs.statSync(gitPath); } catch { return null; }
  if (stat.isDirectory()) return gitPath;
  try {
    const m = fs.readFileSync(gitPath, 'utf8').match(/gitdir:\s*(.+)/);
    if (m) {
      const resolved = path.resolve(root, m[1].trim());
      if (fs.existsSync(resolved)) return resolved;
    }
  } catch {}
  return null;
}

function installHooks(opts = {}) {
  const root = opts.root || process.cwd();
  const quiet = !!opts.quiet;
  const uninstall = !!opts.uninstall;
  const log = (...a) => { if (!quiet) console.log(...a); };

  const gitDir = findGitDir(root);
  if (!gitDir) { log('  (sin repositorio git — hooks no instalados)'); return { ok: false, reason: 'no-git' }; }

  const hooksDir = path.join(gitDir, 'hooks');
  try { fs.mkdirSync(hooksDir, { recursive: true }); } catch {}
  if (!fs.existsSync(SRC)) { log('  (sin templates de hooks)'); return { ok: false, reason: 'no-templates' }; }

  const hooks = fs.readdirSync(SRC).filter(f => !f.startsWith('.'));
  const results = [];
  for (const hook of hooks) {
    const dest = path.join(hooksDir, hook);
    if (uninstall) {
      if (fs.existsSync(dest) && fs.readFileSync(dest, 'utf8').includes(MARKER)) {
        fs.unlinkSync(dest);
        log(`  🗑️  Desinstalado: .git/hooks/${hook}`);
        results.push({ hook, action: 'uninstalled' });
      }
      continue;
    }
    if (fs.existsSync(dest)) {
      const cur = fs.readFileSync(dest, 'utf8');
      if (!cur.includes(MARKER)) {
        log(`  ⚠️  .git/hooks/${hook} ya existe y no es de Agentic KDD — no se toca.`);
        results.push({ hook, action: 'skipped-foreign' });
        continue;
      }
    }
    fs.writeFileSync(dest, fs.readFileSync(path.join(SRC, hook), 'utf8'), 'utf8');
    try { fs.chmodSync(dest, 0o755); } catch {}
    log(`  ✅ Instalado: .git/hooks/${hook}`);
    results.push({ hook, action: 'installed' });
  }
  return { ok: true, results };
}

function statusHooks(opts = {}) {
  const root = opts.root || process.cwd();
  const gitDir = findGitDir(root);
  if (!gitDir) { console.log('  Sin repositorio git.'); return; }
  const hooksDir = path.join(gitDir, 'hooks');
  const hooks = fs.existsSync(SRC) ? fs.readdirSync(SRC).filter(f => !f.startsWith('.')) : [];
  if (!hooks.length) { console.log('  (sin templates de hooks)'); return; }
  for (const hook of hooks) {
    const dest = path.join(hooksDir, hook);
    if (fs.existsSync(dest)) {
      const ours = fs.readFileSync(dest, 'utf8').includes(MARKER);
      console.log(`  ${hook}: ${ours ? '✅ instalado (Agentic KDD)' : '⚠️ existe pero es ajeno'}`);
    } else {
      console.log(`  ${hook}: ❌ no instalado`);
    }
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const quiet = args.includes('--quiet');
  if (args.includes('--status') || args[0] === 'status') { statusHooks({}); process.exit(0); }
  const uninstall = args.includes('--uninstall') || args[0] === 'uninstall';
  const res = installHooks({ uninstall, quiet });
  if (!quiet && res.ok && !uninstall) {
    console.log('\n  Hooks activos. El registro de contratos correrá automáticamente tras cada commit.');
  }
  process.exit(0);
}

module.exports = { installHooks, statusHooks, MARKER };
