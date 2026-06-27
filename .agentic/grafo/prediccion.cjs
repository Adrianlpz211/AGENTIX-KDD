#!/usr/bin/env node
'use strict';

/**
 * AGENTIC KDD v2.2 — MOTOR DE PREDICCIÓN
 * 
 * Analiza la memoria episódica acumulada para predecir fallos ANTES de que pasen.
 * 
 * "Cada vez que tocas SessionManager sin correr las migraciones → falla"
 * 
 * Cómo funciona:
 *   1. Minería de patrones causales en episodios (correlación, no IA)
 *   2. Reglas de precondición: "si vas a tocar X, necesitas hacer Y primero"
 *   3. Puntuación de riesgo por módulo basada en historial real
 *   4. Se activa en el Context Guard del orquestador — ANTES de ejecutar
 * 
 * No requiere API key. Corre offline. Mejora con cada ciclo aa:.
 */

const path = require('path');
const fs   = require('fs');

// ─── ANÁLISIS DE PATRONES CAUSALES ────────────────────────────────────────────

/**
 * Mina patrones causales desde la memoria episódica
 * "X ocurre → Y falla" con frecuencia >= umbral
 */
function minarPatronesCausales(db, umbralFrecuencia) {
  umbralFrecuencia = umbralFrecuencia || 2;
  
  try {
    const episodios = db.all(
      `SELECT * FROM episodios ORDER BY fecha DESC LIMIT 200`
    );
    
    if (episodios.length < 5) return [];
    
    const patronesCausales = [];
    
    // ── Patrón 1: Archivos de alto riesgo ─────────────────────────────────
    // Archivos que aparecen frecuentemente en episodios de fallo
    const conteoPorArchivo = {};
    const fallosPorArchivo = {};
    
    episodios.forEach(ep => {
      const tocados = safeParseJSON(ep.archivos_tocados, []);
      tocados.forEach(archivo => {
        const key = normalizeArchivo(archivo);
        conteoPorArchivo[key] = (conteoPorArchivo[key] || 0) + 1;
        if (ep.resultado === 'fallo' || ep.resultado === 'parcial') {
          fallosPorArchivo[key] = (fallosPorArchivo[key] || 0) + 1;
        }
      });
    });
    
    Object.entries(fallosPorArchivo).forEach(([archivo, fallos]) => {
      const total = conteoPorArchivo[archivo] || 1;
      const tasaFallo = fallos / total;
      
      if (fallos >= umbralFrecuencia && tasaFallo >= 0.3) {
        // Buscar la razón más común
        const razonesEpisodios = episodios.filter(ep => {
          const tocados = safeParseJSON(ep.archivos_tocados, []);
          return tocados.some(t => normalizeArchivo(t) === archivo) &&
                 ep.resultado === 'fallo' && ep.razon_resultado;
        });
        
        const razonComun = razonesEpisodios.length > 0 
          ? razonesEpisodios[0].razon_resultado.slice(0, 150) 
          : null;
        
        // Buscar fixes que funcionaron
        const fixesExitosos = episodios.filter(ep => {
          const tocados = safeParseJSON(ep.archivos_tocados, []);
          return tocados.some(t => normalizeArchivo(t) === archivo) &&
                 (ep.resultado === 'exito' || ep.resultado === 'resuelto') &&
                 ep.accion_tomada;
        }).map(ep => ep.accion_tomada.slice(0, 150));
        
        patronesCausales.push({
          tipo: 'archivo_alto_riesgo',
          trigger: archivo,
          frecuencia_fallo: fallos,
          total_usos: total,
          tasa_fallo: Math.round(tasaFallo * 100),
          razon_comun: razonComun,
          fixes_exitosos: fixesExitosos.slice(0, 2),
          nivel_riesgo: tasaFallo >= 0.6 ? 'ALTO' : 'MEDIO',
          mensaje: `${archivo} falló ${fallos}/${total} veces (${Math.round(tasaFallo*100)}%)`
        });
      }
    });
    
    // ── Patrón 2: Secuencias problemáticas (A después de B sin C) ─────────
    // Detectar: "siempre que tocas A y B en el mismo ciclo → falla"
    const coOcurrenciasFallo = {};
    
    episodios
      .filter(ep => ep.resultado === 'fallo' || ep.resultado === 'parcial')
      .forEach(ep => {
        const tocados = safeParseJSON(ep.archivos_tocados, []).map(normalizeArchivo);
        // Pares de archivos en fallos
        for (let i = 0; i < tocados.length; i++) {
          for (let j = i + 1; j < tocados.length; j++) {
            const par = [tocados[i], tocados[j]].sort().join('|');
            coOcurrenciasFallo[par] = (coOcurrenciasFallo[par] || 0) + 1;
          }
        }
      });
    
    Object.entries(coOcurrenciasFallo).forEach(([par, count]) => {
      if (count >= umbralFrecuencia) {
        const [a, b] = par.split('|');
        patronesCausales.push({
          tipo: 'co_ocurrencia_fallo',
          trigger: `${a} + ${b}`,
          archivos: [a, b],
          frecuencia_fallo: count,
          nivel_riesgo: count >= 3 ? 'ALTO' : 'MEDIO',
          mensaje: `Tocar ${a} y ${b} juntos falló ${count}x`
        });
      }
    });
    
    // ── Patrón 3: Módulos con precondiciones implícitas ────────────────────
    // "Antes de tocar X, siempre se corrió Y" (en episodios exitosos)
    const precondiciones = detectarPrecondiciones(episodios);
    patronesCausales.push(...precondiciones);
    
    return patronesCausales.sort((a, b) => b.frecuencia_fallo - a.frecuencia_fallo);
    
  } catch(e) { return []; }
}

