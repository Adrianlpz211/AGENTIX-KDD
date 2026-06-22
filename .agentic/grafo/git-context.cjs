#!/usr/bin/env node
'use strict';

/**
 * AGENTIC KDD v2.2 — GIT CONTEXT
 * 
 * Qué hace:
 *   1. Lee el estado del repo git (diff, archivos modificados, commits recientes)
 *   2. Cruza cada archivo modificado contra la memoria episódica/semántica
 *   3. Genera un reporte de riesgo ANTES del primer aa:
 *   4. Carga el contexto en working_memory para que el Analista lo use
 * 
 * Cuándo corre:
 *   - akdd git-context → manual
 *   - akdd sync → automático si hay .git
 *   - Hook post-checkout de git → automático al cambiar de rama
 * 
 * Sin git → silenciosamente no hace nada (no rompe nada)
 */

const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const { execSync, spawnSync } = require('child_process');

// ─── Verificar que git está disponible ────────────────────────────────────────
function gitDisponible(projectPath) {
  const gitDir = path.join(projectPath, '.git');
  if (!fs.existsSync(gitDir)) return false;
  try {
    execSync('git --version', { stdio: 'pipe' });
    return true;
  } catch(e) { return false; }
}

// ─── Obtener diff del working tree ────────────────────────────────────────────
function getDiff(projectPath) {
  try {
    // Archivos modificados (staged + unstaged)
    const staged   = execSync('git diff --cached --name-only', { cwd: projectPath, stdio: 'pipe' }).toString().trim();
    const unstaged = execSync('git diff --name-only', { cwd: projectPath, stdio: 'pipe' }).toString().trim();
    const untracked = execSync('git ls-files --others --exclude-standard', { cwd: projectPath, stdio: 'pipe' }).toString().trim();
    
    const archivos = new Set([
      ...staged.split('\n').filter(Boolean),
      ...unstaged.split('\n').filter(Boolean),
    ]);
    
    // Diff resumido (primeras 200 líneas para no saturar contexto)
    let diffContent = '';
    try {
      diffContent = execSync('git diff HEAD --stat', { cwd: projectPath, stdio: 'pipe' }).toString().trim();
    } catch(e) {}
    
    return {
      archivos_modificados: [...archivos],
      archivos_nuevos: untracked.split('\n').filter(Boolean),
      diff_stat: diffContent,
      tiene_cambios: archivos.size > 0
    };
  } catch(e) { return { archivos_modificados: [], archivos_nuevos: [], diff_stat: '', tiene_cambios: false }; }
}

// ─── Obtener commits recientes ─────────────────────────────────────────────────
function getCommitsRecientes(projectPath, n) {
  n = n || 5;
  try {
    const log = execSync(
      `git log --oneline -${n} --format="%H|%s|%ai|%an"`,
      { cwd: projectPath, stdio: 'pipe' }
    ).toString().trim();
    
    return log.split('\n').filter(Boolean).map(line => {
      const [hash, mensaje, fecha, autor] = line.split('|');
      return { hash: hash?.slice(0, 8), mensaje, fecha, autor };
    });
  } catch(e) { return []; }
}

// ─── Obtener rama actual ───────────────────────────────────────────────────────
function getRamaActual(projectPath) {
  try {
    return execSync('git branch --show-current', { cwd: projectPath, stdio: 'pipe' }).toString().trim();
  } catch(e) { return 'unknown'; }
}

// ─── Obtener archivos modificados en el último PR/merge ───────────────────────
function getArchivosUltimoPR(projectPath) {
  try {
    // Archivos del último commit de merge
    const mergeHash = execSync(
      'git log --merges --oneline -1 --format="%H"',
      { cwd: projectPath, stdio: 'pipe' }
    ).toString().trim();
    
    if (!mergeHash) return [];
    
    const archivos = execSync(
      `git diff-tree --no-commit-id -r --name-only ${mergeHash}`,
      { cwd: projectPath, stdio: 'pipe' }
    ).toString().trim();
    
    return archivos.split('\n').filter(Boolean);
  } catch(e) { return []; }
}

