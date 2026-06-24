/**
 * Agentic KDD — Spec Manager v1.0
 * Specs estilo Kiro (AWS) con wave execution.
 *
 * Estructura de un spec:
 *   .agentic/specs/[módulo]/requirements.md — user stories + criterios de aceptación
 *   .agentic/specs/[módulo]/design.md        — arquitectura + decisiones técnicas
 *   .agentic/specs/[módulo]/tasks.md         — plan de tareas con dependency graph
 *
 * Wave execution:
 *   Wave 1: tareas sin dependencias (paralelas conceptualmente)
 *   Wave 2: tareas que dependen de Wave 1
 *   Wave N: ...
 *
 * Uso:
 *   node .agentic/grafo/spec-manager.cjs create [módulo] [--feature | --bugfix]
 *   node .agentic/grafo/spec-manager.cjs waves [módulo]
 *   node .agentic/grafo/spec-manager.cjs status [módulo]
 *   node .agentic/grafo/spec-manager.cjs validate [módulo]
 *   node .agentic/grafo/spec-manager.cjs list
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const SPECS_DIR = '.agentic/specs';

// ─── PARSEAR TASKS.MD ─────────────────────────────────────────────────────────

/**
 * Parsea un archivo tasks.md y extrae las tareas con sus dependencias.
 * Formato esperado:
 *
 * ## Tarea 1: Nombre de la tarea
 * - Estado: PENDIENTE | EN_PROGRESO | COMPLETADA | BLOQUEADA
 * - Dependencias: Tarea 2, Tarea 3
 * - Archivos: src/auth.ts, src/session.ts
 * - Descripción: ...
 *
 * @returns {Task[]}
 */
function parseTasks(content) {
  const tasks = [];
  const taskPattern = /^##\s+(?:Tarea\s+)?(\d+)[:\s]+(.+)$/gm;

  let match;
  const taskStarts = [];

  while ((match = taskPattern.exec(content)) !== null) {
    taskStarts.push({ index: match.index, num: parseInt(match[1]), name: match[2].trim(), end: 0 });
  }

  for (let i = 0; i < taskStarts.length; i++) {
    const ts = taskStarts[i];
    ts.end = taskStarts[i + 1]?.index ?? content.length;
    const block = content.slice(ts.index, ts.end);

    const stateMatch = block.match(/^[-*]\s+Estado:\s*(.+)$/im);
    const depsMatch  = block.match(/^[-*]\s+Dependencias:\s*(.+)$/im);
    const filesMatch = block.match(/^[-*]\s+Archivos:\s*(.+)$/im);
    const descMatch  = block.match(/^[-*]\s+Descripción:\s*(.+)$/im);
    const agentMatch = block.match(/^[-*]\s+Agente:\s*(.+)$/im);

    const depNames = depsMatch ? depsMatch[1].split(',').map(d => d.trim()).filter(Boolean) : [];

    tasks.push({
      id: ts.num,
      name: ts.name,
      status: stateMatch?.[1]?.trim() || 'PENDIENTE',
      dependencies: depNames,
      dep_ids: [], // se resuelven después
      files: filesMatch ? filesMatch[1].split(',').map(f => f.trim()).filter(Boolean) : [],
      description: descMatch?.[1]?.trim() || '',
      agent: agentMatch?.[1]?.trim() || 'auto',
    });
  }

  // Resolver dep_ids desde nombres
  for (const task of tasks) {
    task.dep_ids = task.dependencies.map(depName => {
      const resolved = tasks.find(t =>
        t.name.toLowerCase().includes(depName.toLowerCase()) ||
        depName.toLowerCase().includes(t.name.toLowerCase()) ||
        String(t.id) === depName
      );
      return resolved?.id ?? null;
    }).filter(id => id !== null);
  }

  return tasks;
}

// ─── WAVE EXECUTION ──────────────────────────────────────────────────────────

/**
 * Organiza las tareas en waves (olas) de ejecución.
 * Wave 1 = tareas sin dependencias pendientes
 * Wave 2 = tareas cuyas dependencias están en Wave 1
 * ...
 *
 * @param {Task[]} tasks
 * @returns {{ waves: Task[][], cycles: number[] }} waves y task IDs con ciclos
 */
