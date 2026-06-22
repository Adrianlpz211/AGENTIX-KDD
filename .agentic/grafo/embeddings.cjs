#!/usr/bin/env node
'use strict';

/**
 * AGENTIC KDD v2.2 — EMBEDDINGS LOCALES
 * Motor: @xenova/transformers — all-MiniLM-L6-v2
 * 100% offline, sin API key, ~23MB, corre en cualquier PC
 * 
 * Integración: se llama desde grafo.cjs — transparente al usuario
 * El campo `embedding` en nodos/episodios ya existe en el schema v3
 */

const path = require('path');
const fs   = require('fs');

// Cache del pipeline en memoria — solo se carga una vez por proceso
let _pipeline = null;
let _available = null; // null=no comprobado, true/false=resultado

const MODELO = 'Xenova/all-MiniLM-L6-v2';
const DIM    = 384; // dimensiones del modelo

/**
 * Verificar si @xenova/transformers está disponible
 * Busca en node_modules del proyecto actual
 */
function isAvailable() {
  if (_available !== null) return _available;
  const searchPaths = [
    path.join(process.cwd(), 'node_modules', '@xenova', 'transformers'),
    path.join(process.cwd(), 'node_modules', '.pnpm', '@xenova+transformers@2.17.2', 'node_modules', '@xenova', 'transformers'),
  ];
  // También buscar global
  try {
    require.resolve('@xenova/transformers');
    _available = true;
    return true;
  } catch(e) {}
  for (const p of searchPaths) {
    if (fs.existsSync(p)) { _available = true; return true; }
  }
  _available = false;
  return false;
}

/**
 * Cargar el pipeline una sola vez (lazy load)
 * El modelo se descarga al cache en ~/.cache/huggingface la primera vez (~23MB)
 */
async function getPipeline() {
  if (_pipeline) return _pipeline;
  if (!isAvailable()) return null;
  try {
    // Suprimir logs de transformers
    process.env.TRANSFORMERS_VERBOSITY = 'error';
    const { pipeline, env } = require('@xenova/transformers');
    // Usar cache local del proyecto si existe
    const localCache = path.join(process.cwd(), '.agentic', '.model_cache');
    if (fs.existsSync(localCache)) env.cacheDir = localCache;
    _pipeline = await pipeline('feature-extraction', MODELO, {
      quantized: true  // versión ONNX quantizada — 23MB vs 90MB full
    });
    return _pipeline;
  } catch(e) {
    _available = false;
    return null;
  }
}

/**
 * Generar embedding para un texto
 * @param {string} text - texto a embedear
 * @returns {Float32Array|null} - vector de 384 dims o null si no disponible
 */
async function embed(text) {
  const pipe = await getPipeline();
  if (!pipe) return null;
  try {
    const output = await pipe(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data); // Float32Array → Array plano para JSON
  } catch(e) {
    return null;
  }
}

/**
 * Similitud coseno entre dos vectores
 * @returns {number} 0-1, donde 1 = idéntico
 */
