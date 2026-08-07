'use strict';

/**
 * CSS Token Gate — verificación mecánica de la norma de tokens CSS
 * (v3.17.0, sesión del 22/07/2026).
 *
 * El problema real que motiva esto (caso salud360): los valores visuales
 * compartidos (tamaño del combo estándar, anchos de campos, colores) viven
 * copiados a mano en decenas de archivos CSS. Cuando una vista nueva se hace
 * "a su manera" y luego se ajusta, se pisan valores que otras vistas también
 * usan — y algo que llevaba 15 rondas bien se rompe en otro lado.
 *
 * La norma (03-front.md): todo valor visual repetible nace como token
 * (variable CSS en :root) y las vistas solo referencian var(--token).
 * Este gate es su mitad mecánica — mismo patrón que ui-native-gate.cjs:
 * la regla en prosa depende de que el modelo la recuerde; el gate no.
 *
 * Qué hace:
 *   1. Descubre los tokens REALES del proyecto (no una lista inventada):
 *      escanea los .css buscando definiciones `--nombre: valor` y construye
 *      el mapa valor→token.
 *   2. Modo gate (archivos del changeset): si un CSS/HTML tocado escribe a
 *      mano un valor que YA existe como token → WARN con el token exacto a
 *      usar. No inventa tokens: solo defiende los que el proyecto ya tiene.
 *   3. Modo scan (sin archivos): inventario de tokens + oportunidades de
 *      tokenización (valores no triviales repetidos ≥3 veces sin token) —
 *      es el mapa de trabajo para migrar un proyecto existente.
 *
 * Siempre WARN, nunca STOP — misma disciplina que ui-native-gate y
 * browser-gate: no bloquea el pipeline, deja el hallazgo visible y en la
 * libreta (gate_events) en vez de que pase desapercibido.
 *
 * Uso:
 *   node .agentic/grafo/css-token-gate.cjs                    → scan (inventario + oportunidades)
 *   node .agentic/grafo/css-token-gate.cjs a.css b.html ...   → gate sobre esos archivos
 */

const fs = require('fs');
const path = require('path');

const MAX_SCAN_BYTES = 2_000_000;
const EXTENSIONES_GATE = /\.(css|html|htm)$/i;
const DIRS_EXCLUIDOS = /(^|[\\\/])(node_modules|\.git|\.next|dist|build|coverage|\.agentic|\.claude|_output)([\\\/]|$)/i;

// Valores que jamás vale la pena tokenizar — sin esto, `width: 1px` o
// `margin: 0` generarían ruido infinito y el gate perdería credibilidad.
const VALORES_TRIVIALES = new Set([
  '0', '0px', '0%', '1px', '2px', '100%', '50%', 'auto', 'none', 'inherit',
  'initial', 'unset', 'transparent', 'normal', 'bold', 'center', 'left',
  'right', 'block', 'flex', 'grid', 'inline-block', 'hidden', 'visible',
  'relative', 'absolute', 'fixed', 'pointer', 'border-box', 'content-box',
  '1', '0.5', 'italic', 'underline', 'nowrap', 'wrap', 'column', 'row',
]);

// Propiedades cuyo valor tiene sentido tokenizar. Fuera de esta lista
// (content, animation-name, grid-template-areas...) el match por valor
// daría falsos positivos sin sentido.
const PROPS_TOKENIZABLES = /^(width|min-width|max-width|height|min-height|max-height|font-size|line-height|padding|padding-[a-z]+|margin|margin-[a-z]+|gap|row-gap|column-gap|border|border-[a-z-]+|border-radius|color|background|background-color|box-shadow|top|right|bottom|left|inset|outline|outline-color|fill|stroke|flex-basis)$/i;

function safeRead(full) {
  try {
    const stat = fs.statSync(full);
    if (!stat.isFile() || stat.size > MAX_SCAN_BYTES) return null;
    return fs.readFileSync(full, 'utf8');
  } catch { return null; }
}

// ─── Afinidad propiedad ↔ token ──────────────────────────────────────────────
// Sin esto, un `width: 8px` matchearía contra --algo-radius: 8px y el gate
// sugeriría un token de radio para un ancho — consejo semánticamente malo que
// mata la credibilidad del gate (encontrado probando contra el CSS real de
// salud360). Un color (#hex/rgb) aplica a cualquier propiedad de color, así
// que los colores no pasan por familia.

function familiaDeProp(prop) {
  const p = String(prop).toLowerCase();
  if (/^border-radius$/.test(p)) return 'radius';
  if (/^(font-size|line-height)$/.test(p)) return 'font';
  if (/^(padding|margin|gap|row-gap|column-gap|inset|top|right|bottom|left)/.test(p)) return 'espaciado';
  if (/^(width|min-width|max-width|height|min-height|max-height|flex-basis)$/.test(p)) return 'dimension';
  if (/^(color|background|background-color|border-color|outline-color|fill|stroke)$/.test(p) || /^border(-[a-z]+)?$/.test(p)) return 'color';
  if (/^box-shadow$/.test(p)) return 'sombra';
  return null;
}