function buildWaves(tasks) {
  const pendingTasks = tasks.filter(t => t.status !== 'COMPLETADA');
  const completedIds = new Set(tasks.filter(t => t.status === 'COMPLETADA').map(t => t.id));

  const waves = [];
  const assigned = new Set([...completedIds]);
  const cycles = [];

  let maxIterations = pendingTasks.length + 1;
  let remaining = [...pendingTasks];

  while (remaining.length > 0 && maxIterations-- > 0) {
    const wave = remaining.filter(t => {
      const unresolvedDeps = t.dep_ids.filter(depId => !assigned.has(depId));
      return unresolvedDeps.length === 0;
    });

    if (wave.length === 0) {
      // Hay un ciclo o dependencias no resolubles
      const cycleIds = remaining.map(t => t.id);
      cycles.push(...cycleIds);
      console.warn(`[SPEC-MANAGER] ⚠️ Ciclo o dependencia irresoluble en tareas: ${cycleIds.join(', ')}`);
      // Agregar igualmente como Wave fallback
      waves.push(remaining);
      break;
    }

    waves.push(wave);
    wave.forEach(t => assigned.add(t.id));
    remaining = remaining.filter(t => !assigned.has(t.id));
  }

  return { waves, cycles };
}

// ─── ESTADO DEL SPEC ─────────────────────────────────────────────────────────

function getSpecStatus(specDir) {
  const tasksPath = path.join(specDir, 'tasks.md');
  if (!fs.existsSync(tasksPath)) return null;

  const content = fs.readFileSync(tasksPath, 'utf8');
  const tasks = parseTasks(content);

  const total = tasks.length;
  const completed = tasks.filter(t => t.status === 'COMPLETADA').length;
  const blocked = tasks.filter(t => t.status === 'BLOQUEADA').length;
  const inProgress = tasks.filter(t => t.status === 'EN_PROGRESO').length;

  const { waves } = buildWaves(tasks);
  const nextWave = waves.find(w => w.length > 0);

  return {
    total,
    completed,
    blocked,
    inProgress,
    pending: total - completed - blocked,
    percent: total > 0 ? Math.round((completed / total) * 100) : 0,
    next_wave: nextWave?.map(t => ({ id: t.id, name: t.name, agent: t.agent })) ?? [],
    waves_total: waves.length,
    all_done: completed === total && total > 0,
  };
}

// ─── VALIDAR SPEC ─────────────────────────────────────────────────────────────

function validateSpec(specDir, moduleName) {
  const issues = [];
  const warnings = [];

  const reqPath  = path.join(specDir, 'requirements.md');
  const desPath  = path.join(specDir, 'design.md');
  const tasksPath = path.join(specDir, 'tasks.md');

  if (!fs.existsSync(reqPath))   issues.push('Falta requirements.md');
  if (!fs.existsSync(desPath))   warnings.push('Falta design.md (recomendado para specs complejos)');
  if (!fs.existsSync(tasksPath)) issues.push('Falta tasks.md');

  if (fs.existsSync(tasksPath)) {
    const content = fs.readFileSync(tasksPath, 'utf8');
    const tasks = parseTasks(content);
    if (tasks.length === 0) issues.push('tasks.md no tiene tareas definidas');

    // Verificar que las dependencias referenciadas existen
    for (const task of tasks) {
      for (const depId of task.dep_ids) {
        if (!tasks.find(t => t.id === depId)) {
          warnings.push(`Tarea ${task.id} referencia dependencia ${depId} que no existe`);
        }
      }
    }
  }

  if (fs.existsSync(reqPath)) {
    const req = fs.readFileSync(reqPath, 'utf8');
    if (!req.includes('Criterios de aceptación') && !req.includes('acceptance criteria') && !req.includes('Given ')) {
      warnings.push('requirements.md no tiene criterios de aceptación claros');
    }
  }

  return {
    valid: issues.length === 0,
    issues,
    warnings,
  };
}

// ─── CREAR SPEC ───────────────────────────────────────────────────────────────

