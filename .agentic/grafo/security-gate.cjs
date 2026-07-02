/**
 * Security Gate — Step 3 of the enhanced aa: pipeline
 *
 * Brecha 2 cerrada: cuando el cambio toca archivos CRITICAL o SENSITIVE,
 * corre audit: seguridad automáticamente ANTES del Build step.
 *
 * v3.8.4 — MARK 6: Escudo de seguridad
 *   Además de los checks de tenant/JWT/auth (abajo), ahora escanea TODOS los
 *   archivos del changeset en busca de:
 *     - Secretos y credenciales filtradas (llaves privadas, tokens de proveedor,
 *       contraseñas, connection strings con password, JWT, Bearer literales).
 *     - PII (correos, tarjetas de crédito con validación Luhn).
 *     - Prompt-injection (instrucciones maliciosas escondidas en código/datos/comentarios).
 *     - Caracteres unicode invisibles (vector de inyección oculta).
 *   Robusto: redacta los secretos en el reporte, reporta número de línea, y
 *   descarta falsos positivos (placeholders, referencias a env, baja entropía).
 *
 * Si el gate detecta algo CRITICAL → STOP con reporte.
 * Si detecta HIGH/MEDIUM/LOW → WARN + continúa.
 */

'use strict';

const path = require('path');
const fs   = require('fs');

// ── Guards de escaneo (robustez) ──────────────────────────────────────────────
const MAX_SCAN_BYTES = 2_000_000; // no escanear archivos enormes (perf)
const NULL_BYTE      = String.fromCharCode(0); // marcador de binario