// ─── Cruzar archivos modificados contra memoria episódica ─────────────────────
function analizarRiesgo(archivos, db) {
  const riesgos = [];
  
  for (const archivo of archivos) {
    const nombre = path.basename(archivo, path.extname(archivo));
    const nombreSinExt = nombre;
    
    // Buscar episodios de fallo relacionados con este archivo
    const episodiosFallo = db.all(
      `SELECT descripcion, accion_tomada, razon_resultado, resultado, fecha, area, modulo
       FROM episodios 
       WHERE (archivos_tocados LIKE ? OR archivos_tocados LIKE ? OR modulo LIKE ? OR descripcion LIKE ?)
       AND resultado IN ('fallo', 'parcial')
       ORDER BY fecha DESC LIMIT 5`,
      `%${archivo}%`, `%${nombreSinExt}%`, `%${nombreSinExt}%`, `%${nombreSinExt}%`
    );
    
    // Buscar episodios de éxito (para contexto positivo)
    const episodiosExito = db.all(
      `SELECT descripcion, accion_tomada, resultado, fecha
       FROM episodios 
       WHERE (archivos_tocados LIKE ? OR modulo LIKE ?)
       AND resultado IN ('exito', 'resuelto')
       ORDER BY fecha DESC LIMIT 2`,
      `%${nombreSinExt}%`, `%${nombreSinExt}%`
    );
    
    // Buscar errores conocidos del área
    let entidad = null;
    try {
      entidad = db.get('SELECT * FROM entidades WHERE nombre=?', nombreSinExt);
    } catch(e) {}
    
    // Buscar patrones de error asociados
    const erroresAsociados = db.all(
      `SELECT titulo, confianza, contenido FROM nodos 
       WHERE tipo='error' AND estado='ACTIVO'
       AND (contenido LIKE ? OR titulo LIKE ?)
       LIMIT 3`,
      `%${nombreSinExt}%`, `%${nombreSinExt}%`
    );
    
    // Calcular nivel de riesgo
    const nivelRiesgo = calcularNivelRiesgo(episodiosFallo, erroresAsociados, entidad);
    
    if (episodiosFallo.length > 0 || erroresAsociados.length > 0 || nivelRiesgo !== 'BAJO') {
      riesgos.push({
        archivo,
        nivel: nivelRiesgo,
        fallos_previos: episodiosFallo.length,
        exitos_previos: episodiosExito.length,
        es_critico: entidad?.critica === 1,
        episodios_fallo: episodiosFallo.slice(0, 3),
        errores_conocidos: erroresAsociados,
        advertencia: generarAdvertencia(archivo, episodiosFallo, erroresAsociados, entidad)
      });
    }
  }
  
  // Ordenar por nivel de riesgo
  const orden = { 'ALTO': 0, 'MEDIO': 1, 'BAJO': 2 };
  return riesgos.sort((a, b) => orden[a.nivel] - orden[b.nivel]);
}

function calcularNivelRiesgo(fallos, errores, entidad) {
  let score = 0;
  score += fallos.length * 2;
  score += errores.filter(e => e.confianza === 'ALTA').length * 3;
  score += errores.filter(e => e.confianza === 'MEDIA').length * 1;
  score += entidad?.critica ? 2 : 0;
  score += entidad?.errores_asociados || 0;
  
  if (score >= 5) return 'ALTO';
  if (score >= 2) return 'MEDIO';
  return 'BAJO';
}

function generarAdvertencia(archivo, fallos, errores, entidad) {
  const partes = [];
  
  if (fallos.length > 0) {
    const ultimo = fallos[0];
    partes.push(`Falló ${fallos.length}x antes${ultimo.razon_resultado ? ': ' + ultimo.razon_resultado.slice(0, 100) : ''}`);
  }
  
  const errorAlta = errores.find(e => e.confianza === 'ALTA');
  if (errorAlta) partes.push(`Error conocido ALTA: ${errorAlta.titulo}`);
  
  if (entidad?.critica) partes.push('Módulo marcado como CRÍTICO');
  
  return partes.join(' | ');
}