function familiaDeToken(tokenName) {
  const t = String(tokenName).toLowerCase();
  if (/radius|round/.test(t)) return 'radius';
  if (/font|text-size|fs\b|lh\b|line/.test(t)) return 'font';
  if (/pad|gap|margin|space|spacing|inset/.test(t)) return 'espaciado';
  // 'size' a secas es ambiguo (--modal-title-size es font, --icon-size es
  // dimensión) — no clasifica; solo width/height explícitos.
  if (/width|height|-w$|-h$/.test(t)) return 'dimension';
  if (/shadow/.test(t)) return 'sombra';
  return null; // sin pista en el nombre → compatible con todo
}

function esValorColor(valor) {
  return /^#[0-9a-f]{6}([0-9a-f]{2})?$|^rgba?\(|^hsla?\(/i.test(String(valor).trim());
}

/** ¿Tiene sentido sugerir este token para esta propiedad? */
function tokenCompatible(prop, tokenName, valor) {
  if (esValorColor(valor)) return true; // colores: cualquier prop de color los acepta
  const fp = familiaDeProp(prop);
  const ft = familiaDeToken(tokenName);
  if (!fp || !ft) return true; // sin información suficiente → no vetar
  return fp === ft;
}

/** Elige, de los tokens con ese valor, el primero compatible con la prop. */
function tokenParaProp(tokens, prop, valor) {
  return (tokens || []).find(t => tokenCompatible(prop, t.token, valor)) || null;
}

/** Normaliza un valor CSS para comparar: espacios colapsados, hex en
 *  minúscula y expandido (#abc → #aabbcc), sin ; final. */
function normalizarValor(v) {
  let s = String(v || '').trim().replace(/;+\s*$/, '').replace(/\s+/g, ' ').toLowerCase();
  // Expandir hex corto para que #fff y #ffffff matcheen entre sí
  s = s.replace(/#([0-9a-f])([0-9a-f])([0-9a-f])\b/g, (_, r, g, b) => `#${r}${r}${g}${g}${b}${b}`);
  return s;
}

/** Quita comentarios /* *\/ de un CSS preservando los saltos de línea
 *  (los números de línea de los hallazgos siguen siendo reales). */
function sinComentarios(css) {
  return String(css).replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/** Lista los .css reales del proyecto (excluyendo node_modules etc.). */
function listarCssDelProyecto(projectRoot, limite = 400) {
  const out = [];
  const walk = (dir, depth) => {
    if (out.length >= limite || depth > 8) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (DIRS_EXCLUIDOS.test(full)) continue;
      if (e.isDirectory()) walk(full, depth + 1);
      else if (/\.css$/i.test(e.name)) out.push(full);
      if (out.length >= limite) return;
    }
  };
  walk(projectRoot, 0);
  // Copias dentro de docs/ (paquetes, ejemplos) al final — así el mapa de
  // tokens referencia la definición REAL del proyecto, no una copia.
  return out.sort((a, b) => {
    const aDocs = /[\\\/]docs?[\\\/]/i.test(a) ? 1 : 0;
    const bDocs = /[\\\/]docs?[\\\/]/i.test(b) ? 1 : 0;
    return aDocs - bDocs;
  });
}

/**
 * Descubre los tokens definidos en el proyecto: mapa valorNormalizado →
 * [{token, file}]. Ignora tokens cuyo valor es otro var() o un valor trivial.
 */
function descubrirTokens(projectRoot) {
  const porValor = new Map();
  const todos = [];
  for (const cssFile of listarCssDelProyecto(projectRoot)) {
    const content = safeRead(cssFile);
    if (content == null) continue;
    const limpio = sinComentarios(content);
    const rel = path.relative(projectRoot, cssFile).replace(/\\/g, '/');
    // --nombre: valor;  (definición de custom property, viva en cualquier regla)
    const re = /--([a-z0-9-_]+)\s*:\s*([^;}]+)[;}]/gi;
    let m;
    while ((m = re.exec(limpio)) !== null) {
      const token = `--${m[1]}`;
      const valor = normalizarValor(m[2]);
      if (!valor || valor.startsWith('var(') || VALORES_TRIVIALES.has(valor)) continue;
      todos.push({ token, valor, file: rel });
      if (!porValor.has(valor)) porValor.set(valor, []);
      const lista = porValor.get(valor);
      if (!lista.some(t => t.token === token)) lista.push({ token, file: rel });
    }
  }
  return { porValor, todos };
}

