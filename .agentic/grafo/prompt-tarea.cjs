'use strict';
/**
 * ¿Este mensaje es una tarea de desarrollo? — lo que decide si el hook trata un prompt como `aa:` sin que la persona escriba el prefijo.
 *
 * Determinista y sin red (milisegundos): reutiliza las reglas de Q0 (`oraculo-motor-reglas.cjs`: prefijo, verbo de acción, archivo,
 * forma de pregunta) y les suma lo que Q0 deja en 0,5 por no verlo: peticiones con «quiero que…», «ahora haz…», «revisa…», reportes
 * de fallo («no funciona…») y acuses de recibo («sí», «ok», «continúa») que NUNCA son tareas.
 *
 * Sesgo a propósito: un falso positivo cuesta un brief de unos segundos; un falso negativo pierde el contexto previo y la marca de
 * arranque. Pero el REGISTRO de lo hecho no depende de esto (lo dispara el commit y TEAMS), así que en duda NO se enriquece.
 * Q0 sigue midiéndose en sombra sin tocarse: aquí solo se LEE.
 */
const fs = require('fs');
const path = require('path');

const UMBRAL = 0.6;

const EXPLICITO = /^\s*aa\s*:/i;
const COMANDO_AJENO = /^\s*(audit|ag|ws|ntfy|teams|akdd)\s*:/i;        // otros prefijos de comando: no son tareas del pipeline
const PALABRA_ACUSE = '(?:s[ií]|no|ok|okay|dale|adelante|contin[uú]a|continua|sigue|gracias|muchas gracias|listo|perfecto|genial|bien|vale|claro|entiendo|de acuerdo|va|hecho|ya|excelente|buen[ií]simo)';
const ACUSE = new RegExp('^\\s*(?:' + PALABRA_ACUSE + '[\\s.!¡,;:)-]*)+$', 'i');
const ACUSE_INICIAL = new RegExp('^\\s*(?:' + PALABRA_ACUSE + '[\\s.!¡,;:-]+)+', 'i');   // «ok gracias, ahora hazlo…»: se quita el acuse y se mira lo que sigue
const IMPERATIVO_EN_CLAUSULA = /^[^.?!\n]{0,60}?\b(repara|arregla|corrige|implementa|agrega|a[ñn]ade|crea|haz|hazlo|revisa|cambia|quita|pon|mejora|optimiza|soluciona|resuelve|investiga|elimina|migra|actualiza|conecta|integra|genera)\b/i;
const PETICION_CORTES = /^\s*¿?\s*(puedes|podr[ií]as|me puedes|me podr[ií]as|me ayudas a|puedes por favor)\s+(arreglar|agregar|a[ñn]adir|crear|implementar|revisar|cambiar|corregir|quitar|poner|mejorar|hacer|eliminar|migrar|actualizar|conectar|integrar|generar|investigar|reparar|ajustar)\b/i;
const SIGUE_CON =/^\s*(sigue|contin[uú]a|seguimos)\s+(investigando|revisando|trabajando|reparando|arreglando|con\b|en\b)/i;
const PETICION = /^\s*(quiero que|quisiera que|necesito que|necesito|requiero|ahora (haz|hazlo|quiero|necesito|arregla|agrega|añade|revisa|corrige|cambia|pon)|haz(lo)?\b|por favor[,\s]+(haz|hazlo|arregla|agrega|añade|revisa|implementa|corrige|cambia|crea|quita|pon)|revisa|corrige|ajusta|quita|pon(le|me)?\b|mejora|optimiza|soluciona|resuelve|repara|prueba que|debe(r[ií]a)? (ser|mostrar|salir|tener))/i;
const SINTOMA = /\b(no funciona|no sirve|no carga|no aparece|no deja|se rompe|se rompi[oó]|falla|fall[oó]|da error|sale error|bug|crash|se cae|queda en blanco)\b/i;
const SOLO_PREGUNTA = /^\s*(¿|qu[eé] (es|son|hace|significa)|c[oó]mo (funciona|se|puedo|hago)|cu[aá]ndo|por qu[eé]|d[oó]nde|cu[aá]l|cu[aá]nto|expl[ií]ca|dime|cu[eé]ntame)/i;

const sigmoide = (z) => 1 / (1 + Math.exp(-z));
const logit = (p) => Math.log(p / (1 - p));
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/**
 * @returns {{ esTarea:boolean, explicito:boolean, p:number, razones:string[] }}
 */
function clasificarPrompt(prompt) {
  const txt = String(prompt == null ? '' : prompt).trim();
  if (EXPLICITO.test(txt)) return { esTarea: true, explicito: true, p: 0.99, razones: ['prefijo explícito aa:'] };
  if (!txt) return { esTarea: false, explicito: false, p: 0, razones: ['sin texto'] };
  if (txt.startsWith('/')) return { esTarea: false, explicito: false, p: 0, razones: ['comando de barra'] };
  if (COMANDO_AJENO.test(txt)) return { esTarea: false, explicito: false, p: 0, razones: ['otro prefijo de comando (audit:/teams:/ws:/akdd…)'] };
  if (ACUSE.test(txt)) return { esTarea: false, explicito: false, p: 0.05, razones: ['acuse de recibo'] };

  let base = 0.5; let razones = [];
  try {
    const q0 = require('./oraculo-motor-reglas.cjs').evaluar({ id: 'Q0' }, { tarea: txt });
    base = q0.p; razones = (q0.razones || []).slice();
  } catch { razones.push('sin motor de reglas: solo señales locales'); }

  let z = logit(clamp(base, 0.02, 0.98));
  const pregunta = SOLO_PREGUNTA.test(txt) || /\?\s*$/.test(txt);
  const sinAcuse = txt.replace(ACUSE_INICIAL, '');   // «ok gracias, ahora hazlo también en pagos» → «ahora hazlo también en pagos»
  // «¿puedes arreglar…?» tiene forma de pregunta (Q0 la castiga) pero es una orden: se descarta el castigo de Q0 y se suma.
  if (PETICION_CORTES.test(sinAcuse)) { z = Math.max(z, 0) + 2.4; razones.push('petición cortés («¿puedes arreglar…?»)'); }
  else if (PETICION.test(sinAcuse) || SIGUE_CON.test(sinAcuse)) { z += pregunta ? 0.6 : 1.7; razones.push('es una petición («quiero que…», «haz…», «revisa…», «sigue investigando…»)'); }
  else if (!pregunta && IMPERATIVO_EN_CLAUSULA.test(sinAcuse)) { z += 1.1; razones.push('lleva un verbo de acción en la primera frase'); }
  if (SINTOMA.test(txt) && !pregunta) { z += 1.0; razones.push('reporta un fallo del sistema'); }
  const p = clamp(sigmoide(z), 0.01, 0.99);
  return { esTarea: p >= UMBRAL, explicito: false, p: Math.round(p * 100) / 100, razones };
}

/** ¿El proyecto declara estar configurado? Solo entonces el prefijo aa: es opcional. */
function proyectoConfigurado(root) {
  try {
    const t = fs.readFileSync(path.join(root, '.agentic', 'config.md'), 'utf8');
    return /^\s*CONFIGURADO:\s*(S[IÍ]|YES|TRUE)\b/im.test(t);
  } catch { return false; }
}

module.exports = { clasificarPrompt, proyectoConfigurado, UMBRAL };