// ─── Predicción de problemas ──────────────────────────────────────────────────
// Feature 2: analiza patrones causales en episodios para predecir fallos
function predecirProblemas(archivos, db) {
  const predicciones = [];
  
  // Buscar patrones causales: "cuando X + Y → fallo Z"
  // Analizamos los últimos 100 episodios para detectar co-ocurrencias
  const episodiosRecientes = db.all(
    `SELECT * FROM episodios ORDER BY fecha DESC LIMIT 100`
  );
  
  if (episodiosRecientes.length < 5) return []; // muy pocos datos
  
  // Para cada archivo modificado, buscar patrones causales
  for (const archivo of archivos) {
    const nombre = path.basename(archivo, path.extname(archivo));
    
    // Episodios que tocaron este archivo Y fallaron
    const epConFallo = episodiosRecientes.filter(ep => {
      const tocados = JSON.parse(ep.archivos_tocados || '[]');
      return tocados.some(t => t.includes(nombre) || t.includes(archivo));
    }).filter(ep => ep.resultado === 'fallo' || ep.resultado === 'parcial');
    
    if (epConFallo.length < 2) continue; // no hay patrón todavía
    
    // Buscar qué otros archivos se tocaron junto con este en fallos
    const coOcurrencias = {};
    epConFallo.forEach(ep => {
      const tocados = JSON.parse(ep.archivos_tocados || '[]');
      tocados.filter(t => !t.includes(nombre)).forEach(t => {
        coOcurrencias[t] = (coOcurrencias[t] || 0) + 1;
      });
    });
    
    // Buscar razones comunes
    const razonesComunes = epConFallo
      .filter(ep => ep.razon_resultado)
      .map(ep => ep.razon_resultado)
      .slice(0, 3);
    
    // Buscar si hay comandos que "solucionan" el problema (de episodios exitosos)
    const epExito = episodiosRecientes.filter(ep => {
      const tocados = JSON.parse(ep.archivos_tocados || '[]');
      return tocados.some(t => t.includes(nombre)) && 
             (ep.resultado === 'exito' || ep.resultado === 'resuelto');
    });
    
    const solucionesPrevias = epExito
      .filter(ep => ep.accion_tomada)
      .map(ep => ep.accion_tomada.slice(0, 150))
      .slice(0, 2);
    
    if (epConFallo.length >= 2) {
      predicciones.push({
        archivo,
        tipo: 'patron_causal',
        frecuencia_fallo: epConFallo.length,
        total_episodios: episodiosRecientes.filter(ep => {
          const tocados = JSON.parse(ep.archivos_tocados || '[]');
          return tocados.some(t => t.includes(nombre));
        }).length,
        razones_comunes: razonesComunes,
        soluciones_previas: solucionesPrevias,
        co_ocurrencias: Object.entries(coOcurrencias)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([archivo, n]) => `${archivo} (${n}x)`),
        mensaje: `⚠️ ${archivo} falló ${epConFallo.length}x en episodios anteriores${razonesComunes[0] ? ': ' + razonesComunes[0].slice(0, 100) : ''}`
      });
    }
  }
  
  return predicciones.sort((a, b) => b.frecuencia_fallo - a.frecuencia_fallo);
}

// ─── Cargar contexto en working_memory ────────────────────────────────────────
function cargarEnWorkingMemory(db, contexto, sesionId) {
  sesionId = sesionId || `git-${Date.now()}`;
  
  try {
    // Limpiar working memory expirada de sesiones anteriores
    db.run('UPDATE working_memory SET expirado=1 WHERE sesion_id != ? AND expirado=0', sesionId);
    
    // Guardar contexto git
    db.run(
      `INSERT INTO working_memory (sesion_id, tipo, contenido, relevancia)
       VALUES (?, 'observacion', ?, ?)`,
      sesionId,
      JSON.stringify(contexto),
      1.0
    );
    return sesionId;
  } catch(e) { return null; }
}

// ─── FUNCIÓN PRINCIPAL ────────────────────────────────────────────────────────
function analizarGitContext(projectPath, db) {
  if (!gitDisponible(projectPath)) {
    return { disponible: false, mensaje: 'No es un repositorio git' };
  }
  
  const diff        = getDiff(projectPath);
  const commits     = getCommitsRecientes(projectPath);
  const rama        = getRamaActual(projectPath);
  const archivosPR  = getArchivosUltimoPR(projectPath);
  
  // Todos los archivos relevantes
  const todosArchivos = [
    ...new Set([...diff.archivos_modificados, ...archivosPR])
  ];
  
  // Analizar riesgo de archivos modificados
  const riesgos = todosArchivos.length > 0 ? analizarRiesgo(todosArchivos, db) : [];
  
  // Predicciones de problemas
  const predicciones = todosArchivos.length > 0 ? predecirProblemas(todosArchivos, db) : [];
  
  const contexto = {
    timestamp: new Date().toISOString(),
    rama,
    diff_stat: diff.diff_stat,
    archivos_modificados: diff.archivos_modificados,
    archivos_nuevos: diff.archivos_nuevos,
    commits_recientes: commits,
    riesgos,
    predicciones,
    tiene_riesgos_altos: riesgos.some(r => r.nivel === 'ALTO'),
    tiene_predicciones: predicciones.length > 0
  };
  
  return { disponible: true, contexto };
}

