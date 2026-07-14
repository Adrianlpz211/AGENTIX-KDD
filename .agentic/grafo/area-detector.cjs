'use strict';

/**
 * Agentic KDD — Area Detector (compartido)
 *
 * Antes de este archivo, había DOS detectores de área distintos y desalineados:
 *   - watch-errors.cjs → detectarArea(linea): solo corre sobre errores en vivo
 *     (mientras el dev server está corriendo), nunca sobre errores.md/decisiones.md
 *     ya escritos.
 *   - grafo.cjs → parsearEntradas(): si una entrada de errores.md o decisiones.md
 *     no tiene una línea "Área:" explícita, cae directo a 'global' — SIN
 *     intentar inferir nada del contenido. Como el template de errores.md nunca
 *     pidió un campo "Área:", TODOS los errores (no solo los de UI) quedaban
 *     en 'global' sin importar su contenido real.
 *
 * Este módulo es la ÚNICA fuente de verdad para inferir área desde texto
 * (título + contenido de una entrada), usado como fallback cuando no hay
 * "Área:" explícita. watch-errors.cjs y grafo.cjs lo requieren los dos —
 * si mañana se agrega una palabra clave nueva, se agrega en un solo lugar.
 *
 * v1 de este archivo escaneaba el CONTENIDO COMPLETO de la entrada (título +
 * todos los párrafos, incluyendo "Impacto:"/"Contexto:" que en decisiones.md
 * suelen listar TODOS los archivos tocados, no solo los relevantes al tema
 * real). Resultado real al probarlo contra memoria.db de Lumo: una auditoría
 * de SEGURIDAD se etiquetó "frontend" solo porque su texto mencionaba de paso
 * "...antes de seguir con responsive/mobile + PWA" como próximo paso, no como
 * su tema. Y con .includes() plano, "ui" matcheaba dentro de "seguir" y
 * "construir" (substring, no palabra completa) — falsos positivos masivos.
 * v2 corrige ambos problemas: (a) solo escanea el título + la línea de
 * "asunto" de la entrada (Decisión:/Síntoma:/Regla:/Razón:), no el cuerpo
 * completo; (b) usa límites de palabra (\b) en vez de substring plano; (c)
 * cuenta matches por área y solo reasigna si un área queda CLARAMENTE al
 * frente (sin empate) — ante la duda, se queda en 'global' en vez de adivinar.
 */

const AREA_KEYWORDS = [
  { area: 'frontend', keywords: [
    'responsive', 'mobile', 'celular', 'móvil', 'viewport', 'breakpoint',
    'media query', 'css', 'tailwind', 'scss', 'estilizad',
    'sidebar', 'navbar', 'topbar',
    'dialog', 'diálogo', 'dialogo', 'modal', 'alert\\(', 'confirm\\(', 'prompt\\(',
    'tooltip', 'dropdown', 'kanban', 'drag & drop', 'drag and drop',
    'usabilidad', 'ux', 'ui', 'overflow',
    'service worker', 'sw\\.js', 'pwa', 'manifest\\.json', 'cache-first', 'network-first',
    '\\.tsx', '\\.jsx', 'componente',
  ]},
  { area: 'auth', keywords: ['auth', 'login', 'sesión', 'jwt', 'contraseña', 'seguridad', 'security', 'vulnerabilidad'] },
  { area: 'api', keywords: ['endpoint', 'controller'] },
  { area: 'database', keywords: ['database', 'prisma', 'supabase', 'postgres', 'migración'] },
  { area: 'middleware', keywords: ['middleware'] },
  { area: 'payments', keywords: ['payment', 'pago', 'stripe', 'facturación'] },
  { area: 'ai', keywords: ['ia', 'ai', 'groq', 'openrouter', 'llm'] },
];

// Campos que suelen contener el "asunto real" de una entrada, en orden de
// prioridad — se usa SOLO el primero que aparezca, no la unión de todos.
// "Razón:"/"Contexto:" suelen incluir comparaciones ("se priorizó X SOBRE Y")
// que mencionan otros temas de pasada sin ser el asunto real — mezclarlas
// con Decisión:/Síntoma:/Regla: (que sí son el hecho central) diluye la señal.
const CAMPOS_ASUNTO_PRIORIDAD = [
  ['Decisión:', 'Decision:'],
  ['Síntoma:', 'Sintoma:'],
  ['Regla:'],
  ['Razón:', 'Razon:'],
];

function extraerTextoSenal(titulo, contenido) {
  const lineas = (contenido || '').split('\n').map(l => l.trim());
  for (const prefijos of CAMPOS_ASUNTO_PRIORIDAD) {
    const linea = lineas.find(l => prefijos.some(p => l.startsWith(p)));
    if (linea) return `${titulo || ''} ${linea}`;
  }
  return titulo || '';
}

function contarMatches(texto) {
  const conteo = {};
  for (const { area, keywords } of AREA_KEYWORDS) {
    let n = 0;
    for (const kw of keywords) {
      const re = new RegExp(`\\b${kw}`, 'i'); // \b + palabra: evita "ui" dentro de "seguir"
      if (re.test(texto)) n++;
    }
    if (n > 0) conteo[area] = n;
  }
  return conteo;
}

/**
 * Infiere un área a partir de título + contenido de una entrada de
 * errores.md / decisiones.md / patrones.md. Solo mira el título y las líneas
 * de "asunto" (Decisión/Síntoma/Regla/Razón), no el cuerpo completo — así una
 * mención de paso en "Impacto:" no secuestra la clasificación. Devuelve
 * 'global' si nada matchea o si dos áreas empatan (ante la duda, no adivina).
 */
function inferirAreaDesdeTexto(tituloOTextoCompleto, contenidoOpcional) {
  // Compat: puede llamarse con (texto único) o con (titulo, contenido)
  const texto = contenidoOpcional !== undefined
    ? extraerTextoSenal(tituloOTextoCompleto, contenidoOpcional)
    : (tituloOTextoCompleto || '');

  const conteo = contarMatches(texto);
  const entradas = Object.entries(conteo).sort((a, b) => b[1] - a[1]);
  if (entradas.length === 0) return 'global';
  if (entradas.length > 1 && entradas[0][1] === entradas[1][1]) return 'global'; // empate → no adivinar
  return entradas[0][0];
}

module.exports = { inferirAreaDesdeTexto, AREA_KEYWORDS };
