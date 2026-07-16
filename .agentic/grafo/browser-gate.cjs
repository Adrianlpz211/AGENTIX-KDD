'use strict';

/**
 * Browser Gate — verificación mecánica en navegador real (Bloque A, sesión
 * del 15/07/2026). Mismo espíritu que ui-native-gate.cjs / security-gate.cjs:
 * un chequeo determinístico que no depende de que el agente se acuerde de
 * abrir el navegador (regla que hoy solo vive como instrucción manual en
 * .cursor/rules/browser-qa.mdc — "el QA nunca aprueba sin haber navegado").
 *
 * Usa playwright-core, NO playwright completo — playwright-core no trae
 * navegador propio empaquetado, así que por defecto lanza el Chrome/Edge
 * que la máquina YA tiene instalado (channel 'chrome' / 'msedge'), sin
 * descargar ningún binario adicional. Verificado en esta máquina: ambos
 * canales lanzan sin instalar nada extra.
 *
 * Modo 'own' (opt-in): usa la copia aislada de Playwright si el dev corrió
 * `npx playwright install chromium` — util para cross-browser real o para
 * no depender del navegador de uso diario. Si no está instalada, el gate
 * no la instala solo (evita una descarga de 100-300MB sin que el dev la
 * pida) — devuelve un mensaje accionable con el comando exacto.
 *
 * Uso:
 *   node .agentic/grafo/browser-gate.cjs <url> [--own] [--out=_output]
 */

const fs = require('fs');
const path = require('path');

const NAV_TIMEOUT_MS = 15_000;

