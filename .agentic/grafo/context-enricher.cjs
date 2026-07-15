#!/usr/bin/env node
'use strict';
/**
 * Agentic KDD — Context Enricher (Fase 1 del Sistema de Agentes Lite)
 *
 * Corre ANTES del Paso 1 del pipeline aa:, invocado por
 * .agentic/agentes/01-orquestador.md. Consulta la memoria del proyecto
 * (episódica/procedimental vía kdd-memory.recall, contratos activos,
 * alertas pendientes de Creative Engine) y arma un brief estructurado
 * para que el Orquestador arranque con contexto real en vez de una tarea
 * pelada.
 *
 * GARANTÍA (regla no negociable del brief que originó esto): nunca bloquea.
 * Si la DB no existe, si recall() falla, si cualquier query truena — el
 * script igual imprime un brief (vacío si hace falta) y sale con código 0.
 * El pipeline sigue funcionando exactamente igual que si esto no existiera.
 *
 * Uso:
 *   node context-enricher.cjs "crear el modal de pagos"
 *
 * Salida: Markdown por stdout, pensado para que el Orquestador lo lea y
 * lo incorpore a su propio razonamiento antes de empezar el pipeline.
 */

const fs   = require('fs');
const path = require('path');

const ROOT       = process.cwd();
const DB_PATH     = path.join(ROOT, '.agentic', 'memoria.db');

function openDB() {
  try { return new (require('better-sqlite3'))(DB_PATH, { readonly: true }); } catch {}
  try { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(DB_PATH, { readOnly: true }); } catch {}
  return null;
}

function emptyBrief(task) {
  return { tarea: task, contexto: [], dependencias: [], riesgo: 'BAJO', avisos: [], faltante: [] };
}

