'use strict';

/**
 * riesgo-archivos — riesgo de una tarea por EVIDENCIA sobre los archivos que nombra, no por el texto.
 *
 * Caso real (glowly, 05/10/2026): 54 de 60 predicciones salieron MEDIO. No era una opinión sobre el riesgo: era el piso por «contexto
 * de confianza BAJA» (toda la memoria estaba en BAJA) y el motor de predicción nunca recibía archivos (el enricher le pasaba []), así que
 * los patrones por archivo no podían aplicar jamás. Resultado: casi no informaba.
 *
 * Aquí el nivel sale de lo que la base ya sabe de los archivos que la tarea nombra:
 *   · quién depende de ellos (aristas del AST: cuántos archivos distintos los importan) — el radio de explosión;
 *   · comportamientos protegidos cuyos archivos relacionados los incluyen;
 *   · errores ya registrados en la memoria que los mencionan.
 * Sin ninguna evidencia el resultado es BAJO: no se inventa riesgo. Solo lectura, nunca bloquea.
 */

const NIVEL = { BAJO: 0, MEDIO: 1, ALTO: 2 };
const POR_NIVEL = ['BAJO', 'MEDIO', 'ALTO'];
const UMBRAL_DEPENDIENTES_MEDIO = 8;
const UMBRAL_DEPENDIENTES_ALTO = 30;
const MAX_RELACIONADOS_SELECTIVO = 50;

// ruta con carpeta + nombre + extensión conocida, opcionalmente seguida de :línea; no se confunde con una URL ni con un número de versión
const RE_ARCHIVO = /(?:^|[\s"'`(\[,;])((?:[\w.@()[\]-]+[\\/])+[\w.@-]+\.(?:tsx?|jsx?|mjs|cjs|mts|cts|py|go|rs|java|rb|php|css|scss|sql|json|md))(?::\d+)?(?=$|[\s"'`)\],;:.])/g;

const norm = (p) => String(p || '').split('\\').join('/').replace(/^\.\//, '');
const sinExt = (p) => p.replace(/\.[^./]+$/, '');

/** Archivos que el texto de la tarea nombra (máx. 12), con barras normales. */
function archivosDeTexto(texto) {
  const out = new Set();
  const t = String(texto || '');
  let m;
  RE_ARCHIVO.lastIndex = 0;
  while ((m = RE_ARCHIVO.exec(t)) !== null) { out.add(norm(m[1])); if (out.size >= 12) break; }
  return [...out];
}

const unico = (db, sql, ...p) => { try { const f = db.prepare(sql).get(...p); return f ? Number(f.n || 0) : 0; } catch { return null; } };
const filas = (db, sql, ...p) => { try { return db.prepare(sql).all(...p); } catch { return null; } };

/** Cuántos archivos distintos importan este (consulta tolerante a barras de Windows y a imports sin extensión). */
function dependientes(db, archivo) {
  return unico(db, "SELECT COUNT(DISTINCT from_file) AS n FROM ast_edges WHERE REPLACE(to_file, char(92), '/') IN (?, ?) AND REPLACE(from_file, char(92), '/') != ?", archivo, sinExt(archivo), archivo);
}

/**
 * @param db        conexión con .prepare(sql).get/.all (node:sqlite o better-sqlite3)
 * @param archivos  rutas relativas que la tarea nombra
 * @returns { nivel: 'BAJO'|'MEDIO'|'ALTO', razones: string[], archivos: string[] }
 */
function evaluar(db, archivos) {
  const lista = (archivos || []).map(norm).filter(Boolean);
  const razones = [];
  let nivel = NIVEL.BAJO;
  const sube = (n, razon) => { nivel = Math.max(nivel, n); razones.push(razon); };
  if (!db || !lista.length) return { nivel: 'BAJO', razones, archivos: lista };

  for (const f of lista) {
    const dep = dependientes(db, f);
    if (dep !== null && dep >= UMBRAL_DEPENDIENTES_ALTO) sube(NIVEL.ALTO, `${f}: lo importan ${dep} archivos (radio de explosión grande)`);
    else if (dep !== null && dep >= UMBRAL_DEPENDIENTES_MEDIO) sube(NIVEL.MEDIO, `${f}: lo importan ${dep} archivos`);

    // Solo cuentan los comportamientos SELECTIVOS: en glowly los 35 listaban los 677 archivos del repo como «relacionados» (cualquier cambio
    // los tocaba a todos), y eso no es evidencia de nada.
    const comp = (filas(db, "SELECT module, confidence, related_files FROM protected_behaviors WHERE (status IS NULL OR status != 'deprecated') AND REPLACE(related_files, char(92), '/') LIKE ?", '%' + f + '%') || [])
      .filter((c) => { try { return JSON.parse(c.related_files).length <= MAX_RELACIONADOS_SELECTIVO; } catch { return false; } });
    if (comp.length) {
      const alta = comp.some((c) => String(c.confidence).toUpperCase() === 'ALTA' || String(c.confidence).toUpperCase() === 'HIGH');
      sube(alta ? NIVEL.ALTO : NIVEL.MEDIO, `${f}: ${comp.length} comportamiento(s) protegido(s) lo tocan (${[...new Set(comp.map((c) => c.module))].slice(0, 3).join(', ')})`);
    }

    const errores = unico(db, "SELECT COUNT(*) AS n FROM nodos WHERE tipo = 'error' AND (estado IS NULL OR estado != 'OBSOLETO') AND (REPLACE(COALESCE(archivos_aplica, ''), char(92), '/') LIKE ? OR REPLACE(COALESCE(contenido, ''), char(92), '/') LIKE ? OR titulo LIKE ?)", '%' + f + '%', '%' + f + '%', '%' + f + '%');
    if (errores) sube(NIVEL.MEDIO, `${f}: ${errores} error(es) ya registrado(s) en la memoria lo mencionan`);
  }
  return { nivel: POR_NIVEL[nivel], razones, archivos: lista };
}

/** ¿La memoria distingue confianzas? Si TODO está en BAJA, «contexto de confianza BAJA» no dice nada y no debe subir el riesgo. */
function memoriaDistingueConfianza(db) {
  const n = unico(db, "SELECT COUNT(*) AS n FROM nodos WHERE confianza IS NOT NULL AND UPPER(confianza) != 'BAJA'");
  return !!n;
}

module.exports = { archivosDeTexto, evaluar, memoriaDistingueConfianza, UMBRAL_DEPENDIENTES_MEDIO, UMBRAL_DEPENDIENTES_ALTO };
