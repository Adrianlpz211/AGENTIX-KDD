/**
 * Agentic KDD — Telemetry v1.0
 * Brecha (c): Observabilidad — requisito duro de L4
 *
 * Sin telemetría no hay L4. L4 (Approver) exige que el usuario pueda
 * auditar la ejecución. La aprobación a nivel de objetivo requiere trazas
 * inmutables de qué hizo el agente y por qué.
 *
 * Implementa:
 *   - JSONL append-only en .agentic/telemetria/ (auditable en git)
 *   - Spans con: timestamp, agente, fase, acción, resultado, duración
 *   - Export opcional a Langfuse (self-hosted MIT, ~21k ★)
 *   - STOPs siempre registrados con razón completa
 *   - Memory reads/writes registrados (cuándo se usó recall, qué se recordó)
 *
 * La filosofía: cada ciclo genera un archivo trace_[ciclo_id].jsonl
 * Cada línea es un span. El archivo completo es la auditoría del ciclo.
 * Git lo versiona. El equipo lo puede revisar. El EU AI Act lo exige.
 *
 * Uso:
 *   const { startSpan, endSpan, recordStop, recordMemoryRead } = require('./telemetry.cjs');
 *   const span = startSpan({ agent: 'Analista', phase: 'plan', task: 'fix auth' });
 *   // ... work ...
 *   endSpan(span, { outcome: 'PASS', files_touched: ['auth.ts'] });
 *
 * CLI:
 *   node telemetry.cjs view [ciclo_id]   — ver trazas de un ciclo
 *   node telemetry.cjs summary           — resumen de telemetría
 *   node telemetry.cjs export langfuse   — exportar a Langfuse
 */

'use strict';

const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');

const TELEMETRIA_DIR = '.agentic/telemetria';
const MAX_FILE_SIZE  = 5 * 1024 * 1024; // 5MB por archivo

// ─── ESTRUCTURA DE UN SPAN ────────────────────────────────────────────────────
/**
 * Span de telemetría. Inmutable una vez cerrado.
 *
 * {
 *   span_id:     "abc123",
 *   trace_id:    "ciclo_xyz",      // = ciclo_id del ciclo actual
 *   parent_id:   "def456",         // null si es root span
 *   timestamp:   "2026-06-24T...", // ISO8601 UTC
 *   duration_ms: 1234,             // null si el span no cerró
 *   agent:       "Analista",       // Orquestador|Analista|Dev|QA|Memoria|ContractGuard
 *   phase:       "plan",           // plan|build|tdd|qa|preservation|review|memory|creative
 *   action:      "recall",         // recall|remember|decide|execute|verify|stop|warn
 *   input:       { query: "..." }, // lo que recibió
 *   output:      { results: 3 },   // lo que produjo
 *   outcome:     "PASS",           // PASS|FAIL|STOP|WARN|SKIP
 *   metadata:    {}
 * }
 */

// ─── GESTIÓN DE ARCHIVOS ──────────────────────────────────────────────────────

function ensureDir(projectRoot) {
  const dir = path.join(projectRoot, TELEMETRIA_DIR);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getTraceFile(projectRoot, traceId) {
  const dir = ensureDir(projectRoot);
  return path.join(dir, `trace_${traceId || 'session'}.jsonl`);
}

function appendLine(filePath, obj) {
  try {
    const line = JSON.stringify(obj) + '\n';
    fs.appendFileSync(filePath, line, 'utf8');
    return true;
  } catch { return false; }
}

function readTrace(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    return fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
  } catch { return []; }
}

// ─── SPAN MANAGEMENT ─────────────────────────────────────────────────────────

const activeSpans = {};

/**
 * Inicia un span de telemetría.
 * @returns span object con span_id
 */
function startSpan(params = {}, projectRoot) {
  const spanId  = crypto.randomBytes(4).toString('hex');
  const traceId = params.trace_id || params.ciclo_id || 'session';

  const span = {
    span_id:   spanId,
    trace_id:  traceId,
    parent_id: params.parent_id || null,
    timestamp: new Date().toISOString(),
    _start_ms: Date.now(),
    agent:     params.agent  || 'unknown',
    phase:     params.phase  || 'unknown',
    action:    params.action || 'execute',
    input:     params.input  || {},
    outcome:   null,
    output:    null,
    metadata:  params.metadata || {},
  };

  activeSpans[spanId] = { span, projectRoot: projectRoot || process.cwd() };

  // Escribir span abierto (para auditoría de crashes)
  const file = getTraceFile(span._start_ms && projectRoot, traceId);
  try {
    const { _start_ms, ...logSpan } = span;
    appendLine(file, { ...logSpan, status: 'open' });
  } catch {}

  return span;
}