/** Extrae declaraciones prop:valor de un bloque CSS con número de línea. */
function extraerDeclaraciones(cssText) {
  const decls = [];
  const lineas = sinComentarios(cssText).split('\n');
  lineas.forEach((linea, i) => {
    // Saltar definiciones de tokens (--x: ...) — definir un token no es un hallazgo
    if (/^\s*--/.test(linea)) return;
    // Una o más declaraciones en la línea (CSS minificado parcial incluido)
    const re = /([a-z-]+)\s*:\s*([^;{}]+)/gi;
    let m;
    while ((m = re.exec(linea)) !== null) {
      const prop = m[1].toLowerCase();
      const valorCrudo = m[2];
      if (!PROPS_TOKENIZABLES.test(prop)) continue;
      if (/var\s*\(/i.test(valorCrudo)) continue; // ya usa token — es lo correcto
      decls.push({ prop, valor: normalizarValor(valorCrudo), linea: i + 1, muestra: linea.trim().slice(0, 100) });
    }
  });
  return decls;
}

/** Extrae los bloques <style> y atributos style="" de un HTML como CSS-por-línea. */
function extraerCssDeHtml(html) {
  const bloques = [];
  const lineas = String(html).split('\n');
  let dentroStyle = false;
  lineas.forEach((linea, i) => {
    if (/<style[\s>]/i.test(linea)) dentroStyle = true;
    if (dentroStyle) bloques.push({ texto: linea, linea: i + 1 });
    if (/<\/style>/i.test(linea)) dentroStyle = false;
    // style="..." inline — el mismo caso que ui-layout-memory vigila por id
    const re = /style\s*=\s*"([^"]+)"/gi;
    let m;
    while ((m = re.exec(linea)) !== null) bloques.push({ texto: m[1], linea: i + 1 });
  });
  return bloques;
}

function escanearArchivo(content, filename, porValor) {
  const findings = [];
  const esHtml = /\.(html|htm)$/i.test(filename);

  const revisar = (decls) => {
    for (const d of decls) {
      if (VALORES_TRIVIALES.has(d.valor)) continue;
      const tokens = porValor.get(d.valor);
      if (!tokens || !tokens.length) continue;
      const compatible = tokenParaProp(tokens, d.prop, d.valor);
      if (!compatible) continue; // hay token con ese valor pero de otra familia — no sugerir mal
      findings.push({
        id: 'HARDCODED_CON_TOKEN',
        severity: 'HIGH',
        file: filename,
        line: d.linea,
        prop: d.prop,
        valor: d.valor,
        token: compatible.token,
        mensaje: `${d.prop}: ${d.valor} escrito a mano — ese valor YA es el token ${compatible.token} (definido en ${compatible.file}). Usar: ${d.prop}: var(${compatible.token})`,
        muestra: d.muestra,
      });
    }
  };

  if (esHtml) {
    for (const bloque of extraerCssDeHtml(content)) {
      const decls = extraerDeclaraciones(bloque.texto).map(d => ({ ...d, linea: bloque.linea, muestra: bloque.texto.trim().slice(0, 100) }));
      revisar(decls);
    }
  } else {
    revisar(extraerDeclaraciones(content));
  }
  return findings;
}

function runCssTokenGate(files, projectRoot) {
  projectRoot = projectRoot || process.cwd();
  const { porValor } = descubrirTokens(projectRoot);

  if (porValor.size === 0) {
    return {
      passed: true,
      sinTokens: true,
      scanned: [],
      message: 'CSS TOKEN GATE — este proyecto aún no define tokens (variables CSS en :root). Sin tokens no hay nada que defender; correr `css-token-gate.cjs` sin archivos muestra las oportunidades de crearlos.',
    };
  }

  const allFindings = [];
  const scanned = [];
  (files || []).forEach(file => {
    if (!EXTENSIONES_GATE.test(file)) return;
    const full = path.isAbsolute(file) ? file : path.join(projectRoot, file);
    const content = safeRead(full);
    if (content == null) return;
    scanned.push(file);
    allFindings.push(...escanearArchivo(content, file, porValor));
  });

  // Telemetría — fail-soft total, igual que ui-native-gate
  try {
    const dbPath = path.join(projectRoot, '.agentic', 'memoria.db');
    if (allFindings.length && fs.existsSync(dbPath)) {
      const gt = require(path.join(__dirname, 'gate-telemetry.cjs'));
      let db; try { db = new (require('better-sqlite3'))(dbPath); } catch { db = new (require('node:sqlite').DatabaseSync)(dbPath); }
      allFindings.forEach(f => gt.recordGateEvent(db, { gate: 'css_token', verdict: 'WARN', file: f.file, detalle: { token: f.token, prop: f.prop, line: f.line } }));
      try { db.close(); } catch {}
    }
  } catch { /* nunca bloquea */ }

  if (allFindings.length === 0) {
    return {
      passed: true,
      scanned,
      tokens: porValor.size,
      message: `CSS TOKEN GATE PASS — ${scanned.length} archivo(s) escaneado(s) contra ${porValor.size} valor(es) tokenizado(s), sin valores hardcodeados que ya tengan token`,
    };
  }

  return {
    passed: false,
    warn: true,
    findings: allFindings,
    scanned,
    message: `CSS TOKEN GATE WARN: ${allFindings.length} valor(es) escritos a mano que YA existen como token:\n` +
      allFindings.map(f => `  🟡 ${f.file}:${f.line} — ${f.mensaje}`).join('\n'),
  };
}

