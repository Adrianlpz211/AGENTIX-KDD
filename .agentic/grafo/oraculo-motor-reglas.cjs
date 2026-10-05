'use strict';

/**
 * Motor `reglas` del juez tipado: heurísticas locales, deterministas, sin red.
 *
 * Es el motor de referencia del experimento en modo sombra. No es un modelo ni
 * aprende: sus probabilidades salen de creencias a priori escritas aquí abajo,
 * y la calibración de verdad se mide después contra las etiquetas (ver
 * decision-oracle.cjs, `metricas`). Mientras no haya datos suficientes, estas
 * probabilidades son opiniones con número, no hechos.
 *
 * Contrato: evaluar(pregunta, estado) → { p, razones[], externo:false }
 *   p        probabilidad de que la respuesta sea "sí"
 *   razones  por qué (a diferencia de un modelo cerrado, aquí se puede explicar)
 *
 * Nunca lanza: una entrada rara da una respuesta de baja información, no un error.
 */

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const sigmoide = (z) => 1 / (1 + Math.exp(-z));
const logit = (p) => Math.log(p / (1 - p));

/* ── Q0 · ¿es una tarea de desarrollo? ─────────────────────────────────────
   Las reglas replican la detección que ya describe CLAUDE.md: prefijo explícito,
   verbo de acción técnica al inicio, mención de archivo; y en contra, forma de
   pregunta o de conversación. */

const PREFIJO_EXPLICITO = /^\s*(aa|ag|audit|akdd)\s*:/i;
const PREFIJO_TECNICO = /^\s*(fix|feat|build|dev|chore)\s*:/i;
const VERBO_ACCION = /^\s*(implementa|implementar|crea|crear|arregla|arreglar|agrega|agregar|añade|añadir|modifica|modificar|refactoriza|refactorizar|conecta|conectar|integra|integrar|genera|generar|construye|construir|desarrolla|desarrollar|corrige|corregir|actualiza|actualizar|migra|migrar|convierte|convertir|extrae|extraer|aplica|aplicar|haz que|necesito que|cambia|cambiar|elimina|eliminar|mueve|mover|renombra|renombrar)\b/i;
const PALABRA_PREGUNTA = /^\s*(¿|explícame|explicame|qué es|que es|cómo funciona|como funciona|cuándo|cuando|por qué|por que|dónde|donde|muéstrame|muestrame|dame|qué piensas|que piensas|puedes explicar|me explicas)/i;
const TERMINA_PREGUNTA = /\?\s*$/;
const ARCHIVO = /(?:\b[\w.-]+\/[\w./-]+|\b[\w-]+\.(?:js|cjs|mjs|ts|tsx|jsx|py|sql|md|json|css|html|yml|yaml)\b)/i;
const MARCA_CONVERSACION = /\b(creo que|me parece|no entiendo|sigo sin|gracias|jaja|perfecto|entonces|a ver|osea|o sea|por cierto|cierto)\b/i;

function q0(estado) {
  const txt = String((estado && estado.tarea) || '').trim();
  const razones = [];
  if (!txt) return { p: 0.5, razones: ['sin texto: sin información'] };
  if (PREFIJO_EXPLICITO.test(txt)) return { p: 0.99, razones: ['prefijo explícito de comando (aa:/ag:/audit:)'] };
  if (PREFIJO_TECNICO.test(txt)) return { p: 0.97, razones: ['prefijo técnico (fix:/feat:/…)'] };
  let z = 0;
  if (VERBO_ACCION.test(txt)) { z += 2.0; razones.push('empieza con verbo de acción técnica'); }
  if (PALABRA_PREGUNTA.test(txt)) { z -= 2.5; razones.push('empieza como pregunta o petición de explicación'); }
  if (TERMINA_PREGUNTA.test(txt)) { z -= 2.0; razones.push('termina en signo de interrogación'); }
  if (ARCHIVO.test(txt)) { z += 1.2; razones.push('menciona un archivo o ruta'); }
  if (txt.length > 600) { z -= 1.0; razones.push('texto muy largo (típico de conversación o pegado)'); }
  if (txt.length < 8) { z -= 1.5; razones.push('texto demasiado corto'); }
  if (MARCA_CONVERSACION.test(txt)) { z -= 1.0; razones.push('marcas de conversación'); }
  if (!razones.length) razones.push('sin señales: probabilidad neutra');
  return { p: clamp(sigmoide(z), 0.02, 0.98), razones };
}

