#!/usr/bin/env node
'use strict';

/**
 * Agentic KDD — Embeddings Engine v2.0
 *
 * Modelo DEFAULT: jina-embeddings-v2-base-code (Jina AI)
 *   - 137M parámetros entrenados en CODE + texto natural (bimodal NL-PL)
 *   - 768 dimensiones vs 384 de all-MiniLM
 *   - Entiende relaciones lógicas de tipos, AST, control de flujo
 *   - ~500MB instalado, 100% offline
 *
 * Fallback automático si jina no está: all-MiniLM-L6-v2 (384 dims, ~23MB)
 *
 * Gap cerrado: all-MiniLM-L6-v2 fue entrenado en NL natural, no en código.
 * UniXcoder/jina mapean correctamente la semántica formal de lenguajes de programación.
 *
 * Uso:
 *   node embeddings.cjs embed "function calculateTotal(price, qty)"
 *   node embeddings.cjs status
 *   node embeddings.cjs install-jina
 *   node embeddings.cjs install-mini   (fallback ligero)
 */

const path = require('path');
const fs   = require('fs');
const { execSync } = require('child_process');

// ─── MODELOS ──────────────────────────────────────────────────────────────────

const MODELS = {
  // Modelo primario: bimodal NL-PL, específico para código
  JINA_CODE: {
    id:   'jinaai/jina-embeddings-v2-base-code',
    name: 'jina-embeddings-v2-base-code',
    dims: 768,
    size: '~500MB',
    type: 'bimodal_nlpl',
    description: 'Entrenado en código + texto. Entiende relaciones de tipos, AST, control de flujo.',
  },
  // Fallback: modelo NL general, ligero
  MINI_LM: {
    id:   'Xenova/all-MiniLM-L6-v2',
    name: 'all-MiniLM-L6-v2',
    dims: 384,
    size: '~23MB',
    type: 'natural_language',
    description: 'Modelo NL general. Fallback cuando jina no está instalado.',
  },
};

// ─── ESTADO INTERNO ───────────────────────────────────────────────────────────

let _pipeline = null;
let _activeModel = null;
let _available = null;

// ─── DETECCIÓN DE MODELO DISPONIBLE ──────────────────────────────────────────

function detectAvailableModel(projectRoot) {
  if (_available !== null) return _available;

  // 1. Verificar si jina está en cache local del proyecto
  const localCache = path.join(projectRoot || process.cwd(), '.agentic', '.model_cache');
  if (fs.existsSync(localCache)) {
    const jinaDir = path.join(localCache, 'models--jinaai--jina-embeddings-v2-base-code');
    if (fs.existsSync(jinaDir)) {
      _available = 'jina';
      return 'jina';
    }
  }

  // 2. Verificar cache global de HuggingFace
  const hfCache = path.join(require('os').homedir(), '.cache', 'huggingface', 'hub');
  if (fs.existsSync(hfCache)) {
    const jinaGlobal = path.join(hfCache, 'models--jinaai--jina-embeddings-v2-base-code');
    if (fs.existsSync(jinaGlobal)) {
      _available = 'jina';
      return 'jina';
    }
  }

  // 3. Verificar si @xenova/transformers está instalado
  try {
    require.resolve('@xenova/transformers');
    // MiniLM siempre descargable si transformers está
    _available = 'mini';
    return 'mini';
  } catch {}

  _available = false;
  return false;
}

// ─── CARGAR PIPELINE ─────────────────────────────────────────────────────────