/**
 * Modo scan: inventario + oportunidades de tokenización. Es el mapa de
 * trabajo para migrar un proyecto existente (salud360, Lumo...) a tokens:
 * qué tokens ya hay, y qué valores repetidos deberían serlo.
 */
function runScan(projectRoot, opts) {
  projectRoot = projectRoot || process.cwd();
  const minRepeticiones = (opts && opts.min) || 3;
  const { porValor, todos } = descubrirTokens(projectRoot);

  // Contar valores hardcodeados en todo el proyecto (para detectar repetidos sin token)
  const conteo = new Map(); // valor → { n, archivos:Set, props:Set }
  for (const cssFile of listarCssDelProyecto(projectRoot)) {
    const content = safeRead(cssFile);
    if (content == null) continue;
    const rel = path.relative(projectRoot, cssFile).replace(/\\/g, '/');
    for (const d of extraerDeclaraciones(content)) {
      if (VALORES_TRIVIALES.has(d.valor)) continue;
      if (!conteo.has(d.valor)) conteo.set(d.valor, { n: 0, archivos: new Set(), props: new Set() });
      const c = conteo.get(d.valor);
      c.n++; c.archivos.add(rel); c.props.add(d.prop);
    }
  }

  const oportunidades = [];
  const yaCubiertos = [];
  for (const [valor, c] of conteo.entries()) {
    if (c.n < minRepeticiones || c.archivos.size < 2) continue;
    const entry = {
      valor, usos: c.n, archivos: c.archivos.size,
      props: [...c.props].slice(0, 4).join(', '),
    };
    // Un token "cubre" el valor solo si es compatible con al menos una de las
    // props donde se usa — un token de radius no cubre un width del mismo valor.
    const tokensDelValor = porValor.get(valor);
    const compatible = tokensDelValor
      ? [...c.props].map(p => tokenParaProp(tokensDelValor, p, valor)).find(Boolean)
      : null;
    if (compatible) yaCubiertos.push({ ...entry, token: compatible.token });
    else oportunidades.push(entry);
  }
  oportunidades.sort((a, b) => b.usos - a.usos);
  yaCubiertos.sort((a, b) => b.usos - a.usos);

  return { tokens: todos, oportunidades, yaCubiertos };
}

if (require.main === module) {
  const files = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const root = process.cwd();

  if (!files.length) {
    const r = runScan(root, {});
    console.log('\n═══════════════════════════════════════════════════');
    console.log('  🎨 CSS Token Gate — scan del proyecto');
    console.log('═══════════════════════════════════════════════════\n');
    console.log(`  Tokens definidos: ${r.tokens.length}`);
    if (r.yaCubiertos.length) {
      console.log(`\n  ⚠️  Valores que YA tienen token pero siguen hardcodeados en ≥2 archivos:`);
      r.yaCubiertos.slice(0, 15).forEach(o =>
        console.log(`     ${o.valor}  → usar var(${o.token})  (${o.usos} usos en ${o.archivos} archivos: ${o.props})`));
    }
    if (r.oportunidades.length) {
      console.log(`\n  💡 Oportunidades de tokenización (repetidos sin token, ≥3 usos, ≥2 archivos):`);
      r.oportunidades.slice(0, 20).forEach(o =>
        console.log(`     ${o.valor}  (${o.usos} usos en ${o.archivos} archivos: ${o.props})`));
      if (r.oportunidades.length > 20) console.log(`     ... y ${r.oportunidades.length - 20} más`);
    }
    if (!r.yaCubiertos.length && !r.oportunidades.length) {
      console.log('\n  ✅ Sin valores repetidos sin token — el proyecto está tokenizado o no repite valores.');
    }
    console.log('');
    process.exit(0);
  }

  const result = runCssTokenGate(files, root);
  console.log(result.passed ? '✅ ' + result.message : '⚠️  ' + result.message);
  process.exit(0); // WARN, no STOP — no bloquea el pipeline, solo avisa
}

module.exports = { runCssTokenGate, runScan, descubrirTokens, normalizarValor };