function createSpecFromTemplate(projectRoot, moduleName, tipo = 'feature') {
  const specDir = path.join(projectRoot, SPECS_DIR, moduleName);
  fs.mkdirSync(specDir, { recursive: true });

  const now = new Date().toISOString().split('T')[0];

  // requirements.md
  const reqContent = `# Requirements — ${moduleName}
Fecha: ${now}
Tipo: ${tipo}
Estado: BORRADOR

## Contexto y problema
_¿Qué problema resuelve este feature/bugfix?_

## User stories

### Historia 1
**Como** [rol]
**Quiero** [capacidad]
**Para** [beneficio]

## Criterios de aceptación

- [ ] CA-1: _criterio medible y verificable_
- [ ] CA-2: _criterio medible y verificable_
- [ ] CA-3: _criterio medible y verificable_

## Restricciones
- _No romper [módulo X]_
- _Mantener compatibilidad con [versión/API]_

## Out of scope
- _Lista de cosas que NO cubre este spec_
`;

  // design.md
  const desContent = `# Design — ${moduleName}
Fecha: ${now}

## Arquitectura propuesta

_Diagrama o descripción de la solución técnica._

## Archivos a modificar
| Archivo | Tipo de cambio | Razón |
|---------|---------------|-------|
| src/... | MODIFICAR      | ...  |

## Decisiones arquitectónicas
_Referencias a ADRs relevantes de docs/adr/_

- [ADR-XXX] Decisión sobre ...

## Riesgos técnicos
- _Riesgo 1: impacto estimado ALTO/MEDIO/BAJO_

## Dependencias externas
- _Paquetes, APIs, servicios que se necesitan_
`;

  // tasks.md
  const bugfixExtra = tipo === 'bugfix' ? `
## Tarea 0: Análisis de causa raíz
- Estado: PENDIENTE
- Dependencias: ninguna
- Archivos: (por determinar)
- Descripción: Reproducir el bug, identificar la causa raíz exacta, documentar en este spec.
- Agente: analista

` : '';

  const tasksContent = `# Tasks — ${moduleName}
Fecha: ${now}
Tipo: ${tipo}

> Wave execution: las tareas sin dependencias se ejecutan en Wave 1,
> las que dependen de ellas en Wave 2, etc.
> El Orquestador usa spec-manager.cjs waves ${moduleName} para calcularlas.

${bugfixExtra}## Tarea 1: [Nombre descriptivo]
- Estado: PENDIENTE
- Dependencias: ninguna
- Archivos: src/[módulo]/archivo.ts
- Descripción: [Qué implementar exactamente]
- Agente: back

## Tarea 2: [Nombre descriptivo]
- Estado: PENDIENTE
- Dependencias: Tarea 1
- Archivos: src/[módulo]/otro-archivo.ts
- Descripción: [Qué implementar exactamente]
- Agente: back

## Tarea 3: Tests
- Estado: PENDIENTE
- Dependencias: Tarea 1, Tarea 2
- Archivos: tests/[módulo].test.ts
- Descripción: Tests TDD para cubrir criterios de aceptación
- Agente: tdd
`;

  if (!fs.existsSync(path.join(specDir, 'requirements.md')))
    fs.writeFileSync(path.join(specDir, 'requirements.md'), reqContent);
  if (!fs.existsSync(path.join(specDir, 'design.md')))
    fs.writeFileSync(path.join(specDir, 'design.md'), desContent);
  if (!fs.existsSync(path.join(specDir, 'tasks.md')))
    fs.writeFileSync(path.join(specDir, 'tasks.md'), tasksContent);

  return specDir;
}

// ─── UPDATE TASK STATUS ───────────────────────────────────────────────────────

