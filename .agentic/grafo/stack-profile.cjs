'use strict';

/**
 * Stack Profile — Agentic KDD v3.13 (Plan 4: portabilidad de convenciones)
 *
 * Resuelve: las features que preguntan "¿esto es front?" tenían la convención
 * de Lumo quemada en el código (public/ + .jsx/.tsx). En proyectos de clientes
 * con front en client/, frontend/, Vue, HTML plano, etc., todo se clasificaba
 * como backend en silencio.
 *
 * El principio: LAS CONVENCIONES NO SE PROGRAMAN — SE DECLARAN.
 *   - detectProfile(): autodetección por señales puntuadas (deps del
 *     package.json/requirements/Gemfile/composer/go.mod, carpetas candidatas,
 *     extensiones, contenido). Ninguna señal sola decide.
 *   - saveProfile()/loadProfile(): persistencia en project_settings
 *     (key 'stack_profile', JSON) — editable también a mano.
 *   - esFront(file, profile): LA pregunta central, con regla de degradación:
 *     sin perfil → la heurística vieja EXACTA (public/ + .jsx/.tsx). Nadie
 *     queda peor que hoy por no tener perfil.
 *
 * Uso CLI:
 *   node .agentic/grafo/stack-profile.cjs detect          — detectar y mostrar
 *   node .agentic/grafo/stack-profile.cjs detect --save   — detectar y guardar
 *   node .agentic/grafo/stack-profile.cjs show            — ver el perfil guardado
 */

const fs = require('fs');
const path = require('path');

const safe = (fn, fb = null) => { try { return fn(); } catch { return fb; } };

// ─── DB (mismo patrón dual-driver que ast-indexer) ───────────────────────────

function openDB(projectRoot) {
  const dbPath = path.join(projectRoot, '.agentic', 'memoria.db');
  if (!fs.existsSync(dbPath)) return null;
  try {
    const Database = require('better-sqlite3');
    return new Database(dbPath);
  } catch {
    try {
      const { DatabaseSync } = require('node:sqlite');
      return new DatabaseSync(dbPath);
    } catch { return null; }
  }
}

// ─── DETECCIÓN ────────────────────────────────────────────────────────────────

// Carpetas candidatas a front — conservador a propósito: 'app' NO está (en
// Next.js es front, en Rails es todo — ambigüedad que produce clasificación
// errónea; si un proyecto la usa como front, se agrega a mano al perfil).
const FRONT_DIR_CANDIDATES = [
  'public', 'client', 'frontend', 'front', 'web', 'static',
  'src/pages', 'src/components', 'src/views', 'templates', 'views',
];
const BACK_DIR_CANDIDATES = [
  'src/api', 'src/routes', 'routes', 'server', 'api', 'src/server', 'app/controllers',
];

const FRONT_EXT = /\.(html|css|scss|jsx|tsx|vue|svelte)$/i;
const CODE_EXT  = /\.(js|ts|jsx|tsx|mjs|cjs|vue|svelte|html|css|scss)$/i;

function listFilesShallow(dir, maxFiles = 40, depth = 2) {
  const out = [];
  const walk = (d, lvl) => {
    if (out.length >= maxFiles || lvl > depth) return;
    const entries = safe(() => fs.readdirSync(d, { withFileTypes: true }), []);
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, lvl + 1);
      else if (CODE_EXT.test(e.name)) out.push(full);
    }
  };
  walk(dir, 0);
  return out;
}

