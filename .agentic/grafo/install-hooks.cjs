#!/usr/bin/env node
'use strict';
/**
 * install-hooks.cjs — Instala (o desinstala) los git hooks del framework Agentic KDD.
 *
 * La carpeta destino la decide git (`rev-parse --git-path hooks`): respeta
 * core.hooksPath y los worktrees. Un hook ajeno NUNCA se pisa: queda CONFLICT
 * (ok:false). Componer con él solo con --compose, que guarda un respaldo y lo
 * ejecuta antes que el de Agentix. Desinstalar solo quita lo que es de Agentix
 * y devuelve el respaldo a su lugar. Idempotente.
 *
 * Uso:
 *   node .agentic/grafo/install-hooks.cjs              # instala
 *   node .agentic/grafo/install-hooks.cjs --compose    # instala componiendo con hooks ajenos
 *   node .agentic/grafo/install-hooks.cjs --uninstall
 *   node .agentic/grafo/install-hooks.cjs --status
 *   node .agentic/grafo/install-hooks.cjs --quiet      # silencioso (para sync/init/update)
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MARKER = '# Agentic KDD managed hook';
const BACKUP = '.agentix-backup';
const HERE = __dirname;
const SRC = path.join(HERE, 'git-hooks');

function hooksDirDe(root) {
  const r = spawnSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0 || !r.stdout.trim()) return null;
  return path.resolve(root, r.stdout.trim());
}

const plantillas = () => (fs.existsSync(SRC) ? fs.readdirSync(SRC).filter((f) => !f.startsWith('.')) : []);
const leerLF = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');

function compuesto(hook, plantilla) {
  return [
    '#!/bin/sh',
    MARKER + ' (compuesto)',
    '# Primero el hook que ya existía; si falla, el commit no sigue.',
    `PREVIO="$(dirname "$0")/${hook}${BACKUP}"`,
    'if [ -x "$PREVIO" ]; then "$PREVIO" "$@" || exit $?; fi',
    plantilla.split('\n').filter((l) => !l.startsWith('#!') && !l.startsWith(MARKER)).join('\n'),
  ].join('\n');
}

function estadoDe(dest, plantilla) {
  if (!fs.existsSync(dest)) return 'missing';
  const cur = leerLF(dest);
  if (!cur.includes(MARKER)) return 'conflict';
  if (cur.includes(MARKER + ' (compuesto)')) return 'enabled';
  return cur === plantilla ? 'enabled' : 'outdated';
}

function installHooks(opts = {}) {
  const root = opts.root || process.cwd();
  const quiet = !!opts.quiet;
  const log = (...a) => { if (!quiet) console.log(...a); };

  const hooksDir = hooksDirDe(root);
  if (!hooksDir) { log('  (sin repositorio git — hooks no instalados)'); return { ok: false, reason: 'no-git', results: [] }; }
  const hooks = plantillas();
  if (!hooks.length) { log('  (sin templates de hooks)'); return { ok: false, reason: 'no-templates', results: [] }; }
  fs.mkdirSync(hooksDir, { recursive: true });

  const results = [];
  for (const hook of hooks) {
    const dest = path.join(hooksDir, hook);
    const respaldo = dest + BACKUP;
    const plantilla = leerLF(path.join(SRC, hook));

    if (opts.uninstall) {
      if (fs.existsSync(dest) && leerLF(dest).includes(MARKER)) {
        fs.unlinkSync(dest);
        if (fs.existsSync(respaldo)) fs.renameSync(respaldo, dest);
        log(`  🗑️  Desinstalado: ${hook}`);
        results.push({ hook, action: 'uninstalled' });
      } else {
        results.push({ hook, action: fs.existsSync(dest) ? 'foreign-kept' : 'absent' });
      }
      continue;
    }

    const estado = estadoDe(dest, plantilla);
    if (estado === 'conflict' && !opts.compose) {
      log(`  ⚠️  ${hook} ya existe y no es de Agentic KDD — no se toca (usa --compose para encadenarlo).`);
      results.push({ hook, action: 'conflict' });
      continue;
    }
    if (estado === 'enabled') { results.push({ hook, action: 'unchanged' }); continue; }
    let contenido = plantilla;
    if (estado === 'conflict') {
      if (!fs.existsSync(respaldo)) fs.copyFileSync(dest, respaldo);
      try { fs.chmodSync(respaldo, 0o755); } catch { /* sin permisos POSIX */ }
      contenido = compuesto(hook, plantilla);
    }
    fs.writeFileSync(dest, contenido, 'utf8');
    try { fs.chmodSync(dest, 0o755); } catch { /* sin permisos POSIX */ }
    log(`  ✅ ${estado === 'conflict' ? 'Compuesto' : estado === 'outdated' ? 'Actualizado' : 'Instalado'}: ${hook}`);
    results.push({ hook, action: estado === 'conflict' ? 'composed' : estado === 'outdated' ? 'updated' : 'installed' });
  }
  const conflictos = results.filter((r) => r.action === 'conflict');
  return { ok: conflictos.length === 0, reason: conflictos.length ? 'conflict' : null, hooksDir, results };
}

/** → { status: enabled|partial|conflict|missing|unsupported, hooks: [{hook, state}] } */
function statusHooks(opts = {}) {
  const root = opts.root || process.cwd();
  const hooksDir = hooksDirDe(root);
  if (!hooksDir) return { status: 'unsupported', reason: 'no-git', hooks: [] };
  const hooks = plantillas().map((hook) => ({ hook, state: estadoDe(path.join(hooksDir, hook), leerLF(path.join(SRC, hook))) }));
  const estados = hooks.map((h) => h.state);
  const status = !hooks.length ? 'unsupported'
    : estados.includes('conflict') ? 'conflict'
    : estados.every((s) => s === 'enabled') ? 'enabled'
    : estados.every((s) => s === 'missing') ? 'missing' : 'partial';
  return { status, hooksDir, hooks };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const quiet = args.includes('--quiet');
  if (args.includes('--status') || args[0] === 'status') {
    const s = statusHooks({});
    console.log(`  Hooks: ${s.status}${s.hooksDir ? '  (' + s.hooksDir + ')' : ''}`);
    for (const h of s.hooks) console.log(`   ${h.hook}: ${h.state}`);
    process.exit(0);
  }
  const uninstall = args.includes('--uninstall') || args[0] === 'uninstall';
  const res = installHooks({ uninstall, quiet, compose: args.includes('--compose') });
  if (res.reason === 'conflict') {
    console.log('  ⚠️  Agentic KDD: hay hooks ajenos — los gates NO están activos en: '
      + res.results.filter((r) => r.action === 'conflict').map((r) => r.hook).join(', ')
      + '.  Usa: node .agentic/grafo/install-hooks.cjs --compose');
  } else if (!quiet && res.ok && !uninstall) {
    console.log('\n  Hooks activos. El registro de contratos correrá automáticamente tras cada commit.');
  }
  process.exit(0);
}

module.exports = { installHooks, statusHooks, MARKER };