/**
 * Cierra un span con resultado.
 */
function endSpan(span, result = {}, projectRoot) {
  if (!span || !span.span_id) return;

  const root = projectRoot || activeSpans[span.span_id]?.projectRoot || process.cwd();
  const durationMs = Date.now() - (span._start_ms || Date.now());

  const closedSpan = {
    span_id:     span.span_id,
    trace_id:    span.trace_id,
    parent_id:   span.parent_id,
    timestamp:   span.timestamp,
    closed_at:   new Date().toISOString(),
    duration_ms: durationMs,
    agent:       span.agent,
    phase:       span.phase,
    action:      span.action,
    input:       span.input,
    output:      result.output || {},
    outcome:     result.outcome || 'PASS',
    files_touched: result.files_touched || [],
    metadata:    { ...span.metadata, ...result.metadata },
  };

  const file = getTraceFile(root, span.trace_id);
  appendLine(file, closedSpan);

  delete activeSpans[span.span_id];
  return closedSpan;
}

// ─── HELPERS PARA EVENTOS ESPECÍFICOS ────────────────────────────────────────

function recordStop(reason, context = {}, projectRoot) {
  const root = projectRoot || process.cwd();
  const file = getTraceFile(root, context.ciclo_id || 'session');

  const stopEvent = {
    span_id:   crypto.randomBytes(4).toString('hex'),
    trace_id:  context.ciclo_id || 'session',
    timestamp: new Date().toISOString(),
    agent:     context.agent || 'Harness',
    phase:     context.phase || 'gate',
    action:    'stop',
    outcome:   'STOP',
    reason,
    context,
  };

  appendLine(file, stopEvent);
  return stopEvent;
}

function recordMemoryRead(query, results = [], context = {}, projectRoot) {
  const root = projectRoot || process.cwd();
  const file = getTraceFile(root, context.ciclo_id || 'session');

  appendLine(file, {
    span_id:      crypto.randomBytes(4).toString('hex'),
    trace_id:     context.ciclo_id || 'session',
    timestamp:    new Date().toISOString(),
    agent:        context.agent || 'Analista',
    phase:        context.phase || 'plan',
    action:       'recall',
    outcome:      'PASS',
    input:        { query },
    output:       { results_count: results.length, top_result: results[0]?.titulo },
    tokens_saved: context.tokens_saved || null,
  });
}

function recordMemoryWrite(entry, result = {}, context = {}, projectRoot) {
  const root = projectRoot || process.cwd();
  const file = getTraceFile(root, context.ciclo_id || 'session');

  appendLine(file, {
    span_id:   crypto.randomBytes(4).toString('hex'),
    trace_id:  context.ciclo_id || 'session',
    timestamp: new Date().toISOString(),
    agent:     context.agent || 'Memoria',
    phase:     context.phase || 'memory',
    action:    'remember',
    outcome:   result.ok ? 'PASS' : 'FAIL',
    input:     { entry: (entry || '').substring(0, 100) },
    output:    { id: result.id, reason: result.reason },
  });
}

function recordDecision(decision, context = {}, projectRoot) {
  const root = projectRoot || process.cwd();
  const file = getTraceFile(root, context.ciclo_id || 'session');

  appendLine(file, {
    span_id:   crypto.randomBytes(4).toString('hex'),
    trace_id:  context.ciclo_id || 'session',
    timestamp: new Date().toISOString(),
    agent:     'AutonomousDecision',
    phase:     context.phase || 'analysis',
    action:    'decide',
    outcome:   decision.decision,
    input:     { files: context.files, task: context.task },
    output:    { decision: decision.decision, summary: decision.summary },
    blast_radius: decision.blast?.level,
    reasons:   decision.reasons,
  });
}

// ─── EXPORT A LANGFUSE ────────────────────────────────────────────────────────
/**
 * Export opcional a Langfuse self-hosted.
 * Config en .agentic/config.md: langfuse_host, langfuse_pk, langfuse_sk
 */