/* ── Q1 · ¿el ciclo terminará con un problema detectado por los controles? ───
   A priori por nivel de la predicción existente. NO se aprenden del registro: el
   registro es la verdad con la que se evalúa, y aprender de él aquí mezclaría
   entrenamiento y examen. */

const PRIOR_POR_NIVEL = Object.freeze({ BAJO: 0.05, MEDIO: 0.12, ALTO: 0.25 });
const PRIOR_SIN_NIVEL = 0.10;
const ZONA_CRITICA = /\b(auth|autenticaci[oó]n|middleware|\.env|secret|jwt|token|password|contrase[ñn]a|migraci[oó]n|schema|prisma|rls|permiso|rol(es)?)\b/i;
const OPERACION_DESTRUCTIVA = /\b(borra|borrar|elimina|eliminar|drop|delete|migra|migrar|deploy|despliega|publica|producci[oó]n|force|truncate)\b/i;
const CAMBIO_MENOR = /\b(typo|texto|copy|readme|docs?|comentario|renombra)\b/i;

function q1(estado) {
  const e = estado || {};
  const nivel = String(e.nivel || '').toUpperCase();
  const razones = [];
  let base;
  if (PRIOR_POR_NIVEL[nivel] != null) { base = PRIOR_POR_NIVEL[nivel]; razones.push(`nivel de la predicción existente: ${nivel}`); }
  else { base = PRIOR_SIN_NIVEL; razones.push('sin nivel previo: prior general'); }

  const texto = String(e.tarea || '');
  /* Una conversación no es un ciclo: no hay trabajo que pueda romperse. */
  if (!texto.trim() || q0({ tarea: texto }).p < 0.3) {
    return { p: 0.03, razones: ['no parece una tarea de desarrollo: sin trabajo que pueda fallar'] };
  }

  let z = logit(base);
  if (ZONA_CRITICA.test(texto)) { z += 0.7; razones.push('menciona una zona crítica (auth, permisos, datos, migración)'); }
  if (OPERACION_DESTRUCTIVA.test(texto)) { z += 0.6; razones.push('menciona una operación destructiva o de despliegue'); }
  if (Array.isArray(e.archivos) && e.archivos.length >= 8) { z += 0.4; razones.push('toca 8 o más archivos'); }
  if (CAMBIO_MENOR.test(texto)) { z -= 0.4; razones.push('parece un cambio menor'); }
  return { p: clamp(sigmoide(z), 0.01, 0.95), razones };
}

/* ── Q2 · ¿toca un valor de negocio protegido? ───────────────────────────────
   Las claves son las que ya vigila el Spec Gate (CLAUDE.md); las palabras de
   negocio son una señal más débil. */

const CLAVES_SPEC = /\b(trial_days|trial_period|yearly_discount|password_min|invoice_prefix|max_users|max_api_calls|rate_limit|timeout)\b/i;
const PALABRA_NEGOCIO = /\b(precio|tarifa|descuento|plan(es)?|comisi[oó]n|impuesto|iva|pol[ií]tica de cancelaci[oó]n|d[ií]as de prueba|facturaci[oó]n|cobro|suscripci[oó]n)\b/i;

function q2(estado) {
  const texto = String((estado && estado.tarea) || '');
  if (CLAVES_SPEC.test(texto)) return { p: 0.85, razones: ['nombra un valor que el Spec Gate vigila'] };
  if (PALABRA_NEGOCIO.test(texto)) return { p: 0.45, razones: ['menciona un concepto de negocio (precio, plan, descuento…)'] };
  return { p: 0.03, razones: ['sin señales de valores de negocio'] };
}

const POR_PREGUNTA = { Q0: q0, Q1: q1, Q2: q2 };

function evaluar(pregunta, estado) {
  const f = POR_PREGUNTA[pregunta && pregunta.id];
  if (!f) return { p: 0.5, razones: ['pregunta no soportada por el motor de reglas'], soportada: false, externo: false };
  try {
    const r = f(estado);
    return { p: r.p, razones: r.razones, soportada: true, externo: false };
  } catch (e) {
    return { p: 0.5, razones: ['error interno del motor: ' + e.message], soportada: true, externo: false };
  }
}

module.exports = { nombre: 'reglas', version: '1', externo: false, evaluar, PRIOR_POR_NIVEL };