/**
 * Detectar precondiciones implícitas
 * "En todos los episodios exitosos con archivo X, se mencionó Y en la descripción"
 */
function detectarPrecondiciones(episodios) {
  const precondiciones = [];
  
  // Keywords de precondiciones comunes
  const keywordsPrecond = [
    { keyword: 'migr', label: 'migraciones', accion: 'Correr migraciones' },
    { keyword: 'npm install', label: 'instalación de deps', accion: 'npm install' },
    { keyword: 'env', label: 'variables de entorno', accion: 'Verificar .env' },
    { keyword: 'restart', label: 'reinicio del servidor', accion: 'Reiniciar el servidor' },
    { keyword: 'rebuild', label: 'rebuild', accion: 'npm run build' },
    { keyword: 'docker', label: 'Docker', accion: 'Levantar Docker' },
    { keyword: 'seed', label: 'seeds de DB', accion: 'Correr seeders' },
    { keyword: 'clear cache', label: 'limpiar cache', accion: 'Limpiar cache' },
  ];
  
  // Para cada módulo con suficientes episodios
  const modulosConEpisodios = {};
  episodios.forEach(ep => {
    if (ep.modulo && ep.modulo !== 'global') {
      if (!modulosConEpisodios[ep.modulo]) modulosConEpisodios[ep.modulo] = { exito: [], fallo: [] };
      if (ep.resultado === 'exito' || ep.resultado === 'resuelto') {
        modulosConEpisodios[ep.modulo].exito.push(ep);
      } else if (ep.resultado === 'fallo') {
        modulosConEpisodios[ep.modulo].fallo.push(ep);
      }
    }
  });
  
  Object.entries(modulosConEpisodios).forEach(([modulo, eps]) => {
    if (eps.exito.length < 2 || eps.fallo.length < 1) return;
    
    keywordsPrecond.forEach(({ keyword, label, accion }) => {
      // ¿Cuántos éxitos mencionan este keyword?
      const exitosConKeyword = eps.exito.filter(ep => 
        (ep.descripcion + ep.accion_tomada).toLowerCase().includes(keyword)
      ).length;
      
      // ¿Cuántos fallos NO lo mencionan?
      const fallosSinKeyword = eps.fallo.filter(ep =>
        !(ep.descripcion + (ep.accion_tomada || '')).toLowerCase().includes(keyword)
      ).length;
      
      const tasaExitoConKeyword = exitosConKeyword / eps.exito.length;
      
      if (tasaExitoConKeyword >= 0.6 && fallosSinKeyword >= 1) {
        precondiciones.push({
          tipo: 'precondicion_implicita',
          trigger: modulo,
          precondicion: accion,
          frecuencia_fallo: fallosSinKeyword,
          tasa_exito_con_precond: Math.round(tasaExitoConKeyword * 100),
          nivel_riesgo: fallosSinKeyword >= 2 ? 'ALTO' : 'MEDIO',
          mensaje: `⚡ Antes de tocar ${modulo}: ${accion} (${Math.round(tasaExitoConKeyword*100)}% éxito cuando se hace)`
        });
      }
    });
  });
  
  return precondiciones;
}

// ─── EVALUACIÓN EN TIEMPO REAL ────────────────────────────────────────────────

/**
 * Evaluar riesgo de una tarea específica ANTES de ejecutarla
 * Se llama desde el Context Guard del orquestador
 * 
 * @param {string} tarea - descripción de la tarea aa:
 * @param {string[]} archivosATocar - archivos que probablemente se van a tocar
 * @param {string} modulo - módulo objetivo
 * @param {object} db - adapter de grafo.cjs
 * @returns {object} reporte de predicción
 */