function scoreDirAsFront(projectRoot, relDir) {
  const full = path.join(projectRoot, relDir);
  if (!fs.existsSync(full) || !safe(() => fs.statSync(full).isDirectory(), false)) return null;
  const files = listFilesShallow(full);
  if (!files.length) return null;

  let frontScore = 0, backScore = 0;
  for (const f of files) {
    if (FRONT_EXT.test(f)) { frontScore += 2; continue; }
    // .js/.ts sin extensión front: mirar contenido (barato, muestra acotada)
    const content = safe(() => fs.readFileSync(f, 'utf8').slice(0, 8000), '');
    if (/\b(document\.|window\.|addEventListener\(|localStorage|querySelector)/.test(content)) frontScore += 1;
    if (/\b(require\(['"]express['"]\)|app\.listen\(|createServer\(|process\.env\.PORT|from ['"]fastify['"])/.test(content)) backScore += 2;
  }
  return { relDir, frontScore, backScore, files: files.length };
}

function readDeps(projectRoot) {
  const deps = new Set();
  const pkg = safe(() => JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')));
  if (pkg) {
    Object.keys(pkg.dependencies || {}).forEach(d => deps.add(d.toLowerCase()));
    Object.keys(pkg.devDependencies || {}).forEach(d => deps.add(d.toLowerCase()));
  }
  const reqs = safe(() => fs.readFileSync(path.join(projectRoot, 'requirements.txt'), 'utf8'), '') +
               safe(() => fs.readFileSync(path.join(projectRoot, 'pyproject.toml'), 'utf8'), '');
  ['flask', 'fastapi', 'django'].forEach(d => { if (new RegExp('\\b' + d + '\\b', 'i').test(reqs)) deps.add(d); });
  const gemfile = safe(() => fs.readFileSync(path.join(projectRoot, 'Gemfile'), 'utf8'), '');
  if (/\brails\b/i.test(gemfile)) deps.add('rails');
  const composer = safe(() => JSON.parse(fs.readFileSync(path.join(projectRoot, 'composer.json'), 'utf8')));
  if (composer && /laravel/i.test(JSON.stringify(composer.require || {}))) deps.add('laravel');
  const gomod = safe(() => fs.readFileSync(path.join(projectRoot, 'go.mod'), 'utf8'), '');
  if (/gin-gonic/i.test(gomod)) deps.add('gin');
  if (/labstack\/echo/i.test(gomod)) deps.add('echo');
  return deps;
}

function detectFrameworks(deps) {
  let front = null, back = null;
  if (deps.has('react') || deps.has('next')) front = 'react';
  else if (deps.has('vue') || deps.has('nuxt')) front = 'vue';
  else if (deps.has('svelte')) front = 'svelte';
  else if (deps.has('@angular/core')) front = 'angular';

  if (deps.has('@nestjs/core')) back = 'nest';
  else if (deps.has('fastify')) back = 'fastify';
  else if (deps.has('express')) back = 'express';
  else if (deps.has('koa')) back = 'koa';
  else if (deps.has('fastapi')) back = 'fastapi';
  else if (deps.has('flask')) back = 'flask';
  else if (deps.has('django')) back = 'django';
  else if (deps.has('rails')) back = 'rails';
  else if (deps.has('laravel')) back = 'laravel';
  else if (deps.has('gin') || deps.has('echo')) back = 'gin';
  return { front, back };
}

// Wrappers de API propios del proyecto: se detecta el caso más común (una
// función exportada llamada 'api' que envuelve fetch, como core.js de Lumo).
// Otros wrappers se agregan A MANO al perfil — detectar "toda función que
// envuelve fetch" produce falsos positivos que ensucian el matching.
function detectApiWrappers(projectRoot, frontDirs) {
  const wrappers = new Set();
  for (const dir of frontDirs) {
    const files = listFilesShallow(path.join(projectRoot, dir), 60, 3)
      .filter(f => /\.(js|ts|jsx|tsx|mjs)$/i.test(f));
    for (const f of files) {
      const content = safe(() => fs.readFileSync(f, 'utf8'), '');
      if (/(?:export\s+)?(?:async\s+)?function\s+api\s*\(/.test(content) ||
          /(?:export\s+)?const\s+api\s*=\s*(?:async\s*)?\(/.test(content)) {
        if (/\bfetch\(/.test(content)) { wrappers.add('api'); break; }
      }
    }
    if (wrappers.size) break;
  }
  return [...wrappers];
}

function detectProfile(projectRoot) {
  projectRoot = projectRoot || process.cwd();
  const deps = readDeps(projectRoot);
  const { front, back } = detectFrameworks(deps);

  const front_dirs = [];
  for (const cand of FRONT_DIR_CANDIDATES) {
    const s = scoreDirAsFront(projectRoot, cand);
    if (s && s.frontScore > s.backScore && s.frontScore >= 2) front_dirs.push(cand);
  }
  const back_dirs = BACK_DIR_CANDIDATES.filter(d =>
    safe(() => fs.statSync(path.join(projectRoot, d)).isDirectory(), false));

  const api_wrappers = detectApiWrappers(projectRoot, front_dirs.length ? front_dirs : ['public']);

  return {
    version: 1,
    source: 'auto',
    detected_at: new Date().toISOString().slice(0, 10),
    front_dirs,
    back_dirs,
    front_framework: front || 'vanilla',
    back_framework: back || 'desconocido',
    api_wrappers,
  };
}

// ─── PERSISTENCIA ─────────────────────────────────────────────────────────────

function saveProfile(projectRoot, profile) {
  const db = openDB(projectRoot);
  if (!db) return false;
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS project_settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now'))
    )`);
    db.prepare(`INSERT OR REPLACE INTO project_settings (key, value, updated_at) VALUES ('stack_profile', ?, datetime('now'))`)
      .run(JSON.stringify(profile));
    return true;
  } catch { return false; }
  finally { safe(() => db.close()); }
}

function loadProfile(projectRoot) {
  const db = openDB(projectRoot || process.cwd());
  if (!db) return null;
  try {
    const row = db.prepare(`SELECT value FROM project_settings WHERE key = 'stack_profile'`).get();
    if (!row || !row.value) return null;
    const p = JSON.parse(row.value);
    return (p && Array.isArray(p.front_dirs)) ? p : null;
  } catch { return null; }
  finally { safe(() => db.close()); }
}

// ─── LA PREGUNTA CENTRAL ──────────────────────────────────────────────────────
// esFront(file, profile): con perfil → prefijo de carpeta declarada.
// Sin perfil (o vacío) → la heurística vieja EXACTA: public/ o .jsx/.tsx.
// Regla de degradación del Plan 4: la ausencia de perfil reproduce el
// comportamiento actual — nadie queda peor por no configurar nada.
function esFront(file, profile) {
  const f = String(file || '').replace(/\\/g, '/');
  if (profile && Array.isArray(profile.front_dirs) && profile.front_dirs.length) {
    return profile.front_dirs.some(d => f === d || f.startsWith(d + '/'));
  }
  return f.startsWith('public/') || /\.(jsx|tsx)$/i.test(f);
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const cmd = process.argv[2] || 'show';
  const root = process.cwd();
  if (cmd === 'detect') {
    const p = detectProfile(root);
    console.log('\n📐 Stack Profile (autodetectado):\n' + JSON.stringify(p, null, 2));
    if (process.argv.includes('--save')) {
      const ok = saveProfile(root, p);
      console.log(ok ? '\n✅ Guardado en project_settings (key: stack_profile)' : '\n⚠️  No se pudo guardar (¿.agentic/memoria.db existe?)');
    } else {
      console.log('\nPara guardarlo: node .agentic/grafo/stack-profile.cjs detect --save');
    }
  } else if (cmd === 'show') {
    const p = loadProfile(root);
    console.log(p ? JSON.stringify(p, null, 2) : 'Sin perfil guardado. Corre: node .agentic/grafo/stack-profile.cjs detect --save');
  } else {
    console.log('Uso: stack-profile.cjs [detect [--save] | show]');
  }
}

module.exports = { detectProfile, loadProfile, saveProfile, esFront };
