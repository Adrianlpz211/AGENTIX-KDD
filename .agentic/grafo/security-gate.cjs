/**
 * Security Gate — Step 3 of the enhanced aa: pipeline
 *
 * Brecha 2 cerrada: cuando el cambio toca archivos CRITICAL o SENSITIVE,
 * corre audit: seguridad automáticamente ANTES del Build step.
 *
 * Si el audit detecta vulnerabilidades → STOP con reporte.
 * Si el archivo es CRITICAL pero no hay vulnerabilidades → WARN + continúa.
 */

'use strict';

const path = require('path');
const fs   = require('fs');

// Security patterns to check in changed files
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

function classifyFileRisk(filePath) {
  const fp = filePath.replace(/\\/g, '/').toLowerCase();
  if (fp.includes('auth') || fp.includes('middleware') || fp.includes('.env') || fp.includes('secret')) return 'CRITICAL';
  if (fp.includes('routes/') || fp.includes('lib/') || fp.includes('prisma')) return 'SENSITIVE';
  if (fp.includes('tests/') || fp.includes('utils/') || fp.includes('constants')) return 'FREE';
  return 'NORMAL';
}

function scanFile(filePath, projectRoot) {
  const full = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
  if (!fs.existsSync(full)) return [];

  const content = fs.readFileSync(full, 'utf8');
  const filename = path.basename(full);
  const findings = [];

  SECURITY_PATTERNS.forEach(p => {
    const result = p.check(content, filename);
    if (result) findings.push(result);
  });

  return findings;
}

function runSecurityGate(files, projectRoot) {
  projectRoot = projectRoot || process.cwd();
  const allFindings = [];
  const criticalFiles = [];

  (files || []).forEach(file => {
    const risk = classifyFileRisk(file);
    if (risk === 'CRITICAL' || risk === 'SENSITIVE') {
      criticalFiles.push({ file, risk });
      const findings = scanFile(file, projectRoot);
      allFindings.push(...findings);
    }
  });

  if (criticalFiles.length === 0) {
    return { passed: true, reason: 'No critical/sensitive files in changeset' };
  }

  const critical = allFindings.filter(f => f.severity === 'CRITICAL');
  const high     = allFindings.filter(f => f.severity === 'HIGH');

  if (critical.length > 0) {
    return {
      passed:        false,
      findings:      allFindings,
      critical_files: criticalFiles,
      message: `SECURITY GATE STOP: ${critical.length} critical finding(s):\n` +
        critical.map(f => `  🔴 [${f.type}] ${f.message} (${f.file})`).join('\n'),
    };
  }

  return {
    passed:         true,
    warn:           high.length > 0,
    findings:       allFindings,
    critical_files: criticalFiles,
    message: high.length > 0
      ? `SECURITY GATE WARN: ${high.length} high finding(s) — review before deploying:\n` +
        high.map(f => `  🟡 [${f.type}] ${f.message}`).join('\n')
      : `SECURITY GATE PASS — ${criticalFiles.length} sensitive file(s) scanned, no issues found`,
  };
}

if (require.main === module) {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.log('Usage: node security-gate.cjs file1.ts file2.ts ...');
    process.exit(0);
  }
  const result = runSecurityGate(files, process.cwd());
  console.log(result.passed ? (result.warn ? '⚠️ ' : '✅ ') + result.message : '🛑 ' + result.message);
  process.exit(result.passed ? 0 : 1);
}

module.exports = { runSecurityGate, classifyFileRisk };