// ── Checks de negocio existentes (INTACTOS) ───────────────────────────────────
const SECURITY_PATTERNS = [
  {
    pattern: /tenant_id.*query|query.*tenant_id/i,
    negate:  true, // flag when tenant_id is NOT in query
    check:   (content, filename) => {
      // Routes that query data should always filter by tenant_id
      if (!filename.includes('route') && !filename.includes('handler')) return null;
      const hasQuery = /prisma\.\w+\.find(Many|First|Unique)/i.test(content);
      if (!hasQuery) return null;
      const hasTenantFilter = /tenant_id.*:\s*(?:tenantId|request\.authUser|req\.user)/i.test(content);
      if (!hasTenantFilter) {
        return {
          type:     'CROSS_TENANT_RISK',
          severity: 'CRITICAL',
          message:  'Database query without tenant_id filter — potential cross-tenant data access',
          file:     filename,
        };
      }
      return null;
    },
  },
  {
    check: (content, filename) => {
      // Detect "role='admin'" protecting cross-tenant access
      // admin in this system = tenant-level, not platform-level
      const crossTenantWithAdmin = /tenant_id.*param|param.*tenant_id/i.test(content) &&
        /role.*admin|admin.*role/i.test(content) &&
        !/superadmin/i.test(content);
      if (crossTenantWithAdmin) {
        return {
          type:     'ADMIN_CROSS_TENANT',
          severity: 'HIGH',
          message:  'Cross-tenant access protected only by admin role — admin is tenant-scoped, use superadmin for platform-level operations',
          file:     filename,
        };
      }
      return null;
    },
  },
  {
    check: (content, filename) => {
      // JWT verification bypass
      const bypass = /jwt\.(decode|verify)\s*\(/i.test(content) &&
        /debug|bypass|skip/i.test(content);
      if (bypass) {
        return {
          type:     'JWT_BYPASS',
          severity: 'CRITICAL',
          message:  'Potential JWT verification bypass detected',
          file:     filename,
        };
      }
      return null;
    },
  },
  {
    check: (content, filename) => {
      // Missing return after reply.status in auth middleware
      if (!filename.includes('auth') && !filename.includes('middleware')) return null;
      const hasReplyWithoutReturn = /reply\.status\(\d+\)\.send\(/.test(content) &&
        !/return reply\.status/.test(content);
      if (hasReplyWithoutReturn) {
        return {
          type:     'MISSING_RETURN',
          severity: 'HIGH',
          message:  'reply.status().send() without return — request may continue after auth rejection',
          file:     filename,
        };
      }
      return null;
    },
  },
];

// ── MARK 6: Patrones de secretos / credenciales ───────────────────────────────
// severity CRITICAL = bloquea; HIGH/MEDIUM/LOW = advierte.
const SECRET_PATTERNS = [
  { type:'PRIVATE_KEY',    severity:'CRITICAL', regex:/-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/, message:'Llave privada filtrada en el código' },
  { type:'AWS_ACCESS_KEY', severity:'CRITICAL', regex:/\bAKIA[0-9A-Z]{16}\b/, message:'AWS Access Key ID filtrada' },
  { type:'GITHUB_TOKEN',   severity:'CRITICAL', regex:/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, message:'Token de GitHub filtrado' },
  { type:'OPENAI_KEY',     severity:'CRITICAL', regex:/\bsk-[A-Za-z0-9]{20,}\b/, message:'Posible API key de OpenAI filtrada' },
  { type:'STRIPE_LIVE',    severity:'CRITICAL', regex:/\bsk_live_[0-9A-Za-z]{16,}\b/, message:'Stripe live secret key filtrada' },
  { type:'GOOGLE_API_KEY', severity:'CRITICAL', regex:/\bAIza[0-9A-Za-z_\-]{35}\b/, message:'Google API key filtrada' },
  { type:'SLACK_TOKEN',    severity:'CRITICAL', regex:/\bxox[baprs]-[0-9A-Za-z-]{10,}\b/, message:'Token de Slack filtrado' },
  { type:'DB_URL_PASSWORD',severity:'CRITICAL', regex:/\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|libsql|amqp):\/\/[^:\/\s]+:[^@\s]+@/i, message:'Connection string con contraseña embebida' },
  { type:'JWT',            severity:'HIGH',     regex:/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/, message:'JWT embebido en el código' },
  { type:'BEARER_LITERAL', severity:'HIGH',     regex:/\bBearer\s+[A-Za-z0-9._\-]{20,}/, message:'Token Bearer literal (usar variable de entorno)', envAware:true },
  { type:'GENERIC_SECRET', severity:'HIGH',     regex:/\b(?:api[_-]?key|apikey|secret(?:[_-]?key)?|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd)\b\s*[:=]\s*['"]([^'"]{8,})['"]/i, group:1, message:'Secreto asignado en texto plano (usar variable de entorno)', envAware:true },
];

// PII (menor severidad — advierte)
const PII_PATTERNS = [
  { type:'EMAIL',       severity:'LOW',    regex:/\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/, group:0, message:'Correo electrónico (PII) en el código', email:true },
  { type:'CREDIT_CARD', severity:'MEDIUM', regex:/\b(?:\d[ \-]?){13,19}\b/, group:0, message:'Posible número de tarjeta de crédito (PII)', luhn:true },
];

// ── MARK 6: Patrones de prompt-injection ──────────────────────────────────────
const INJECTION_PATTERNS = [
  { type:'IGNORE_INSTRUCTIONS', severity:'HIGH',     regex:/ignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|earlier|preceding)\s+instructions/i, message:'Intento de anular instrucciones previas (prompt injection)' },
  { type:'DISREGARD',           severity:'HIGH',     regex:/disregard\s+(?:all\s+)?(?:the\s+)?(?:previous|above|prior|system)/i, message:'Intento de descartar instrucciones/sistema (prompt injection)' },
  { type:'YOU_ARE_NOW',         severity:'HIGH',     regex:/you\s+are\s+now\s+(?:a|an|no\s+longer|the)\b/i, message:'Intento de redefinir el rol del agente (prompt injection)' },
  { type:'NEW_INSTRUCTIONS',    severity:'HIGH',     regex:/(?:new|updated)\s+instructions\s*:/i, message:'Inyección de "nuevas instrucciones"' },
  { type:'SYSTEM_PROMPT_SET',   severity:'HIGH',     regex:/(?:system\s*prompt|system\s*message)\s*[:=]/i, message:'Intento de fijar el system prompt (prompt injection)' },
  { type:'REVEAL_PROMPT',       severity:'CRITICAL', regex:/(?:reveal|show|print|repeat|expose|dump)\s+(?:your\s+|the\s+)?(?:full\s+)?(?:system\s+)?(?:prompt|instructions|system\s+message)/i, message:'Intento de extraer el system prompt/instrucciones' },
  { type:'HIDE_FROM_USER',      severity:'HIGH',     regex:/(?:do\s+not|don't)\s+(?:tell|inform|mention\s+to|show)\s+the\s+user|keep\s+this\s+(?:secret|hidden)\s+from/i, message:'Instrucción para ocultar información al usuario (prompt injection)' },
  { type:'JAILBREAK',           severity:'HIGH',     regex:/\b(?:jailbreak|DAN\s+mode|developer\s+mode\s+enabled|act\s+as\s+(?:if\s+you|an?\s+unrestricted))/i, message:'Marcador de jailbreak' },
  { type:'EXFILTRATION',        severity:'CRITICAL', regex:/(?:send|post|exfiltrate|upload|leak|forward)\s+(?:the\s+)?(?:contents?|data|secrets?|tokens?|credentials?|files?|env)\s+to\s+https?:\/\//i, message:'Instrucción de exfiltración de datos a una URL' },
  { type:'DISABLE_GUARDRAILS',  severity:'HIGH',     regex:/(?:ignore|bypass|disable|turn\s+off)\s+(?:your\s+|all\s+)?(?:safety|guardrails?|filters?|restrictions?|rules)/i, message:'Intento de desactivar salvaguardas' },
];

// Rango de caracteres unicode invisibles (zero-width + BOM + word-joiner)
const INVISIBLE_UNICODE = /[​‌‍⁠﻿]/;

// ── Helpers de robustez ───────────────────────────────────────────────────────

function redact(s) {
  if (s == null) return '';
  s = String(s);
  if (s.length <= 8) return (s[0] || '') + '****';
  return s.slice(0, 4) + '****' + s.slice(-2);
}

function looksLikePlaceholderOrEnv(line, val) {
  // Referencia a variable de entorno o interpolación → no es un secreto hardcodeado
  if (/process\.env|import\.meta\.env|os\.environ|getenv|\$\{|\benv\[|%[A-Z_]+%/.test(line)) return true;
  const v = String(val || '').trim();
  if (v.length < 8) return true;
  if (/^(.)\1+$/.test(v)) return true; // baja entropía (todo el mismo caracter)
  if (/(your[_-]?|example|placeholder|changeme|change_me|dummy|sample|redacted|xxxx|<[^>]*>|\{\{.*\}\}|\.\.\.|foo|bar|test[_-]?key|my[_-]?secret)/i.test(v)) return true;
  if (/^(null|undefined|none|true|false)$/i.test(v)) return true;
  return false;
}

function isExampleEmail(val) {
  return /@(?:example|test|sample|domain|email|acme|localhost)\.(?:com|org|net|test|local)$/i.test(String(val || '')) ||
         /^(?:you|user|name|email|test|admin|foo)@/i.test(String(val || ''));
}

function luhnValid(num) {
  const digits = String(num).replace(/[^\d]/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = parseInt(digits[i], 10);
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d; alt = !alt;
  }
  return sum % 10 === 0;
}

// ── MARK 6: escaneo de escudo (todos los archivos) ────────────────────────────

function scanShield(content, filename) {
  const findings = [];
  if (!content || content.length > MAX_SCAN_BYTES) return findings;
  if (content.indexOf(NULL_BYTE) !== -1) return findings; // binario → skip

  const lines = content.split(/\r?\n/);
  const seen = new Set();
  const push = (f) => {
    const key = f.type + ':' + f.line;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ ...f, file: filename });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const lineNo = i + 1;

    // Secretos / credenciales
    for (const det of SECRET_PATTERNS) {
      const m = line.match(det.regex);
      if (!m) continue;
      const val = det.group != null ? m[det.group] : m[0];
      if (det.envAware && looksLikePlaceholderOrEnv(line, val)) continue;
      push({ type: det.type, severity: det.severity, message: det.message, line: lineNo, sample: redact(val) });
    }

    // PII
    for (const det of PII_PATTERNS) {
      const m = line.match(det.regex);
      if (!m) continue;
      const val = det.group != null ? m[det.group] : m[0];
      if (det.luhn && !luhnValid(val)) continue;
      if (det.email && isExampleEmail(val)) continue;
      push({ type: det.type, severity: det.severity, message: det.message, line: lineNo, sample: redact(val) });
    }

    // Prompt injection
    for (const det of INJECTION_PATTERNS) {
      if (det.regex.test(line)) {
        push({ type: det.type, severity: det.severity, message: det.message, line: lineNo });
      }
    }

    // Unicode invisible (vector de inyección oculta)
    if (INVISIBLE_UNICODE.test(line)) {
      push({ type: 'HIDDEN_UNICODE', severity: 'HIGH', message: 'Caracteres invisibles detectados (posible inyección oculta)', line: lineNo });
    }
  }

  return findings;
}

// ── Clasificación de riesgo (INTACTA) ─────────────────────────────────────────

function classifyFileRisk(filePath) {
  const fp = filePath.replace(/\\/g, '/').toLowerCase();
  if (fp.includes('auth') || fp.includes('middleware') || fp.includes('.env') || fp.includes('secret')) return 'CRITICAL';
  if (fp.includes('routes/') || fp.includes('lib/') || fp.includes('prisma')) return 'SENSITIVE';
  if (fp.includes('tests/') || fp.includes('utils/') || fp.includes('constants')) return 'FREE';
  return 'NORMAL';
}

function scanLegacyPatterns(content, filename) {
  const findings = [];
  SECURITY_PATTERNS.forEach(p => {
    const result = p.check(content, filename);
    if (result) findings.push(result);
  });
  return findings;
}

function safeRead(full) {
  try {
    const stat = fs.statSync(full);
    if (!stat.isFile() || stat.size > MAX_SCAN_BYTES) return null;
    return fs.readFileSync(full, 'utf8');
  } catch { return null; }
}

// ── Gate principal ────────────────────────────────────────────────────────────

function runSecurityGate(files, projectRoot) {
  projectRoot = projectRoot || process.cwd();
  const allFindings = [];
  const scannedFiles = [];
  const sensitiveFiles = [];

  (files || []).forEach(file => {
    const full = path.isAbsolute(file) ? file : path.join(projectRoot, file);
    const content = safeRead(full);
    if (content == null) return;
    const filename = path.basename(full);
    scannedFiles.push(file);

    // Escudo (secretos/PII/injection) → en TODOS los archivos
    allFindings.push(...scanShield(content, filename));

    // Checks de negocio (tenant/JWT/auth) → solo CRITICAL/SENSITIVE
    const risk = classifyFileRisk(file);
    if (risk === 'CRITICAL' || risk === 'SENSITIVE') {
      sensitiveFiles.push({ file, risk });
      allFindings.push(...scanLegacyPatterns(content, filename));
    }
  });

  const fmt = (f) => `[${f.type}] ${f.message}` +
    (f.file ? ` (${f.file}${f.line ? ':' + f.line : ''})` : '') +
    (f.sample ? ` → ${f.sample}` : '');

  const critical = allFindings.filter(f => f.severity === 'CRITICAL');
  const high     = allFindings.filter(f => f.severity === 'HIGH');
  const lowmed   = allFindings.filter(f => f.severity === 'MEDIUM' || f.severity === 'LOW');

  if (critical.length > 0) {
    return {
      passed:         false,
      findings:       allFindings,
      scanned:        scannedFiles,
      sensitive_files: sensitiveFiles,
      message: `SECURITY GATE STOP: ${critical.length} hallazgo(s) CRÍTICO(s):\n` +
        critical.map(f => `  🔴 ${fmt(f)}`).join('\n') +
        (high.length ? `\n  (+ ${high.length} HIGH, revisar)` : ''),
    };
  }

  if (allFindings.length === 0 && sensitiveFiles.length === 0) {
    return {
      passed: true,
      reason: 'No critical/sensitive files in changeset',
      scanned: scannedFiles,
      message: `SECURITY GATE PASS — ${scannedFiles.length} archivo(s) escaneado(s), sin problemas`,
    };
  }

  const warnLines = [...high, ...lowmed];
  return {
    passed:          true,
    warn:            warnLines.length > 0,
    findings:        allFindings,
    scanned:         scannedFiles,
    sensitive_files: sensitiveFiles,
    message: warnLines.length > 0
      ? `SECURITY GATE WARN: ${high.length} HIGH / ${lowmed.length} MEDIUM-LOW — revisar antes de continuar:\n` +
        warnLines.map(f => `  🟡 ${fmt(f)}`).join('\n')
      : `SECURITY GATE PASS — ${scannedFiles.length} archivo(s) escaneado(s), sin problemas`,
  };
}

if (require.main === module) {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.log('Uso: node security-gate.cjs archivo1.ts archivo2.ts ...');
    console.log('Escanea: secretos/credenciales, PII, prompt-injection + checks de tenant/JWT/auth.');
    process.exit(0);
  }
  const result = runSecurityGate(files, process.cwd());
  console.log(result.passed ? (result.warn ? '⚠️  ' : '✅ ') + result.message : '🛑 ' + result.message);
  process.exit(result.passed ? 0 : 1);
}

module.exports = { runSecurityGate, classifyFileRisk, scanShield };