function evaluarRiesgoTarea(tarea, archivosATocar, modulo, db) {
  try {
    const patrones = minarPatronesCausales(db);
    const alertas  = [];
    const precondiciones = [];
    
    const tareaLower = tarea.toLowerCase();
    const archivosLower = (archivosATocar || []).map(a => normalizeArchivo(a));
    
    for (const patron of patrones) {
      // Verificar si el trigger del patrón aplica a esta tarea
      let aplica = false;
      
      if (patron.tipo === 'archivo_alto_riesgo') {
        aplica = archivosLower.some(a => a.includes(patron.trigger) || patron.trigger.includes(a)) ||
                 tareaLower.includes(patron.trigger.toLowerCase());
      }
      
      if (patron.tipo === 'co_ocurrencia_fallo') {
        aplica = patron.archivos.every(a => 
          archivosLower.some(f => f.includes(a) || a.includes(f))
        );
      }
      
      if (patron.tipo === 'precondicion_implicita') {
        aplica = patron.trigger === modulo || 
                 archivosLower.some(a => a.includes(patron.trigger.toLowerCase()));
      }
      
      if (aplica) {
        if (patron.tipo === 'precondicion_implicita') {
          precondiciones.push(patron);
        } else {
          alertas.push(patron);
        }
      }
    }
    
    // Calcular riesgo global
    const nivelGlobal = calcularRiesgoGlobal(alertas, precondiciones);
    
    return {
      nivel_riesgo: nivelGlobal,
      alertas,
      precondiciones,
      tiene_alertas: alertas.length > 0,
      tiene_precondiciones: precondiciones.length > 0,
      reporte: formatearPrediccion(nivelGlobal, alertas, precondiciones)
    };
    
  } catch(e) { 
    return { nivel_riesgo: 'BAJO', alertas: [], precondiciones: [], reporte: '' }; 
  }
}

function calcularRiesgoGlobal(alertas, precondiciones) {
  const hayAlto = [...alertas, ...precondiciones].some(a => a.nivel_riesgo === 'ALTO');
  const hayMedio = [...alertas, ...precondiciones].some(a => a.nivel_riesgo === 'MEDIO');
  if (hayAlto) return 'ALTO';
  if (hayMedio) return 'MEDIO';
  return 'BAJO';
}

function formatearPrediccion(nivel, alertas, precondiciones) {
  if (alertas.length === 0 && precondiciones.length === 0) return '';
  
  const lineas = [];
  const icono = nivel === 'ALTO' ? '🔴' : nivel === 'MEDIO' ? '🟡' : '🟢';
  
  lineas.push(`\n  ${icono} PREDICCIÓN KDD [${nivel}]`);
  
  alertas.forEach(a => {
    lineas.push(`  ⚠️  ${a.mensaje}`);
    if (a.fixes_exitosos?.length > 0) {
      lineas.push(`      Fix que funcionó: ${a.fixes_exitosos[0]}`);
    }
  });
  
  if (precondiciones.length > 0) {
    lineas.push(`\n  Precondiciones recomendadas:`);
    precondiciones.forEach(p => {
      lineas.push(`  ✓ ${p.precondicion} (${p.tasa_exito_con_precond}% éxito cuando se hace)`);
    });
  }
  
  return lineas.join('\n');
}

// ─── REGISTRO DE RESULTADO REAL ───────────────────────────────────────────────

/**
 * Registrar si la predicción fue correcta o no
 * Mejora la precisión del modelo con el tiempo
 */
function registrarResultadoPrediccion(db, prediccionId, fueCorrecto, cicloId) {
  // Por ahora registrar como episodio de aprendizaje
  try {
    const timestamp = new Date().toISOString();
    db.run(
      `INSERT INTO episodios (episodio_id, tipo, descripcion, resultado, area, modulo, fecha)
       VALUES (?, 'aprendizaje', ?, ?, 'prediccion', 'sistema', ?)`,
      `pred-${Date.now()}`,
      `Predicción ${prediccionId}: ${fueCorrecto ? 'CORRECTA' : 'INCORRECTA'}`,
      fueCorrecto ? 'exito' : 'fallo',
      timestamp
    );
  } catch(e) {}
}

// ─── COMANDO CLI: akdd predict ────────────────────────────────────────────────
function mostrarEstadisticasPrediccion(db) {
  const patrones = minarPatronesCausales(db);
  
  if (patrones.length === 0) {
    console.log('\n  No hay suficientes episodios para predicciones (mínimo 5)');
    console.log('  Usa aa: para acumular memoria episódica\n');
    return;
  }
  
  console.log('\n  MOTOR DE PREDICCIÓN — Agentic KDD\n');
  console.log(`  Patrones causales detectados: ${patrones.length}`);
  
  const altos  = patrones.filter(p => p.nivel_riesgo === 'ALTO');
  const medios = patrones.filter(p => p.nivel_riesgo === 'MEDIO');
  
  if (altos.length > 0) {
    console.log('\n  🔴 Riesgo ALTO:');
    altos.forEach(p => console.log(`    · ${p.mensaje}`));
  }
  if (medios.length > 0) {
    console.log('\n  🟡 Riesgo MEDIO:');
    medios.forEach(p => console.log(`    · ${p.mensaje}`));
  }
  
  const precondiciones = patrones.filter(p => p.tipo === 'precondicion_implicita');
  if (precondiciones.length > 0) {
    console.log('\n  ⚡ Precondiciones detectadas:');
    precondiciones.forEach(p => console.log(`    · ${p.mensaje}`));
  }
  
  console.log('');
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function safeParseJSON(str, fallback) {
  try { return JSON.parse(str || '[]'); } catch(e) { return fallback; }
}

function normalizeArchivo(archivo) {
  return path.basename(archivo || '', path.extname(archivo || '')).toLowerCase();
}

module.exports = {
  minarPatronesCausales,
  evaluarRiesgoTarea,
  mostrarEstadisticasPrediccion,
  registrarResultadoPrediccion,
  detectarPrecondiciones,
  formatearPrediccion
};
