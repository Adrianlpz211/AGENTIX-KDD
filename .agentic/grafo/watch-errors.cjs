#!/usr/bin/env node
'use strict';

/**
 * Agentic KDD — Watch Errors
 * Observa la salida del servidor de desarrollo y registra errores automáticamente en memoria KDD.
 *
 * Uso:
 *   npm run dev 2>&1 | node .agentic/grafo/watch-errors.cjs
 *   npm run build 2>&1 | node .agentic/grafo/watch-errors.cjs
 *
 * O agrega a package.json:
 *   "dev:kdd": "npm run dev 2>&1 | node .agentic/grafo/watch-errors.cjs"
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.join(__dirname, '..', '..');
const ERRORES_PATH = path.join(ROOT, '.agentic', 'memoria', 'errores.md');
const GRAFO_PATH = path.join(ROOT, '.agentic', 'grafo', 'grafo.cjs');
const LOG_PATH = path.join(ROOT, '_output', 'watch-errors.log');

// ─── Patrones de error por stack ──────────────────────────────────────────────
const ERROR_PATTERNS = [
  // TypeScript
  { regex: /error TS(\d+): (.+)/i,           tipo: 'typescript',  extraer: (m) => ({ codigo: m[1], mensaje: m[2] }) },
  { regex: /Type '(.+)' is not assignable/i,  tipo: 'typescript',  extraer: (m) => ({ mensaje: m[0].slice(0,120) }) },
  { regex: /Property '(.+)' does not exist/i, tipo: 'typescript',  extraer: (m) => ({ mensaje: m[0].slice(0,120) }) },
  { regex: /Cannot find module '(.+)'/i,      tipo: 'typescript',  extraer: (m) => ({ mensaje: m[0].slice(0,120), modulo: m[1] }) },

  // Next.js / React
  { regex: /Error: (.+)\n.*at (.+\.tsx?)/i,   tipo: 'nextjs',      extraer: (m) => ({ mensaje: m[1], archivo: m[2] }) },
  { regex: /Unhandled Runtime Error\n(.+)/i,  tipo: 'runtime',     extraer: (m) => ({ mensaje: m[1] }) },
  { regex: /Module not found: Error: (.+)/i,  tipo: 'module',      extraer: (m) => ({ mensaje: m[1] }) },
  { regex: /SyntaxError: (.+)/i,              tipo: 'syntax',      extraer: (m) => ({ mensaje: m[1] }) },

  // Node.js / Express
  { regex: /UnhandledPromiseRejection: (.+)/i, tipo: 'promise',    extraer: (m) => ({ mensaje: m[1] }) },
  { regex: /ECONNREFUSED (\S+)/i,              tipo: 'connection', extraer: (m) => ({ mensaje: 'Connection refused: '+m[1] }) },
  { regex: /ENOENT: no such file.+?'(.+?)'/i,  tipo: 'filesystem', extraer: (m) => ({ mensaje: 'File not found: '+m[1] }) },

  // SQL / Supabase / Prisma
  { regex: /invalid input syntax for type (.+)/i,     tipo: 'database', extraer: (m) => ({ mensaje: m[0].slice(0,120) }) },
  { regex: /relation "(.+)" does not exist/i,         tipo: 'database', extraer: (m) => ({ mensaje: 'Tabla no existe: '+m[1] }) },
  { regex: /null value in column "(.+)" violates/i,   tipo: 'database', extraer: (m) => ({ mensaje: 'Campo requerido: '+m[1] }) },
  { regex: /duplicate key value violates unique/i,    tipo: 'database', extraer: (m) => ({ mensaje: m[0].slice(0,80) }) },
  { regex: /PrismaClientKnownRequestError.+?code: '(.+?)'/i, tipo: 'prisma', extraer: (m) => ({ mensaje: 'Prisma error '+m[1] }) },

  // Laravel / PHP
  { regex: /ErrorException: (.+)/i,           tipo: 'php',         extraer: (m) => ({ mensaje: m[1] }) },
  { regex: /Illuminate\\(.+): (.+)/i,          tipo: 'laravel',     extraer: (m) => ({ clase: m[1], mensaje: m[2] }) },
  { regex: /SQLSTATE\[(.+)\]: (.+)/i,          tipo: 'database',    extraer: (m) => ({ codigo: m[1], mensaje: m[2].slice(0,100) }) },

  // Python / FastAPI
  { regex: /pydantic.error_wrappers.ValidationError/i, tipo: 'validation', extraer: (m) => ({ mensaje: 'Pydantic validation error' }) },
  { regex: /sqlalchemy.exc.(.+): (.+)/i,               tipo: 'database',   extraer: (m) => ({ clase: m[1], mensaje: m[2].slice(0,100) }) },

  // Genérico
  { regex: /\[ERROR\] (.+)/i,                 tipo: 'generic',     extraer: (m) => ({ mensaje: m[1] }) },
  { regex: /error: (.{10,120})/i,             tipo: 'generic',     extraer: (m) => ({ mensaje: m[1] }) },
];

// ─── Detectar área del proyecto basada en el error ────────────────────────────
function detectarArea(linea) {
  const lower = linea.toLowerCase();
  if (lower.includes('auth') || lower.includes('login') || lower.includes('session')) return 'auth';
  if (lower.includes('api') || lower.includes('route') || lower.includes('endpoint')) return 'api';
  if (lower.includes('database') || lower.includes('sql') || lower.includes('prisma') || lower.includes('supabase')) return 'database';
  if (lower.includes('component') || lower.includes('.tsx') || lower.includes('.jsx')) return 'frontend';
  if (lower.includes('middleware')) return 'middleware';
  if (lower.includes('payment') || lower.includes('pago') || lower.includes('stripe')) return 'payments';
  if (lower.includes('user') || lower.includes('usuario')) return 'users';
  return 'global';
}

// ─── Extraer archivo y línea del error ────────────────────────────────────────
function extraerUbicacion(lineas) {
  for (const linea of lineas) {
    const m = linea.match(/at .+?\((.+?):(\d+):\d+\)/) ||
              linea.match(/→ (.+?):(\d+)/) ||
              linea.match(/in (.+\.(?:ts|tsx|js|jsx|py|php)):(\d+)/);
    if (m) return `${m[1]}:${m[2]}`;
  }
  return null;
}

// ─── Verificar si el error ya está en memoria ─────────────────────────────────
function yaExisteEnMemoria(titulo) {
  if (!fs.existsSync(ERRORES_PATH)) return false;
  const contenido = fs.readFileSync(ERRORES_PATH, 'utf8');
  // Comparar por similaridad de título (primeras 40 chars)
  const tituloShort = titulo.slice(0, 40).toLowerCase();
  return contenido.toLowerCase().includes(tituloShort);
}

// ─── Registrar error en errores.md ────────────────────────────────────────────
function registrarError(errorInfo) {
  const { tipo, mensaje, area, ubicacion, raw } = errorInfo;
  const fecha = new Date().toISOString().split('T')[0];
  const hora = new Date().toTimeString().split(' ')[0];

  // Título limpio
  const titulo = mensaje.slice(0, 60).replace(/[#\n\r]/g, '').trim();

  if (yaExisteEnMemoria(titulo)) {
    log(`⏭  Ya existe en memoria: ${titulo.slice(0, 40)}`);
    return false;
  }

  const entrada = `
## ${fecha} [${tipo.toUpperCase()}] ${titulo}
Área: ${area}
Confianza: BAJA
Aplicado: 0
Útil: 0
Estado: ACTIVO
Última validación: ${fecha}
Creado: ${fecha}
Origen: watch-errors — detectado ${hora}
Tipo: ${tipo}
Error: ${mensaje.slice(0, 200)}
${ubicacion ? `Ubicación: ${ubicacion}` : ''}
Solución: [pendiente — cuando lo resuelvas corre: aa: aprende — error: ${titulo.slice(0, 40)}]
Raw: ${(raw||'').slice(0, 150).replace(/\n/g, ' ')}
`;

  // Asegurar que el archivo existe
  if (!fs.existsSync(ERRORES_PATH)) {
    fs.mkdirSync(path.dirname(ERRORES_PATH), { recursive: true });
    fs.writeFileSync(ERRORES_PATH, '# Errores — Agentic KDD\n\n', 'utf8');
  }

  fs.appendFileSync(ERRORES_PATH, entrada, 'utf8');
  log(`✓ Error registrado: [${tipo}] ${titulo.slice(0, 50)}`);
  return true;
}

// ─── Sincronizar grafo ─────────────────────────────────────────────────────────
function sincronizarGrafo() {
  if (!fs.existsSync(GRAFO_PATH)) return;
  try {
    require('child_process').execSync(`node "${GRAFO_PATH}" sync`, {
      stdio: 'pipe', cwd: ROOT, timeout: 10000
    });
    log('✓ Grafo sincronizado');
  } catch(e) {
    log('⚠ Sync fallido (continúa sin sincronizar)');
  }
}

// ─── Log ──────────────────────────────────────────────────────────────────────
function log(msg) {
  const ts = new Date().toTimeString().split(' ')[0];
  const line = `[KDD ${ts}] ${msg}`;
  // Mostrar en consola (pass-through)
  process.stderr.write(line + '\n');
  // Guardar en log file
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, line + '\n');
  } catch(e) {}
}

// ─── Procesador de líneas ─────────────────────────────────────────────────────
const buffer = [];
let erroresRegistrados = 0;
let syncPendiente = false;
let syncTimer = null;

function procesarLinea(linea) {
  // Pass-through — mostrar la línea original siempre
  process.stdout.write(linea + '\n');

  // Guardar contexto (últimas 5 líneas)
  buffer.push(linea);
  if (buffer.length > 5) buffer.shift();

  // Intentar cada patrón
  for (const patron of ERROR_PATTERNS) {
    const match = linea.match(patron.regex);
    if (match) {
      try {
        const datos = patron.extraer(match);
        const errorInfo = {
          tipo: patron.tipo,
          mensaje: datos.mensaje || datos.codigo || match[0].slice(0, 120),
          area: detectarArea(linea + ' ' + buffer.join(' ')),
          ubicacion: extraerUbicacion(buffer),
          raw: buffer.join(' ')
        };

        if (registrarError(errorInfo)) {
          erroresRegistrados++;
          // Sincronizar grafo después de 3 segundos de inactividad
          if (syncTimer) clearTimeout(syncTimer);
          syncTimer = setTimeout(() => {
            sincronizarGrafo();
            syncTimer = null;
          }, 3000);
        }
      } catch(e) {
        // Nunca interrumpir el flujo por un error del watch
      }
      break; // Solo el primer patrón que coincida
    }
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
log('Agentic KDD Watch — escuchando errores...');
log(`Registrando en: .agentic/memoria/errores.md`);
log('Ctrl+C para detener\n');

const rl = readline.createInterface({
  input: process.stdin,
  terminal: false
});

rl.on('line', procesarLinea);

rl.on('close', () => {
  if (erroresRegistrados > 0) {
    log(`\n✅ Sesión terminada — ${erroresRegistrados} errores registrados en memoria KDD`);
    sincronizarGrafo();
  } else {
    log('\n✅ Sesión terminada — sin errores nuevos detectados');
  }
});

process.on('SIGINT', () => {
  if (erroresRegistrados > 0) {
    log(`\n✅ Detenido — ${erroresRegistrados} errores registrados en memoria KDD`);
    sincronizarGrafo();
  }
  process.exit(0);
});