async function getPipeline(projectRoot) {
  if (_pipeline) return { pipeline: _pipeline, model: _activeModel };

  const available = detectAvailableModel(projectRoot || process.cwd());

  if (!available) {
    return { pipeline: null, model: null };
  }

  try {
    process.env.TRANSFORMERS_VERBOSITY = 'error';
    const { pipeline, env } = require('@xenova/transformers');

    // Usar cache local del proyecto si existe
    const localCache = path.join(projectRoot || process.cwd(), '.agentic', '.model_cache');
    if (fs.existsSync(localCache)) env.cacheDir = localCache;

    const model = available === 'jina' ? MODELS.JINA_CODE : MODELS.MINI_LM;
    _activeModel = model;

    _pipeline = await pipeline('feature-extraction', model.id, { quantized: true });

    return { pipeline: _pipeline, model };
  } catch (e) {
    _available = false;
    return { pipeline: null, model: null };
  }
}

// ─── GENERAR EMBEDDING ────────────────────────────────────────────────────────

/**
 * Genera embedding para código o texto.
 * Retorna array de dims (768 con jina, 384 con mini) o null si no disponible.
 */
async function embed(text, projectRoot) {
  const { pipeline: pipe } = await getPipeline(projectRoot);
  if (!pipe) return null;
  try {
    const output = await pipe(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
  } catch { return null; }
}

// ─── SIMILITUD COSENO ────────────────────────────────────────────────────────

function cosineSim(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ─── BÚSQUEDA SEMÁNTICA ───────────────────────────────────────────────────────

/**
 * Búsqueda semántica sobre un array de items.
 * @param {string} query - consulta en lenguaje natural o código
 * @param {Array} items - [{id, texto, embedding}]
 * @param {number} topK
 */
async function semanticSearch(query, items, topK = 10, projectRoot) {
  const queryEmbed = await embed(query, projectRoot);
  if (!queryEmbed) return items.slice(0, topK); // fallback sin embeddings

  const scored = items
    .filter(item => item.embedding && Array.isArray(item.embedding))
    .map(item => ({
      ...item,
      score: cosineSim(queryEmbed, item.embedding),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return scored;
}

// ─── STATUS ───────────────────────────────────────────────────────────────────

async function getStatus(projectRoot) {
  const available = detectAvailableModel(projectRoot || process.cwd());
  const model = available === 'jina' ? MODELS.JINA_CODE : available === 'mini' ? MODELS.MINI_LM : null;

  return {
    available: !!available,
    active_model: model?.name || 'none',
    model_type: model?.type || 'none',
    dims: model?.dims || 0,
    size: model?.size || 'N/A',
    description: model?.description || 'Sin modelo de embeddings instalado',
    recommended: 'jina-embeddings-v2-base-code',
    install_command: available === 'jina' ? 'Ya instalado ✅' : 'akdd jina-install',
    gap_status: available === 'jina'
      ? '✅ Modelo bimodal NL-PL activo — semántica de código precisa'
      : available === 'mini'
        ? '⚠️  Usando all-MiniLM-L6-v2 — no optimizado para código. Ejecutar: akdd jina-install'
        : '❌ Sin embeddings — búsqueda semántica desactivada. Ejecutar: akdd embed-install',
  };
}

// ─── INSTALACIÓN ─────────────────────────────────────────────────────────────

/**
 * Instalar jina-embeddings-v2-base-code (modelo primario recomendado).
 * ~500MB. Se guarda en .agentic/.model_cache para uso offline.
 */
async function installJina(projectRoot) {
  projectRoot = projectRoot || process.cwd();
  console.log('\n[EMBEDDINGS] Instalando jina-embeddings-v2-base-code...');
  console.log('[EMBEDDINGS] Tamaño: ~500MB. Puede tomar 5-10 minutos.');
  console.log('[EMBEDDINGS] Modelo bimodal NL-PL — entrenado específicamente en código.\n');

  // Verificar que @xenova/transformers está instalado
  try {
    require.resolve('@xenova/transformers');
  } catch {
    console.log('[EMBEDDINGS] Instalando @xenova/transformers primero...');
    execSync('npm install @xenova/transformers --save-dev', {
      stdio: 'inherit',
      cwd: projectRoot,
    });
  }

  // Descargar el modelo
  try {
    process.env.TRANSFORMERS_VERBOSITY = 'info';
    const { pipeline, env } = require('@xenova/transformers');
    const localCache = path.join(projectRoot, '.agentic', '.model_cache');
    fs.mkdirSync(localCache, { recursive: true });
    env.cacheDir = localCache;

    console.log('[EMBEDDINGS] Descargando modelo...');
    const pipe = await pipeline('feature-extraction', MODELS.JINA_CODE.id, { quantized: true });

    // Test
    const testEmbed = await pipe('function test() { return 1; }', { pooling: 'mean', normalize: true });
    if (testEmbed && testEmbed.data.length > 0) {
      console.log(`\n[EMBEDDINGS] ✅ jina-embeddings-v2-base-code instalado.`);
      console.log(`[EMBEDDINGS] Dimensiones: ${testEmbed.data.length}`);
      console.log(`[EMBEDDINGS] Búsqueda semántica de código ahora es precisa.\n`);
      _available = 'jina';
      _pipeline = pipe;
    }
  } catch (e) {
    console.error('[EMBEDDINGS] Error instalando jina:', e.message);
    console.log('[EMBEDDINGS] Alternativa: akdd embed-install (all-MiniLM-L6-v2, 23MB)\n');
  }
}

/**
 * Instalar all-MiniLM-L6-v2 (fallback ligero, ~23MB).
 */
async function installMini(projectRoot) {
  projectRoot = projectRoot || process.cwd();
  console.log('\n[EMBEDDINGS] Instalando all-MiniLM-L6-v2 (modelo ligero, 23MB)...');
  console.log('[EMBEDDINGS] Nota: este modelo es para texto natural, no optimizado para código.');
  console.log('[EMBEDDINGS] Para precisión máxima en código: akdd jina-install\n');

  try {
    require.resolve('@xenova/transformers');
  } catch {
    execSync('npm install @xenova/transformers --save-dev', { stdio: 'inherit', cwd: projectRoot });
  }

  try {
    const { pipeline, env } = require('@xenova/transformers');
    const localCache = path.join(projectRoot, '.agentic', '.model_cache');
    fs.mkdirSync(localCache, { recursive: true });
    env.cacheDir = localCache;

    const pipe = await pipeline('feature-extraction', MODELS.MINI_LM.id, { quantized: true });
    console.log('\n[EMBEDDINGS] ✅ all-MiniLM-L6-v2 instalado como fallback.\n');
    _available = 'mini';
    _pipeline = pipe;
  } catch (e) {
    console.error('[EMBEDDINGS] Error:', e.message);
  }
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const [,, cmd, ...args] = process.argv;
  const projectRoot = process.cwd();

  switch (cmd) {
    case 'embed':
      if (!args[0]) { console.error('Uso: embeddings.cjs embed "<texto>"'); break; }
      embed(args.join(' '), projectRoot).then(v => {
        if (!v) console.log('Sin embeddings disponibles. Ejecutar: akdd jina-install');
        else console.log(`Vector [${v.length} dims]: [${v.slice(0,4).map(x=>x.toFixed(4)).join(', ')}...]`);
      });
      break;

    case 'status':
      getStatus(projectRoot).then(s => {
        console.log('\n=== Embeddings Status ===');
        console.log(`Modelo activo: ${s.active_model}`);
        console.log(`Tipo:          ${s.model_type}`);
        console.log(`Dimensiones:   ${s.dims}`);
        console.log(`Gap:           ${s.gap_status}`);
        console.log(`Instalar:      ${s.install_command}\n`);
      });
      break;

    case 'install-jina':
      installJina(projectRoot).catch(console.error);
      break;

    case 'install-mini':
      installMini(projectRoot).catch(console.error);
      break;

    default:
      console.log('Uso: embeddings.cjs [embed <text> | status | install-jina | install-mini]');
  }
}

module.exports = { embed, cosineSim, semanticSearch, getStatus, installJina, installMini, detectAvailableModel, MODELS };
