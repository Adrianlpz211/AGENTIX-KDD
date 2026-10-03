'use strict';
const { herramienta } = require('./run-safe');

// Windows tiene DOS tars posibles corriendo `tar`:
//  - GNU tar (Git Bash / MSYS): interpreta "C:/Users/..." como host remoto
//    salvo que se le pase --force-local.
//  - bsdtar nativo de Windows 10/11 (libarchive): NO tiene esa interpretación
//    de host remoto, y además no reconoce la opción --force-local — falla con
//    "tar: Option --force-local is not supported" si se la pasamos.
// Por eso probamos primero con --force-local (necesario en Git Bash) y si
// falla por opción no reconocida, reintentamos sin ella (bsdtar nativo).
function tarConFallback(baseArgs, opts) {
  try {
    return herramienta('tar', ['--force-local', ...baseArgs], opts);
  } catch (err) {
    const msg = (err.stderr || err.message || '').toString();
    if (/force-local/i.test(msg)) {
      return herramienta('tar', baseArgs, opts);
    }
    throw err;
  }
}

/** Entradas del archivo sin extraer nada. `detalle` = listado largo (tipo, enlaces). */
function listarTarGz(tarFile, { detalle = false } = {}) {
  const out = tarConFallback([detalle ? '-tvzf' : '-tzf', barra(tarFile)], { maxBuffer: 256 * 1024 * 1024 });
  return String(out || '').split(/\r?\n/).filter((l) => l.trim() !== '');
}

const barra = (p) => String(p).replace(/\\/g, '/');

function extractTarGz(tarFile, destDir) {
  tarConFallback(['-xzf', barra(tarFile), '-C', barra(destDir), '--strip-components=1']);
}

/**
 * GNU tar sale con código 1 — no 2 — cuando un archivo cambió mientras lo leía
 * ("file changed as we read it"). El archivo resultante está completo: tar
 * terminó de escribirlo y solo avisa de que la copia de ESE miembro puede no
 * ser la última versión. Caso real (02/10/2026): el release-check empaqueta
 * el checkout entero mientras otros tests escriben estado en .agentic/, y la
 * barrera se puso roja por un aviso sobre archivos que ni siquiera viajan.
 * Código 2 (error fatal) y cualquier otro mensaje siguen lanzando.
 */
function avisoTolerable(err) {
  if (!err || err.status !== 1) return false;
  const msg = (err.stderr || '').toString();
  if (!msg.trim()) return false;
  const lineas = msg.split(/\r?\n/).filter((l) => l.trim() !== '');
  return lineas.every((l) => /file changed as we read it|Exiting with failure status due to previous errors/i.test(l));
}

/**
 * Estado que el motor escribe mientras trabaja: no es framework, no viaja en
 * el paquete y es exactamente lo que cambia bajo los pies de tar. Nombres
 * sueltos (no rutas) para que GNU tar y bsdtar los entiendan igual.
 * `_LOCKS.md` NO está aquí: es un archivo managed del manifiesto.
 */
const EXCLUIR_ESTADO_VOLATIL = [
  'node_modules', '.git', 'memoria.db', 'memoria.db-wal', 'memoria.db-shm',
  '_cache', '_executions', '_hooks', '_pipeline', '_teams', '_restore', '_whatsapp',
  '_effort', '_context', '_update', '_hooks-eventos.jsonl', '_ciclo_actual.json',
  '_tarea_en_curso.json', '_tdd_ultimo.json', '_tdd_state.json', '_instance_id',
  'telemetria', '_output', '.model_cache',
];

/** Empaqueta `nombre` (dentro de `padre`) en un .tar.gz, con los mismos dos tars. */
function createTarGz(tarFile, padre, nombre, excludes, opts) {
  try {
    tarConFallback(
      ['-czf', barra(tarFile), ...(excludes || []).map((e) => `--exclude=${e}`), '-C', barra(padre), nombre],
      opts
    );
  } catch (err) {
    if (!avisoTolerable(err)) throw err;
  }
}

module.exports = { extractTarGz, createTarGz, tarConFallback, listarTarGz, avisoTolerable, EXCLUIR_ESTADO_VOLATIL };