// ─── REPORTE LEGIBLE ──────────────────────────────────────────────────────────
function formatearReporte(resultado) {
  if (!resultado.disponible) {
    return `  Git Context: ${resultado.mensaje}`;
  }
  
  const { contexto } = resultado;
  const lineas = [];
  
  lineas.push(`\n  ╔══════════════════════════════════════════╗`);
  lineas.push(`  ║  GIT CONTEXT — Agentic KDD               ║`);
  lineas.push(`  ╚══════════════════════════════════════════╝`);
  lineas.push(`\n  Rama: ${contexto.rama}`);
  
  if (contexto.archivos_modificados.length > 0) {
    lineas.push(`\n  Archivos con cambios (${contexto.archivos_modificados.length}):`);
    contexto.archivos_modificados.slice(0, 10).forEach(f => lineas.push(`    • ${f}`));
  }
  
  if (contexto.commits_recientes.length > 0) {
    lineas.push(`\n  Commits recientes:`);
    contexto.commits_recientes.slice(0, 3).forEach(c => 
      lineas.push(`    [${c.hash}] ${c.mensaje}`));
  }
  
  if (contexto.riesgos.length > 0) {
    lineas.push(`\n  ─── ANÁLISIS DE RIESGO ──────────────────`);
    contexto.riesgos.forEach(r => {
      const icono = r.nivel === 'ALTO' ? '🔴' : r.nivel === 'MEDIO' ? '🟡' : '🟢';
      lineas.push(`\n  ${icono} [${r.nivel}] ${r.archivo}`);
      if (r.advertencia) lineas.push(`     ${r.advertencia}`);
      if (r.errores_conocidos.length > 0) {
        lineas.push(`     Errores conocidos:`);
        r.errores_conocidos.forEach(e => lineas.push(`       · ${e.titulo} [${e.confianza}]`));
      }
      if (r.episodios_fallo.length > 0 && r.episodios_fallo[0]?.accion_tomada) {
        lineas.push(`     Fix previo: ${r.episodios_fallo[0].accion_tomada.slice(0, 120)}`);
      }
    });
  }
  
  if (contexto.predicciones.length > 0) {
    lineas.push(`\n  ─── PREDICCIONES ────────────────────────`);
    contexto.predicciones.forEach(p => {
      lineas.push(`\n  ⚡ ${p.mensaje}`);
      if (p.soluciones_previas.length > 0) {
        lineas.push(`     Solución que funcionó: ${p.soluciones_previas[0]}`);
      }
    });
  }
  
  if (contexto.riesgos.length === 0 && contexto.predicciones.length === 0) {
    lineas.push(`\n  ✓ Sin riesgos detectados en archivos modificados`);
  }
  
  lineas.push('');
  return lineas.join('\n');
}

// ─── INSTALAR HOOK GIT ────────────────────────────────────────────────────────
function instalarHook(projectPath) {
  const hookPath = path.join(projectPath, '.git', 'hooks', 'post-checkout');
  const hookContent = `#!/bin/sh
# Agentic KDD — Git Context Hook
# Se ejecuta automáticamente al cambiar de rama
if command -v akdd >/dev/null 2>&1; then
  akdd git-context --silent 2>/dev/null &
fi
`;
  try {
    fs.writeFileSync(hookPath, hookContent);
    fs.chmodSync(hookPath, '755');
    return true;
  } catch(e) { return false; }
}

// ─── CLI ──────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const projectPath = process.cwd();
  const args = process.argv.slice(2);
  const silente = args.includes('--silent');
  
  // Para CLI standalone — crear adapter mínimo
  // Normalmente se llama desde grafo.cjs que ya tiene el adapter
  const DB_PATH = path.join(projectPath, '.agentic', 'memoria.db');
  if (!fs.existsSync(DB_PATH)) {
    if (!silente) console.log('  Git Context: Agentic KDD no instalado en este proyecto');
    process.exit(0);
  }
  
  // Usar grafo.cjs para el adapter
  const grafoPath = path.join(projectPath, '.agentic', 'grafo', 'grafo.cjs');
  if (!fs.existsSync(grafoPath)) { process.exit(0); }
  
  // Importar adapter de grafo.cjs
  const grafo = require(grafoPath);
  
  if (args.includes('--install-hook')) {
    const ok = instalarHook(projectPath);
    console.log(ok ? '  ✓ Hook post-checkout instalado' : '  ✗ No se pudo instalar el hook');
    process.exit(0);
  }
  
  console.log('  Analizando contexto git...');
  // La función necesita el db adapter — se obtiene del grafo.cjs exportando initDB
  // Por ahora usar salida básica
  console.log('  Usa: akdd sync (incluye git-context automáticamente)');
}

module.exports = {
  analizarGitContext,
  predecirProblemas,
  formatearReporte,
  instalarHook,
  getDiff,
  getCommitsRecientes,
  getRamaActual,
  gitDisponible
};