function updateTaskStatus(projectRoot, moduleName, taskId, newStatus) {
  const tasksPath = path.join(projectRoot, SPECS_DIR, moduleName, 'tasks.md');
  if (!fs.existsSync(tasksPath)) return false;

  let content = fs.readFileSync(tasksPath, 'utf8');

  // Reemplazar "## Tarea N: ..." bloque con nuevo estado
  const pattern = new RegExp(
    `(##\\s+(?:Tarea\\s+)?${taskId}[:\\s].+[\\s\\S]*?)(^[-*]\\s+Estado:\\s*)(.+)$`,
    'im'
  );
  content = content.replace(pattern, `$1$2${newStatus}`);

  fs.writeFileSync(tasksPath, content);
  return true;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const [,, cmd, moduleName, ...opts] = process.argv;
  const projectRoot = process.cwd();

  switch (cmd) {
    case 'create': {
      if (!moduleName) { console.error('Uso: spec-manager.cjs create <módulo> [--bugfix]'); process.exit(1); }
      const tipo = opts.includes('--bugfix') ? 'bugfix' : 'feature';
      const dir = createSpecFromTemplate(projectRoot, moduleName, tipo);
      console.log(`✅ Spec '${moduleName}' (${tipo}) creado en ${path.relative(projectRoot, dir)}`);
      break;
    }
    case 'waves': {
      if (!moduleName) { console.error('Uso: spec-manager.cjs waves <módulo>'); process.exit(1); }
      const tasksPath = path.join(projectRoot, SPECS_DIR, moduleName, 'tasks.md');
      if (!fs.existsSync(tasksPath)) { console.error(`tasks.md no encontrado para '${moduleName}'`); process.exit(1); }
      const tasks = parseTasks(fs.readFileSync(tasksPath, 'utf8'));
      const { waves } = buildWaves(tasks);
      console.log(`\nWaves para '${moduleName}' (${waves.length} waves):\n`);
      waves.forEach((wave, i) => {
        console.log(`Wave ${i + 1}:`);
        wave.forEach(t => console.log(`  [${t.id}] ${t.name} → agente: ${t.agent}`));
      });
      break;
    }
    case 'status': {
      if (!moduleName) { console.error('Uso: spec-manager.cjs status <módulo>'); process.exit(1); }
      const specDir = path.join(projectRoot, SPECS_DIR, moduleName);
      const status = getSpecStatus(specDir);
      if (!status) { console.log(`Spec '${moduleName}' no encontrado o sin tasks.md`); break; }
      console.log(`\nSpec: ${moduleName}`);
      console.log(`  Progreso: ${status.completed}/${status.total} (${status.percent}%)`);
      console.log(`  Bloqueadas: ${status.blocked} | En progreso: ${status.inProgress}`);
      if (status.next_wave.length > 0) {
        console.log(`  Próxima wave: ${status.next_wave.map(t => `[${t.id}] ${t.name}`).join(', ')}`);
      }
      if (status.all_done) console.log(`  ✅ COMPLETADO`);
      break;
    }
    case 'validate': {
      if (!moduleName) { console.error('Uso: spec-manager.cjs validate <módulo>'); process.exit(1); }
      const specDir = path.join(projectRoot, SPECS_DIR, moduleName);
      const result = validateSpec(specDir, moduleName);
      if (result.valid) {
        console.log(`✅ Spec '${moduleName}' válido`);
      } else {
        console.log(`❌ Spec '${moduleName}' inválido:`);
        result.issues.forEach(i => console.log(`  ⛔ ${i}`));
      }
      if (result.warnings.length > 0) {
        result.warnings.forEach(w => console.log(`  ⚠️  ${w}`));
      }
      break;
    }
    case 'list': {
      const specsPath = path.join(projectRoot, SPECS_DIR);
      if (!fs.existsSync(specsPath)) { console.log('Sin specs creados.'); break; }
      const modules = fs.readdirSync(specsPath, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name);
      console.log(`\nSpecs (${modules.length}):`);
      modules.forEach(m => {
        const specDir = path.join(specsPath, m);
        const status = getSpecStatus(specDir);
        const pct = status ? `${status.percent}%` : '?';
        console.log(`  ${m} — ${pct} completado`);
      });
      break;
    }
    default:
      console.log('Uso: node spec-manager.cjs [create | waves | status | validate | list]');
  }
}

module.exports = {
  parseTasks,
  buildWaves,
  getSpecStatus,
  validateSpec,
  createSpecFromTemplate,
  updateTaskStatus,
};