function cosineSim(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

/**
 * Parsear embedding guardado en DB (JSON string → Array)
 */
function parseEmb(str) {
  if (!str) return null;
  try { return JSON.parse(str); } catch(e) { return null; }
}

/**
 * BÚSQUEDA VECTORIAL HÍBRIDA
 * Combina: similitud coseno (semántica) + keyword score (BM25-like) + decay
 * RRF (Reciprocal Rank Fusion) para combinar los rankings
 * 
 * @param {Array} items - nodos/episodios con campo `embedding` (JSON string)
 * @param {string} query - query del usuario
 * @param {number} topK - cuántos resultados
 * @returns {Array} items rankeados con _score
 */
async function buscarHibridoVectorial(items, query, topK) {
  topK = topK || 10;
  
  // Generar embedding de la query
  const queryEmb = await embed(query);
  
  // Score vectorial (si tenemos embeddings)
  const vectorScores = new Map();
  if (queryEmb) {
    items.forEach((item, idx) => {
      const itemEmb = parseEmb(item.embedding);
      if (itemEmb) {
        vectorScores.set(idx, cosineSim(queryEmb, itemEmb));
      }
    });
  }
  
  // Score keyword (BM25-like — siempre disponible)
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  const keywordScores = new Map();
  items.forEach((item, idx) => {
    const text = ([item.titulo, item.descripcion, item.contenido, 
                   item.accion_tomada, item.razon_resultado, item.nombre]
      .filter(Boolean).join(' ')).toLowerCase();
    let score = 0;
    terms.forEach(term => {
      const count = (text.match(new RegExp(term, 'gi')) || []).length;
      if (count > 0) score += 1 + Math.log(1 + count);
    });
    // Boosts
    if (item.confianza === 'ALTA')  score *= 2.0;
    if (item.confianza === 'MEDIA') score *= 1.5;
    score *= (item.decay_score || 1.0);
    score += Math.log(1 + (item.accesos_total || item.aplicado || 0)) * 0.3;
    keywordScores.set(idx, score);
  });
  
  // RRF: Reciprocal Rank Fusion — combina vectorial + keyword sin necesitar normalización
  const K_RRF = 60; // constante RRF estándar
  
  // Rankear vectorial
  const vectorRank = new Map();
  if (vectorScores.size > 0) {
    [...vectorScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .forEach(([idx], rank) => vectorRank.set(idx, rank + 1));
  }
  
  // Rankear keyword
  const keywordRank = new Map();
  [...keywordScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([idx], rank) => keywordRank.set(idx, rank + 1));
  
  // Combinar con RRF
  const rrfScores = items.map((item, idx) => {
    const vRank = vectorRank.get(idx);
    const kRank = keywordRank.get(idx) || (items.length + 1);
    
    let rrf = 1 / (K_RRF + kRank); // keyword siempre disponible
    if (vRank) rrf += 1 / (K_RRF + vRank); // vectorial si disponible
    
    return { ...item, _score: rrf, _vectorScore: vectorScores.get(idx) || 0, _keywordScore: keywordScores.get(idx) || 0 };
  });
  
  return rrfScores
    .filter(item => item._score > 1 / (K_RRF + items.length)) // filtrar irrelevantes
    .sort((a, b) => b._score - a._score)
    .slice(0, topK);
}

/**
 * INDEXAR: generar y guardar embeddings en la DB
 * Se llama en `akdd sync` — procesa en background los nodos sin embedding
 * 
 * @param {object} db - adapter de grafo.cjs
 * @param {number} batchSize - cuántos nodos procesar por llamada (evitar OOM)
 */
async function indexarPendientes(db, batchSize) {
  batchSize = batchSize || 50;
  if (!isAvailable()) return { indexados: 0, motivo: 'transformers no instalado' };
  
  // Nodos procedurales sin embedding
  const nodosSinEmb = db.all(
    "SELECT id, titulo, contenido, area FROM nodos WHERE estado='ACTIVO' AND (embedding IS NULL OR embedding='') LIMIT ?",
    batchSize
  );
  
  // Episodios sin embedding (los más recientes primero)
  const episodiosSinEmb = db.all(
    "SELECT id, descripcion, accion_tomada, razon_resultado, area FROM episodios WHERE (embedding IS NULL OR embedding='') ORDER BY fecha DESC LIMIT ?",
    Math.floor(batchSize / 2)
  );
  
  let indexados = 0;
  
  // Indexar nodos
  for (const nodo of nodosSinEmb) {
    const text = `${nodo.titulo} ${nodo.area} ${(nodo.contenido || '').slice(0, 500)}`;
    const emb = await embed(text);
    if (emb) {
      try {
        db.run('UPDATE nodos SET embedding=?, embedding_modelo=? WHERE id=?',
          JSON.stringify(emb), MODELO, nodo.id);
        indexados++;
      } catch(e) {}
    }
  }
  
  // Indexar episodios
  for (const ep of episodiosSinEmb) {
    const text = [ep.descripcion, ep.accion_tomada, ep.razon_resultado, ep.area]
      .filter(Boolean).join(' ').slice(0, 600);
    const emb = await embed(text);
    if (emb) {
      try {
        db.run('UPDATE episodios SET embedding=? WHERE id=?', JSON.stringify(emb), ep.id);
        indexados++;
      } catch(e) {}
    }
  }
  
  return { indexados, disponibles: nodosSinEmb.length + episodiosSinEmb.length };
}

/**
 * Instalar @xenova/transformers si no está disponible
 * Se llama desde `akdd init` o manualmente
 */
function instalar() {
  const { execSync } = require('child_process');
  try {
    console.log('  Instalando @xenova/transformers (~23MB)...');
    execSync('npm install @xenova/transformers --save-optional', { 
      stdio: 'inherit', cwd: process.cwd() 
    });
    _available = null; // resetear cache
    console.log('  ✓ Embeddings locales instalados');
    return true;
  } catch(e) {
    console.log('  ⚠ No se pudo instalar — búsqueda por keyword disponible');
    return false;
  }
}

module.exports = {
  embed,
  cosineSim,
  parseEmb,
  buscarHibridoVectorial,
  indexarPendientes,
  isAvailable,
  instalar,
  MODELO,
  DIM
};