async function exportToLangfuse(traceId, projectRoot) {
  projectRoot = projectRoot || process.cwd();

  // Leer config de Langfuse
  let langfuseConfig = null;
  try {
    const config = fs.readFileSync(path.join(projectRoot, '.agentic/config.md'), 'utf8');
    const host = config.match(/langfuse_host:\s*(.+)/)?.[1]?.trim();
    const pk   = config.match(/langfuse_pk:\s*(.+)/)?.[1]?.trim();
    const sk   = config.match(/langfuse_sk:\s*(.+)/)?.[1]?.trim();
    if (host && pk && sk) langfuseConfig = { host, pk, sk };
  } catch {}

  if (!langfuseConfig) {
    return { ok: false, reason: 'Langfuse not configured. Add langfuse_host/pk/sk to .agentic/config.md' };
  }

  const dir  = ensureDir(projectRoot);
  const file = path.join(dir, `trace_${traceId}.jsonl`);
  const spans = readTrace(file);

  if (spans.length === 0) return { ok: false, reason: 'No spans found' };

  // Enviar a Langfuse API (OTEL format)
  try {
    const body = {
      batch: spans.map(span => ({
        id:         span.span_id,
        timestamp:  span.timestamp,
        type:       'span',
        body: {
          id:           span.span_id,
          traceId:      span.trace_id,
          name:         `${span.agent}.${span.action}`,
          startTime:    span.timestamp,
          endTime:      span.closed_at || span.timestamp,
          metadata:     { ...span.metadata, outcome: span.outcome },
          input:        span.input,
          output:       span.output,
          statusMessage:span.outcome === 'STOP' ? span.reason : null,
        },
      })),
    };

    const resp = await fetch(`${langfuseConfig.host}/api/public/ingestion`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${Buffer.from(`${langfuseConfig.pk}:${langfuseConfig.sk}`).toString('base64')}`,
      },
      body: JSON.stringify(body),
    });

    return { ok: resp.ok, status: resp.status, spans_exported: spans.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── VIEW & SUMMARY ───────────────────────────────────────────────────────────

function viewTrace(traceId, projectRoot) {
  projectRoot = projectRoot || process.cwd();
  const dir = path.join(projectRoot, TELEMETRIA_DIR);

  if (!fs.existsSync(dir)) return [];

  let file;
  if (traceId) {
    file = path.join(dir, `trace_${traceId}.jsonl`);
  } else {
    // Último archivo
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort().reverse();
    if (!files.length) return [];
    file = path.join(dir, files[0]);
  }

  return readTrace(file);
}

function getSummary(projectRoot) {
  projectRoot = projectRoot || process.cwd();
  const dir = path.join(projectRoot, TELEMETRIA_DIR);

  if (!fs.existsSync(dir)) return { traces: 0, total_spans: 0, stops: 0 };

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
  let totalSpans = 0, stops = 0, recalls = 0, remembers = 0;

  files.forEach(f => {
    const spans = readTrace(path.join(dir, f));
    totalSpans += spans.length;
    stops      += spans.filter(s => s.outcome === 'STOP').length;
    recalls    += spans.filter(s => s.action === 'recall').length;
    remembers  += spans.filter(s => s.action === 'remember').length;
  });

  return {
    traces:    files.length,
    total_spans: totalSpans,
    stops,
    recalls,
    remembers,
    avg_spans_per_trace: files.length > 0 ? Math.round(totalSpans / files.length) : 0,
  };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const [,, cmd, arg] = process.argv;
  const projectRoot = process.cwd();

  switch (cmd) {
    case 'view': {
      const spans = viewTrace(arg, projectRoot);
      if (!spans.length) { console.log('\n  No traces found.\n'); break; }
      console.log(`\n  Trace ${arg || 'latest'} — ${spans.length} spans\n`);
      spans.forEach(s => {
        const icon = s.outcome === 'STOP' ? '🛑' : s.outcome === 'WARN' ? '⚠️' : '✅';
        const dur  = s.duration_ms ? `${s.duration_ms}ms` : '';
        console.log(`  ${icon} ${s.agent}.${s.action} [${s.phase}] ${dur}`);
        if (s.outcome === 'STOP') console.log(`     STOP: ${s.reason}`);
      });
      console.log('');
      break;
    }

    case 'summary': {
      const s = getSummary(projectRoot);
      console.log('\n  Telemetry Summary');
      console.log(`  Trace files:  ${s.traces}`);
      console.log(`  Total spans:  ${s.total_spans}`);
      console.log(`  STOPs:        ${s.stops}`);
      console.log(`  Recalls:      ${s.recalls}`);
      console.log(`  Remembers:    ${s.remembers}\n`);
      break;
    }

    case 'export':
      if (arg === 'langfuse') {
        exportToLangfuse(process.argv[4], projectRoot)
          .then(r => console.log(r.ok ? `✅ Exported ${r.spans_exported} spans` : `❌ ${r.reason || r.error}`));
      }
      break;

    default:
      console.log('Uso: node telemetry.cjs [view [trace_id] | summary | export langfuse <trace_id>]');
  }
}

module.exports = {
  startSpan, endSpan,
  recordStop, recordMemoryRead, recordMemoryWrite, recordDecision,
  exportToLangfuse, viewTrace, getSummary,
};