async function enrich(task) {
  const brief = emptyBrief(task);

  if (!task || !task.trim()) {
    brief.faltante.push('No se recibió texto de tarea — nada que enriquecer.');
    return brief;
  }
  if (!fs.existsSync(DB_PATH)) {
    brief.faltante.push('Sin memoria.db todavía — corre "akdd sync" para tener contexto real de aquí en adelante.');
    return brief;
  }

  // 1. Memoria episódica/procedimental — reusa kdd-memory.recall (BM25 + vectorial + RRF),
  //    no reinventa búsqueda.
  try {
    const kddMemory = require(path.join(__dirname, 'kdd-memory.cjs'));
    const recallResult = await kddMemory.recall(task, { topK: 6 }, ROOT);
    brief.contexto = (recallResult.results || []).map(r => ({
      tipo: r.tipo, titulo: r.titulo, area: r.area, confianza: r.confianza,
    }));
  } catch { /* recall es un plus, no un requisito */ }

  const db = openDB();
  if (!db) return brief;

  try {
    // 1.5. Símbolos de código realmente mencionados (Bloque B + cruce del
    //    15/07/2026) — hasta ahora el brief decía "ya existe un error resuelto
    //    sobre login" pero nunca decía EXACTAMENTE qué endpoint/archivo. Dos
    //    fuentes, ambas precisas (nunca por coincidencia de texto suelto):
    //    (a) lo que el contexto YA encontrado por recall() menciona de verdad
    //        (relaciones_semanticas, ya filtrado por backticks en grafo.cjs);
    //    (b) si la TAREA ACTUAL cita algo entre backticks, match exacto contra
    //        ast_symbols — misma convención, evita falsos positivos con
    //        palabras comunes (NEGOCIO/EMBUDO/HTML también son texto normal).
    try {
      const titulosContexto = brief.contexto.map(c => `nodo:${c.tipo}:${c.titulo}`);
      if (titulosContexto.length) {
        const ph = titulosContexto.map(() => '?').join(',');
        const menciones = db.prepare(
          `SELECT desde_entidad, hacia_entidad, descripcion FROM relaciones_semanticas
           WHERE tipo='menciona_simbolo' AND desde_entidad IN (${ph})`
        ).all(...titulosContexto);
        menciones.forEach(m => {
          brief.avisos.push(`🔗 El contexto encontrado también menciona ${m.hacia_entidad} (${m.descripcion}).`);
        });
      }
      const tokensTarea = new Set([...task.matchAll(/`([^`]+)`/g)].map(m => m[1].trim()));
      if (tokensTarea.size) {
        const simbolos = db.prepare(
          "SELECT file, kind, symbol_name FROM ast_symbols WHERE kind IN ('endpoint','constant','sql_table','sql_index')"
        ).all();
        const encontrados = simbolos.filter(s => tokensTarea.has(s.symbol_name));
        encontrados.forEach(s => {
          brief.avisos.push(`🎯 La tarea menciona directamente ${s.kind}:${s.symbol_name} — definido en ${s.file}.`);
          // Búsqueda INVERSA: qué otras decisiones/errores/patrones ya mencionaron
          // este MISMO símbolo antes — esto es lo que recall() (búsqueda semántica
          // por texto) puede no encontrar si la tarea nueva usa palabras distintas
          // a la entrada vieja, pero el símbolo exacto es la misma prueba dura.
          try {
            const haciaEntidad = `${s.kind}:${s.symbol_name}`;
            const previos = db.prepare(
              `SELECT DISTINCT desde_entidad FROM relaciones_semanticas
               WHERE tipo='menciona_simbolo' AND hacia_entidad=?`
            ).all(haciaEntidad);
            previos.forEach(p => {
              const titulo = p.desde_entidad.replace(/^nodo:(error|decision|patron):/, '');
              brief.avisos.push(`📜 Historial: ${haciaEntidad} ya fue mencionado antes en "${titulo.slice(0,80)}" — revisa si sigue vigente.`);
            });
          } catch {}
        });
      }
    } catch { /* cruce de símbolos es un plus, nunca un requisito */ }

    // 2. Áreas/módulos relacionados: las que ya aparecieron en el contexto
    //    encontrado, más match directo de palabras de la tarea contra áreas reales.
    const areasEnContexto = [...new Set(brief.contexto.map(c => c.area).filter(Boolean))];
    const allAreas = (db.prepare("SELECT DISTINCT area FROM nodos WHERE area != 'global'").all() || [])
      .map(r => r.area).filter(Boolean);
    const taskLower = task.toLowerCase();
    const areasPorKeyword = allAreas.filter(a => taskLower.includes(String(a).toLowerCase()));
    const areas = [...new Set([...areasEnContexto, ...areasPorKeyword])];
    brief.dependencias = areas;

    if (areas.length) {
      const placeholders = areas.map(() => '?').join(',');

      // 3. Contratos activos en esas áreas — lo que no se puede romper.
      try {
        const contratos = db.prepare(
          `SELECT module, status, COUNT(*) n FROM verified_contracts WHERE module IN (${placeholders}) GROUP BY module, status`
        ).all(...areas);
        contratos.forEach(c => {
          if (c.status === 'protected' || c.status === 'verified') {
            brief.avisos.push(`"${c.module}" tiene ${c.n} contrato(s) en estado ${c.status} — no los rompas en silencio.`);
          }
        });
      } catch {}

      // 4. Alertas activas de Creative Engine en esas áreas (incluye la nueva
      //    detección de causa raíz recurrente) — si hay una, sube el riesgo.
      try {
        const alertas = db.prepare(
          `SELECT type, title FROM creative_suggestions WHERE area IN (${placeholders}) AND applied=0 AND dismissed=0 AND type IN ('ROOT_CAUSE','FRAGILITY')`
        ).all(...areas);
        if (alertas.length) {
          brief.riesgo = 'ALTO';
          alertas.forEach(a => brief.avisos.push(`⚠️ Alerta activa sin resolver en esta área: ${a.title}`));
        }
      } catch {}

      // 5. Reglas de confianza ALTA en esas áreas — lo que ya se decidió y probó.
      try {
        const reglas = db.prepare(
          `SELECT titulo FROM nodos WHERE tipo='patron' AND confianza='ALTA' AND area IN (${placeholders})`
        ).all(...areas);
        reglas.forEach(r => brief.avisos.push(`Regla ya establecida en esta área: ${r.titulo}`));
      } catch {}
    }

    // 6. Motor de predicción — mina patrones causales de episodios pasados
    //    ("cada vez que tocas X sin hacer Y → falla") y avisa ANTES de actuar,
    //    no solo después. Estaba escrito desde v2.2 pero nunca se llamaba desde
    //    aquí — el brief nunca lo incluía. Nunca bloquea: si no hay suficientes
    //    episodios (< 5) o algo falla, simplemente no agrega nada.
    try {
      const prediccion = require(path.join(__dirname, 'prediccion.cjs'));
      const modulo = areas[0] || 'global';
      // prediccion.cjs espera un adaptador con .all()/.get() (el que arma grafo.cjs
      // internamente), no la conexión cruda de openDB() de este archivo (que solo
      // tiene .prepare()) — sin este envoltorio, db.all(...) truena adentro de
      // minarPatronesCausales, el try/catch lo traga, y nunca hay predicción.
      const dbAdapter = {
        all: (sql, ...params) => { try { return db.prepare(sql).all(...params.flat()); } catch { return []; } },
        get: (sql, ...params) => { try { return db.prepare(sql).get(...params.flat()); } catch { return null; } },
        run: (sql, ...params) => { try { db.prepare(sql).run(...params.flat()); } catch {} },
      };
      const evaluacion = prediccion.evaluarRiesgoTarea(task, [], modulo, dbAdapter);
      if (evaluacion.tiene_alertas || evaluacion.tiene_precondiciones) {
        [...evaluacion.alertas, ...evaluacion.precondiciones].forEach(a => {
          brief.avisos.push(`🔮 Predicción: ${a.mensaje}`);
        });
        if (evaluacion.nivel_riesgo === 'ALTO') brief.riesgo = 'ALTO';
        else if (evaluacion.nivel_riesgo === 'MEDIO' && brief.riesgo === 'BAJO') brief.riesgo = 'MEDIO';
      }
    } catch { /* la predicción es un plus, nunca un requisito */ }

    if (brief.riesgo === 'BAJO' && brief.contexto.some(c => c.confianza === 'BAJA')) {
      brief.riesgo = 'MEDIO';
    }
  } catch {
    /* cualquier falla de aquí en adelante no invalida lo ya encontrado */
  } finally {
    try { db.close(); } catch {}
  }

  if (!brief.contexto.length && !brief.dependencias.length) {
    brief.faltante.push('No se encontró contexto previo relacionado — es territorio nuevo para la memoria del proyecto, procede con cautela extra y documenta bien lo que decidas.');
  }

  return brief;
}

function printBrief(brief) {
  const lines = [];
  lines.push('## Context Enricher');
  lines.push('');
  lines.push(`**Tarea:** ${brief.tarea}`);
  lines.push(`**Riesgo estimado:** ${brief.riesgo}`);
  lines.push('');

  if (brief.dependencias.length) {
    lines.push(`**Módulos/áreas relacionadas:** ${brief.dependencias.join(', ')}`);
    lines.push('');
  }
  if (brief.contexto.length) {
    lines.push('**Contexto relevante encontrado en memoria:**');
    brief.contexto.forEach(c => lines.push(`- [${c.tipo}/${c.confianza}] ${c.titulo} (${c.area})`));
    lines.push('');
  }
  if (brief.avisos.length) {
    lines.push('**Avisos:**');
    brief.avisos.forEach(a => lines.push(`- ${a}`));
    lines.push('');
  }
  if (brief.faltante.length) {
    lines.push('**Información que falta / notas:**');
    brief.faltante.forEach(f => lines.push(`- ${f}`));
  }

  console.log(lines.join('\n'));
}

if (require.main === module) {
  const task = process.argv.slice(2).join(' ');
  enrich(task)
    .then(printBrief)
    .catch(() => {
      // Última red de seguridad: pase lo que pase, nunca bloquear el pipeline.
      console.log('## Context Enricher\n\n(Sin contexto disponible ahora mismo — continuar normalmente con la tarea)');
    })
    .finally(() => process.exit(0));
}

module.exports = { enrich };
