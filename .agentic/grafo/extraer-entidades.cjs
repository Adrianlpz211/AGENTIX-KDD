#!/usr/bin/env node
'use strict';

/**
 * Agentic KDD — Extractor automático de entidades
 * 
 * Lee texto en lenguaje natural (un error, un patrón, una decisión)
 * y usa Claude para extraer entidades y relaciones automáticamente.
 * 
 * Uso: node extraer-entidades.js "<texto>" <tipo>
 * Ejemplo: node extraer-entidades.js "El modal de clientes pierde datos al abrir el modal de seguro" error
 */

const path = require('path');
const fs = require('fs');
const https = require('https');

const ROOT = path.join(__dirname, '..', '..');
const MEMORIA_PATH = path.join(ROOT, '.agentic', 'memoria');

// ── Llamar a Claude para extraer entidades ─────────────────────
async function extraerConClaude(texto, tipo) {
  return new Promise((resolve, reject) => {
    const prompt = `Analiza este texto de desarrollo de software y extrae entidades y relaciones.

Texto: "${texto}"
Tipo de entrada: ${tipo} (error | patron | decision)

Responde SOLO con JSON válido, sin markdown, sin explicaciones:
{
  "titulo": "título descriptivo corto (max 60 chars)",
  "area": "nombre del módulo o área afectada (una sola palabra, minúsculas)",
  "entidades": [
    {
      "nombre": "nombre de la entidad",
      "tipo": "modulo | componente | tabla | endpoint | variable | patron"
    }
  ],
  "relaciones": [
    {
      "desde": "nombre entidad origen",
      "tipo": "causa | resuelve | afecta | depende_de | interactua_con",
      "hacia": "nombre entidad destino"
    }
  ],
  "confianza": "BAJA",
  "resumen": "descripción del problema/patrón/decisión en una línea"
}`;

    const body = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }]
    });

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    // Buscar API key en el entorno
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      options.headers['x-api-key'] = apiKey;
    }

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          if (response.error) {
            reject(new Error(response.error.message));
            return;
          }
          const content = response.content?.[0]?.text || '';
          const clean = content.replace(/```json|```/g, '').trim();
          const parsed = JSON.parse(clean);
          resolve(parsed);
        } catch (e) {
          reject(new Error('No se pudo parsear la respuesta de Claude'));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Formatear resultado como entrada .md ───────────────────────
function formatearComoMd(resultado, tipo, textoOriginal) {
  const fecha = new Date().toISOString().split('T')[0];
  const area = resultado.area || 'global';

  let md = `\n## [${fecha}] ${area} — ${resultado.titulo}\n`;
  md += `Área: ${area}\n`;
  md += `Confianza: BAJA\n`;
  md += `Aplicado: 0\n`;
  md += `Útil: 0\n`;
  md += `Estado: ACTIVO\n`;

  if (tipo === 'error') {
    md += `Síntoma: ${resultado.resumen}\n`;
    md += `Causa: detectada automáticamente\n`;
    md += `Solución: pendiente\n`;
    md += `Evitar: ver síntoma\n`;
    md += `Aplicar cuando: situación similar\n`;
  } else if (tipo === 'patron') {
    md += `Regla: ${resultado.resumen}\n`;
    md += `Razón: detectada automáticamente\n`;
    md += `Aplica a: ${area}\n`;
  } else if (tipo === 'decision') {
    md += `Decisión: ${resultado.resumen}\n`;
    md += `Razón: detectada automáticamente\n`;
    md += `Impacto: ${area}\n`;
  }

  // Entidades detectadas
  if (resultado.entidades?.length > 0) {
    md += `\nEntidades detectadas:\n`;
    resultado.entidades.forEach(e => {
      md += `  - [${e.tipo}] ${e.nombre}\n`;
    });
  }

  // Relaciones detectadas
  if (resultado.relaciones?.length > 0) {
    md += `\nRelaciones:\n`;
    resultado.relaciones.forEach(r => {
      md += `  - ${r.desde} → ${r.tipo} → ${r.hacia}\n`;
    });
  }

  md += `\nTexto original: "${textoOriginal}"\n`;

  return md;
}

// ── Agregar al archivo .md correspondiente ─────────────────────
function agregarAMemoria(md, tipo) {
  const archivos = {
    error: 'errores.md',
    patron: 'patrones.md',
    decision: 'decisiones.md'
  };

  const archivo = archivos[tipo] || 'errores.md';
  const filePath = path.join(MEMORIA_PATH, archivo);

  if (!fs.existsSync(filePath)) {
    console.error(`No se encontró ${archivo}`);
    return;
  }

  fs.appendFileSync(filePath, md, 'utf8');
  console.log(`✓ Agregado a ${archivo}`);
}

// ── Main ───────────────────────────────────────────────────────
async function main() {
  const texto = process.argv[2];
  const tipo = process.argv[3] || 'error';

  if (!texto) {
    console.log('Uso: node extraer-entidades.js "<texto>" <tipo>');
    console.log('Tipos: error | patron | decision');
    console.log('\nEjemplo:');
    console.log('  node extraer-entidades.js "El modal pierde datos al cerrarse" error');
    process.exit(1);
  }

  console.log(`\n🔍 Analizando texto con Claude...`);
  console.log(`Tipo: ${tipo}`);
  console.log(`Texto: "${texto}"\n`);

  try {
    const resultado = await extraerConClaude(texto, tipo);

    console.log('Entidades detectadas:');
    resultado.entidades?.forEach(e => {
      console.log(`  [${e.tipo}] ${e.nombre}`);
    });

    console.log('\nRelaciones:');
    resultado.relaciones?.forEach(r => {
      console.log(`  ${r.desde} → ${r.tipo} → ${r.hacia}`);
    });

    console.log(`\nÁrea: ${resultado.area}`);
    console.log(`Resumen: ${resultado.resumen}`);

    const md = formatearComoMd(resultado, tipo, texto);
    agregarAMemoria(md, tipo);

    console.log('\n✓ Sincronizando grafo...');
    require('child_process').execSync(
      `node "${path.join(__dirname, 'grafo.js')}" sync`,
      { stdio: 'pipe' }
    );

    console.log('✓ Listo — entidades agregadas a la memoria y al grafo\n');

  } catch (err) {
    // Si no hay API key o falla Claude, guardar el texto sin procesar
    console.log(`⚠ No se pudo usar Claude: ${err.message}`);
    console.log('Guardando texto sin procesar...\n');

    const fecha = new Date().toISOString().split('T')[0];
    const md = `\n## [${fecha}] global — Entrada sin procesar\nÁrea: global\nConfianza: BAJA\nAplicado: 0\nÚtil: 0\nEstado: ACTIVO\nContenido: ${texto}\n`;
    agregarAMemoria(md, tipo);
  }
}

main();

module.exports = { extraerConClaude, formatearComoMd };
