'use strict';
/**
 * Agentic KDD — Onboard v1.0
 * Analiza un proyecto existente (brownfield), mapea el stack,
 * pre-popula la memoria con lo que encuentra, y propone la primera tarea.
 *
 * Uso: akdd onboard
 */

const fs     = require('fs-extra');
const path   = require('path');
const chalk  = require('chalk');
const ora    = require('ora');

async function onboard() {
  const projectPath = process.cwd();
  const agentic     = path.join(projectPath, '.agentic');

  console.log('\n' + chalk.bold.blue('  Agentic KDD') + chalk.gray(' — onboarding brownfield project\n'));

  // ── Check agentic is installed ────────────────────────────────────────────
  if (!fs.existsSync(path.join(agentic, 'config.md'))) {
    console.log(chalk.yellow('  Agentic KDD not installed. Run: akdd init\n'));
    process.exit(1);
  }

  const spinner = ora({ text: 'Scanning project...', color: 'blue' }).start();

  const report = {
    stack:     detectStack(projectPath),
    modules:   detectModules(projectPath),
    tests:     detectTests(projectPath),
    patterns:  detectPatterns(projectPath),
    size:      countFiles(projectPath),
    suggested: null,
  };

  spinner.text = 'Analyzing architecture...';
  await sleep(300);

  report.suggested = suggestFirstTask(report);

  spinner.succeed(chalk.green('Project analyzed!'));

  // ── Print report ──────────────────────────────────────────────────────────
  console.log('\n' + chalk.bold('  📊 Project snapshot:'));
  console.log(chalk.gray(`  Stack:    ${report.stack.join(' · ')}`));
  console.log(chalk.gray(`  Size:     ${report.size.source} source files, ${report.size.tests} test files`));
  console.log(chalk.gray(`  Modules:  ${report.modules.length > 0 ? report.modules.join(', ') : 'none detected'}`));
  console.log(chalk.gray(`  Tests:    ${report.tests.framework || 'not configured'}`));

  // ── Write to config.md ────────────────────────────────────────────────────
  const configPath = path.join(agentic, 'config.md');
  if (fs.existsSync(configPath)) {
    let config = fs.readFileSync(configPath, 'utf8');

    // Update stack info if blank
    if (config.includes('Tipo: EXISTENTE') || config.includes('Tipo: —')) {
      config = config.replace(/^Tipo:.+$/m, 'Tipo: EXISTENTE (brownfield — onboarded)');
    }

    // Update test command if not set
    if (report.tests.command && config.match(/^\s*test:\s*(—|$)/m)) {
      config = config.replace(/^(\s*test:).+$/m, `$1 ${report.tests.command}`);
      console.log(chalk.green(`\n  ✓ Test command set: ${report.tests.command}`));
    }

    fs.writeFileSync(configPath, config);
  }

  // ── Write patterns to memoria ─────────────────────────────────────────────
  if (report.patterns.length > 0) {
    const patronesPath = path.join(agentic, 'memoria', 'patrones.md');
    const existing     = fs.existsSync(patronesPath) ? fs.readFileSync(patronesPath, 'utf8') : '';

    const newPatterns = report.patterns
      .filter(p => !existing.includes(p.title))
      .map(p => `\n### ${p.title}\n**confianza**: MEDIA\n**módulo**: ${p.module}\n**regla**: ${p.rule}\n**detectado por**: akdd onboard\n`)
      .join('');

    if (newPatterns) {
      fs.appendFileSync(patronesPath, newPatterns);
      console.log(chalk.green(`  ✓ ${report.patterns.filter(p => !existing.includes(p.title)).length} patterns pre-populated in memoria`));
    }
  }

  // ── Suggest first task ────────────────────────────────────────────────────
  if (report.suggested) {
    console.log('\n' + chalk.bold('  💡 Suggested first task:'));
    console.log(chalk.white(`\n  ${report.suggested}`));
    console.log(chalk.gray('\n  Copy and paste as-is, or modify to fit your needs.\n'));
  }
}

// ── Stack detection ───────────────────────────────────────────────────────────

function detectStack(root) {
  const stack = [];

  const pkg = safeReadJSON(path.join(root, 'package.json'));
  if (pkg) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps['next'])         stack.push('Next.js');
    else if (deps['react'])   stack.push('React');
    else if (deps['express']) stack.push('Express');
    else if (deps['fastify']) stack.push('Fastify');
    else if (deps['nestjs'])  stack.push('NestJS');
    if (deps['typescript'])   stack.push('TypeScript');
    if (deps['prisma'])       stack.push('Prisma');
    if (deps['@supabase/supabase-js']) stack.push('Supabase');
  }

  if (fs.existsSync(path.join(root, 'requirements.txt')) ||
      fs.existsSync(path.join(root, 'backend', 'requirements.txt'))) {
    stack.push('Python');
    const req = safeRead(path.join(root, 'backend', 'requirements.txt')) ||
                safeRead(path.join(root, 'requirements.txt')) || '';
    if (req.includes('fastapi'))    stack.push('FastAPI');
    if (req.includes('django'))     stack.push('Django');
    if (req.includes('sqlalchemy')) stack.push('SQLAlchemy');
  }

  if (fs.existsSync(path.join(root, 'composer.json'))) stack.push('PHP/Laravel');

  if (stack.length === 0) stack.push('Unknown');
  return stack;
}

// ── Module detection ──────────────────────────────────────────────────────────

function detectModules(root) {
  const modules = [];
  const searchDirs = ['src', 'app', 'lib', 'backend/app', 'backend/src'];

  for (const dir of searchDirs) {
    const full = path.join(root, dir);
    if (!fs.existsSync(full)) continue;
    try {
      for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          modules.push(entry.name);
        }
      }
    } catch {}
  }

  return [...new Set(modules)].slice(0, 12);
}