function resolveOutputDir(projectRoot, outDir) {
  const dir = path.isAbsolute(outDir) ? outDir : path.join(projectRoot, outDir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function launchBrowser(mode) {
  const { chromium } = require('playwright-core');

  if (mode === 'own') {
    try {
      return await chromium.launch({ headless: true });
    } catch (err) {
      throw new Error(
        'Modo "own" pedido pero no hay una copia de Playwright instalada. ' +
        'Corre: npx playwright install chromium — y vuelve a intentar.\n' +
        'Detalle: ' + err.message.split('\n')[0]
      );
    }
  }

  // Modo 'system' (default): probar Chrome, luego Edge — ninguno de los dos
  // requiere descargar nada, usan el navegador ya instalado en la máquina.
  const canales = ['chrome', 'msedge'];
  let lastErr = null;
  for (const channel of canales) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    'No se pudo lanzar Chrome ni Edge instalados en esta máquina. ' +
    'Si no tienes ninguno de los dos, corre con --own para usar la copia ' +
    'aislada de Playwright (requiere: npx playwright install chromium).\n' +
    'Detalle: ' + (lastErr && lastErr.message.split('\n')[0])
  );
}

async function runBrowserGate(url, opts) {
  opts = opts || {};
  const projectRoot = opts.projectRoot || process.cwd();
  const mode = opts.mode === 'own' ? 'own' : 'system';
  const outDir = resolveOutputDir(projectRoot, opts.outDir || '_output');

  const findings = [];
  let browser = null;

  try {
    browser = await launchBrowser(mode);
  } catch (err) {
    return {
      passed: false,
      warn: true,
      findings: [],
      message: `BROWSER GATE WARN — no se pudo abrir un navegador: ${err.message}`,
    };
  }

  try {
    const page = await browser.newPage();

    page.on('console', msg => {
      if (msg.type() === 'error') {
        findings.push({ tipo: 'CONSOLE_ERROR', detalle: msg.text().slice(0, 300) });
      }
    });
    page.on('pageerror', err => {
      findings.push({ tipo: 'PAGE_ERROR', detalle: String(err.message || err).slice(0, 300) });
    });

    let navError = null;
    try {
      await page.goto(url, { timeout: NAV_TIMEOUT_MS, waitUntil: 'load' });
    } catch (err) {
      navError = err.message.split('\n')[0];
      findings.push({ tipo: 'NAV_ERROR', detalle: navError });
    }

    // Checks por comportamiento (Plan 2, Fase C) — verificación mecánica de lo
    // que la memoria dice que funciona: el elemento existe, el required sigue
    // puesto, el select sigue usable. v1 usa SOLO checks exactos sin falsos
    // positivos (required-attr en vez de form.checkValidity(), que da falsos
    // con valores precargados). Siempre WARN — mismo criterio que ui-native-gate.
    const checks = Array.isArray(opts.checks) ? opts.checks : [];
    const checkOutcomes = []; // Plan 5, T6: resultado por check, acreditado al behavior
    if (!navError && checks.length) {
      for (const c of checks) {
        if (!c || !c.selector) continue;
        let checkOk = false;
        try {
          if (c.type === 'element-exists') {
            const el = await page.$(c.selector);
            if (!el) findings.push({ tipo: 'UI_ELEMENT_MISSING', detalle: `${c.etiqueta || c.selector} no existe en la página` });
            else checkOk = true;
          } else if (c.type === 'required-attr') {
            const tieneReq = await page.$eval(c.selector, el => el.required === true).catch(() => null);
            if (tieneReq !== true) {
              findings.push({
                tipo: 'UI_REQUIRED_ROTO',
                detalle: `${c.etiqueta || c.selector} ${tieneReq === null ? 'no existe en la página' : 'perdió el atributo required'}`,
              });
            } else checkOk = true;
          } else if (c.type === 'select-usable') {
            const st = await page.$eval(c.selector, el => ({
              opciones: el.options ? el.options.length : 0,
              deshabilitado: !!el.disabled,
            })).catch(() => null);
            if (!st) findings.push({ tipo: 'UI_SELECT_ROTO', detalle: `${c.etiqueta || c.selector} no existe en la página` });
            else if (st.deshabilitado) findings.push({ tipo: 'UI_SELECT_ROTO', detalle: `${c.etiqueta || c.selector} está disabled` });
            else if (st.opciones === 0) findings.push({ tipo: 'UI_SELECT_ROTO', detalle: `${c.etiqueta || c.selector} quedó sin opciones` });
            else checkOk = true;
          }
        } catch (e) {
          findings.push({ tipo: 'UI_CHECK_ERROR', detalle: `${c.type} ${c.selector}: ${String(e.message || e).slice(0, 120)}` });
        }
        checkOutcomes.push({ behavior_id: c.behavior_id || null, ok: checkOk });
      }

      // Telemetría (Plan 5, T6): UN evento por behavior por corrida — PASS solo
      // si TODOS sus checks pasaron (la promoción por mérito cuenta corridas
      // verificadas, no checks sueltos). Fail-soft: sin BD, el gate sigue igual.
      try {
        const dbPath = path.join(projectRoot, '.agentic', 'memoria.db');
        if (fs.existsSync(dbPath)) {
          const gt = require(path.join(__dirname, 'gate-telemetry.cjs'));
          let tdb;
          try { tdb = new (require('better-sqlite3'))(dbPath); }
          catch { tdb = new (require('node:sqlite').DatabaseSync)(dbPath); }
          const porBehavior = {};
          checkOutcomes.forEach(o => {
            if (!o.behavior_id) return;
            (porBehavior[o.behavior_id] = porBehavior[o.behavior_id] || []).push(o.ok);
          });
          Object.entries(porBehavior).forEach(([bid, oks]) => {
            gt.recordGateEvent(tdb, {
              gate: 'browser', verdict: oks.every(Boolean) ? 'PASS' : 'FAIL',
              behavior_id: bid, file: url, detalle: { checks: oks.length },
            });
          });
          try { tdb.close(); } catch {}
        }
      } catch { /* nunca bloquea */ }
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const screenshotPath = path.join(outDir, `browser-gate-${stamp}.png`);
    let screenshotOk = false;
    if (!navError) {
      try {
        await page.screenshot({ path: screenshotPath, fullPage: false });
        screenshotOk = true;
      } catch { /* la screenshot es evidencia, no bloquea el gate si falla */ }
    }

    await browser.close();
    browser = null;

    if (findings.length === 0) {
      return {
        passed: true,
        mode,
        url,
        screenshot: screenshotOk ? screenshotPath : null,
        message: `✅ BROWSER GATE PASS — ${url} cargó sin errores de consola (modo: ${mode})` +
          (screenshotOk ? `\n   Captura: ${screenshotPath}` : ''),
      };
    }

    return {
      passed: false,
      warn: true,
      mode,
      url,
      findings,
      screenshot: screenshotOk ? screenshotPath : null,
      message: `⚠️  BROWSER GATE WARN — ${findings.length} hallazgo(s) en ${url}:\n` +
        findings.map(f => `   🟡 [${f.tipo}] ${f.detalle}`).join('\n') +
        (screenshotOk ? `\n   Captura: ${screenshotPath}` : ''),
    };
  } finally {
    if (browser) await browser.close();
  }
}

// ─── DERIVACIÓN DE CHECKS DESDE LA MEMORIA (Plan 2, Fase C) ───────────────────

// symbol_name del índice → selector CSS del navegador. Los nombres @L<n>
// (elementos sin id ni name) no son seleccionables — se saltan, documentado.
function symbolToSelector(sym) {
  const s = String(sym || '');
  if (/@L\d+$/.test(s)) return null;
  const conName = s.match(/^(\w+)\[name=([^\]]+)\]$/);
  if (conName) return `${conName[1]}[name="${conName[2]}"]`;
  if (/^\w+#[-\w]+$/.test(s)) return s;
  return null;
}

// Lee los behaviors UI protegidos que mencionan una vista y construye los
// checks mecánicos correspondientes. Fail-soft total: sin BD, sin behaviors,
// sin flujos UI → lista vacía (el gate corre en modo genérico, como siempre).
function deriveChecksForView(projectRoot, viewFile) {
  const checks = [];
  try {
    let Database;
    try { Database = require('better-sqlite3'); }
    catch { Database = require('node:sqlite').DatabaseSync; }
    const db = new Database(path.join(projectRoot, '.agentic', 'memoria.db'));
    try {
      const rows = db.prepare("SELECT id, critical_flows, related_files, confidence FROM protected_behaviors WHERE status = 'active'").all();
      const vista = String(viewFile).replace(/\\/g, '/').toLowerCase();
      const seen = new Set();
      for (const b of rows) {
        let files = [];
        try { files = JSON.parse(b.related_files || '[]'); } catch {}
        const aplica = files.some(f => {
          const fn = String(f).replace(/\\/g, '/').toLowerCase();
          return fn.includes(vista) || vista.includes(fn);
        });
        if (!aplica) continue;
        let flows = [];
        try { flows = JSON.parse(b.critical_flows || '[]'); } catch {}
        for (const flow of flows) {
          const espacio = String(flow).indexOf(' ');
          if (espacio <= 0) continue;
          const prefijo = String(flow).slice(0, espacio);
          const sym = String(flow).slice(espacio + 1);
          const selector = symbolToSelector(sym);
          if (!selector) continue;
          const add = (type) => {
            const k = type + '|' + selector;
            if (seen.has(k)) return;
            seen.add(k);
            // behavior_id (Plan 5, T6): permite acreditar la verificación al
            // behavior exacto — la promoción por mérito cuenta estos PASS.
            checks.push({ type, selector, etiqueta: flow, confidence: b.confidence, behavior_id: b.id });
          };
          if (prefijo === 'FORM') add('element-exists');
          else if (prefijo === 'SELECT') { add('element-exists'); add('select-usable'); }
          else if (prefijo === 'REQUIRED') add('required-attr');
        }
      }
    } finally { try { db.close(); } catch {} }
  } catch { /* fail-soft: sin checks derivados, el gate corre genérico */ }
  return checks;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  let url = args.find(a => !a.startsWith('--'));
  const mode = args.includes('--own') ? 'own' : 'system';
  const outArg = args.find(a => a.startsWith('--out='));
  const outDir = outArg ? outArg.split('=')[1] : '_output';
  const viewArg = args.find(a => a.startsWith('--view='));
  const checksFileArg = args.find(a => a.startsWith('--checks-file='));

  // Config opcional .agentic/browser-gate.json — { port, routes: {vista: "/ruta"} }.
  // Permite omitir la URL cuando --view está mapeada. Sin config → URL obligatoria.
  let config = null;
  try { config = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.agentic', 'browser-gate.json'), 'utf8')); } catch {}
  if (!url && viewArg && config && config.routes) {
    const vista = viewArg.split('=')[1];
    const ruta = config.routes[vista];
    if (ruta) url = `http://localhost:${config.port || 3000}${ruta}`;
  }

  if (!url) {
    console.log('Uso: node browser-gate.cjs <url> [--own] [--out=_output] [--view=<archivo-vista>] [--checks-file=checks.json]');
    console.log('Por defecto usa Chrome/Edge instalado (modo system). --own usa la copia de Playwright si está instalada.');
    console.log('--view deriva checks UI (element-exists/required-attr/select-usable) de los behaviors protegidos de esa vista.');
    console.log('Con .agentic/browser-gate.json ({port, routes}) la URL puede omitirse si --view está mapeada.');
    process.exit(0);
  }

  let checks = [];
  if (viewArg) checks = deriveChecksForView(process.cwd(), viewArg.split('=')[1]);
  if (checksFileArg) {
    try { checks = checks.concat(JSON.parse(fs.readFileSync(checksFileArg.split('=')[1], 'utf8'))); } catch {}
  }

  runBrowserGate(url, { mode, outDir, checks }).then(result => {
    console.log(result.message);
    process.exit(0); // WARN, no STOP — mismo criterio que ui-native-gate.cjs
  }).catch(err => {
    console.error('BROWSER GATE ERROR:', err.message);
    process.exit(0);
  });
}

module.exports = { runBrowserGate, deriveChecksForView, symbolToSelector };