// ── Test detection ────────────────────────────────────────────────────────────

function detectTests(root) {
  const pkg = safeReadJSON(path.join(root, 'package.json'));
  let framework = null;
  let command   = null;

  if (pkg) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps['vitest'])   { framework = 'Vitest';  command = 'npm test'; }
    if (deps['jest'])     { framework = 'Jest';    command = 'npm test'; }
    if (pkg.scripts?.test && !pkg.scripts.test.includes('echo')) {
      command = 'npm test';
    }
  }

  const hasPytest = fs.existsSync(path.join(root, 'backend', 'requirements.txt')) &&
    (safeRead(path.join(root, 'backend', 'requirements.txt')) || '').includes('pytest');
  if (hasPytest) {
    framework = 'pytest';
    command   = 'cd backend && py -3.13 -m pytest -x -v';
  }

  const testFiles = countTestFiles(root);
  return { framework, command, count: testFiles };
}

function countTestFiles(root) {
  let count = 0;
  const patterns = [/\.(test|spec)\.(ts|tsx|js|jsx)$/, /test_.*\.py$/, /.*_test\.py$/];
  function walk(dir, depth = 0) {
    if (depth > 4) return;
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '.git', '__pycache__', '.next'].includes(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, depth + 1);
        else if (patterns.some(p => p.test(e.name))) count++;
      }
    } catch {}
  }
  walk(root);
  return count;
}

// ── Pattern detection ─────────────────────────────────────────────────────────

function detectPatterns(root) {
  const patterns = [];
  const sourceFiles = [];

  function walk(dir, depth = 0) {
    if (depth > 4) return;
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '.git', '__pycache__', '.next', 'dist'].includes(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, depth + 1);
        else if (/\.(ts|tsx|js|py)$/.test(e.name)) sourceFiles.push(full);
      }
    } catch {}
  }
  walk(root);

  const sampleFiles = sourceFiles.slice(0, 30);

  let hasMultiTenant    = false;
  let hasSoftDelete     = false;
  let hasJWT            = false;
  let hasPrisma         = false;

  for (const f of sampleFiles) {
    const c = safeRead(f) || '';
    if (c.includes('tenant_id') || c.includes('agency_id') || c.includes('organization_id')) hasMultiTenant = true;
    if (c.includes('is_active') || c.includes('deleted_at') || c.includes('soft_delete'))   hasSoftDelete  = true;
    if (c.includes('jwt') || c.includes('access_token') || c.includes('Bearer'))            hasJWT = true;
    if (c.includes('prisma') || c.includes('PrismaClient'))                                   hasPrisma = true;
  }

  if (hasMultiTenant) patterns.push({
    title:  'Multi-tenancy: filtrar siempre por tenant_id en queries',
    module: 'global',
    rule:   'Cada query sobre datos de usuario DEBE incluir filtro por tenant_id/agency_id — nunca cross-tenant',
  });

  if (hasSoftDelete) patterns.push({
    title:  'Soft delete: usar is_active=false o deleted_at en vez de DELETE',
    module: 'global',
    rule:   'No ejecutar DELETE hard en tablas de usuario — usar soft delete para preservar integridad referencial',
  });

  if (hasJWT) patterns.push({
    title:  'Auth JWT: validar token antes de procesar cualquier request autenticado',
    module: 'auth',
    rule:   'Toda ruta protegida DEBE validar el JWT y extraer el subject antes de acceder a datos',
  });

  if (hasPrisma) patterns.push({
    title:  'Prisma: incluir relaciones explícitamente para evitar N+1',
    module: 'database',
    rule:   'Usar include:{} en queries que necesiten relaciones — nunca hacer queries en loop',
  });

  return patterns;
}

// ── First task suggestion ─────────────────────────────────────────────────────

function suggestFirstTask(report) {
  const { modules, tests, stack, size } = report;

  // No tests → suggest adding tests to a detected module
  if (tests.count === 0 && modules.length > 0) {
    const firstModule = modules[0];
    return `aa: agrega tests básicos al módulo "${firstModule}" — cubre CRUD y casos edge. No toques lógica existente, solo agrega tests.`;
  }

  // Has tests but no contracts → suggest running a cycle to seed contracts
  if (tests.count > 0) {
    return `aa: revisa el módulo más crítico del proyecto y refactoriza cualquier código que no tenga tests. Objetivo: cobertura mínima en el módulo más importante.`;
  }

  // Default
  return `aa: analiza el estado actual del proyecto y genera un resumen de módulos implementados, tests existentes y pendientes más importantes. Solo análisis, sin cambios.`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function countFiles(root) {
  let source = 0;
  let tests  = 0;
  const sourceExt  = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.php']);
  const testPattern= /\.(test|spec)\.(ts|tsx|js|jsx)$|test_.*\.py$|.*_test\.py$/;

  function walk(dir, depth = 0) {
    if (depth > 5) return;
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '.git', '__pycache__', '.next', 'dist'].includes(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, depth + 1);
        else {
          if (testPattern.test(e.name)) tests++;
          else if (sourceExt.has(path.extname(e.name))) source++;
        }
      }
    } catch {}
  }
  walk(root);
  return { source, tests };
}

function safeRead(filePath) {
  try { return require('fs').readFileSync(filePath, 'utf8'); } catch { return null; }
}

function safeReadJSON(filePath) {
  try { return JSON.parse(require('fs').readFileSync(filePath, 'utf8')); } catch { return null; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { onboard };
