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
 * Snapshots visuales (v3.17.0): el equivalente front de protected_behaviors.
 * Una vista que ya está bien se "fotografía" como referencia; después de
 * cualquier cambio, --compare vuelve a fotografiar y compara píxel a píxel
 * (con tolerancia de antialiasing, vía png-diff.cjs — cero dependencias
 * nuevas). Si una vista vieja cambió sin que nadie la tocara a propósito,
 * el gate lo GRITA con el % exacto y una imagen de diff marcando dónde.
 * Referencias en .agentic/snapshots/ · diffs en _output/. WARN-only, como
 * todo el gate — el juicio de "¿este cambio visual es intencional?" sigue
 * siendo del dev; si lo es, se re-corre --snapshot y la referencia se
 * actualiza.
 *
 * Uso:
 *   node .agentic/grafo/browser-gate.cjs <url> [--own] [--out=_output]
 *   node .agentic/grafo/browser-gate.cjs <url> --snapshot=<vista>            → capturar candidato (no toca la referencia)
 *   node .agentic/grafo/browser-gate.cjs <url> --compare=<vista> [--threshold=0.5]  → comparar contra referencia
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

// ─── CONTRATOS DE FLUJO Y ACCESIBILIDAD ──────────────────────────────────────
// Que un elemento exista no prueba que alguien pueda completar la operación.
// Un contrato de flujo es: pasos del usuario → resultado visible → efectos de
// red esperados → estado final. Selectores estables: testid, rol+nombre.

function localizador(page, p) {
  if (p.testid) return page.locator(`[data-testid="${String(p.testid).replace(/"/g, '\\"')}"]`).first();
  if (p.rol) return page.getByRole(p.rol, p.nombre ? { name: p.nombre } : {}).first();
  if (p.etiqueta) return page.getByLabel(p.etiqueta).first();
  if (p.selector) return page.locator(p.selector).first();
  return null;
}

async function ejecutarFlujo(page, c, red) {
  const fallos = [];
  const desde = red.length;
  for (const [i, p] of (c.pasos || []).entries()) {
    try {
      const loc = localizador(page, p);
      if (p.accion === 'click') await loc.click({ timeout: 5000 });
      else if (p.accion === 'dblclick') await loc.dblclick({ timeout: 5000 });
      else if (p.accion === 'fill') await loc.fill(String(p.valor ?? ''), { timeout: 5000 });
      else if (p.accion === 'select') await loc.selectOption(String(p.valor), { timeout: 5000 });
      else if (p.accion === 'press') await (loc ? loc.press(p.tecla, { timeout: 5000 }) : page.keyboard.press(p.tecla));
      else if (p.accion === 'reload') await page.reload({ waitUntil: 'load' });
      else if (p.accion === 'back') await page.goBack({ waitUntil: 'load' });
      else if (p.accion === 'esperar') await page.waitForTimeout(Math.min(Number(p.ms) || 200, 5000));
      else { fallos.push(`paso ${i + 1}: acción desconocida "${p.accion}"`); break; }
    } catch (e) { fallos.push(`paso ${i + 1} (${p.accion}): ${String(e.message || e).split('\n')[0].slice(0, 140)}`); break; }
  }
  if (!fallos.length) {
    const plazo = Math.min(Number(c.timeoutMs) || 3000, 15000);
    // El resultado de una acción suele ser asíncrono: cada espera se reintenta
    // hasta el plazo antes de declararla rota.
    const hasta = async (cond) => {
      const fin = Date.now() + plazo;
      for (;;) {
        if (await cond().catch(() => false)) return true;
        if (Date.now() >= fin) return false;
        await page.waitForTimeout(100);
      }
    };
    for (const e of c.espera || []) {
      try {
        if (e.visible) { if (!(await hasta(() => localizador(page, e.visible).isVisible()))) fallos.push(`no visible: ${JSON.stringify(e.visible)}`); }
        else if (e.oculto) { if (!(await hasta(async () => !(await localizador(page, e.oculto).isVisible())))) fallos.push(`sigue visible: ${JSON.stringify(e.oculto)}`); }
        else if (e.texto) { if (!(await hasta(() => page.getByText(e.texto).first().isVisible()))) fallos.push(`texto ausente: "${e.texto}"`); }
        else if (e.url) { if (!(await hasta(async () => new RegExp(e.url).test(page.url())))) fallos.push(`url ${page.url()} no coincide con ${e.url}`); }
        else if (e.foco) {
          if (!(await hasta(() => localizador(page, e.foco).evaluate((el) => el === document.activeElement)))) fallos.push(`foco no está en ${JSON.stringify(e.foco)}`);
        } else if (e.peticion) {
          const q = e.peticion;
          const ocurrio = () => Promise.resolve(red.slice(desde).some((r) => (!q.metodo || r.metodo === q.metodo.toUpperCase()) &&
            (!q.ruta || new RegExp(q.ruta).test(r.url)) && (q.status == null || r.status === q.status)));
          if (!(await hasta(ocurrio))) fallos.push(`no ocurrió la petición ${JSON.stringify(q)}`);
        } else fallos.push(`espera desconocida ${JSON.stringify(e)}`);
      } catch (err) { fallos.push(`espera ${JSON.stringify(e)}: ${String(err.message || err).split('\n')[0].slice(0, 120)}`); }
    }
  }
  return fallos;
}

/* Lo que el barrido NO prueba se declara: contraste real, orden lógico de foco
   en flujos complejos, lectores de pantalla y traducciones. */
const A11Y_LIMITES = ['contraste calculado', 'orden lógico de foco en flujos complejos', 'lector de pantalla real', 'calidad de traducciones'];

async function barridoA11y(page) {
  return page.evaluate(() => {
    const nombre = (el) => (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') && document.getElementById(el.getAttribute('aria-labelledby'))?.textContent || el.textContent || el.getAttribute('title') || el.getAttribute('value') || '').trim();
    const visibles = (sel) => [...document.querySelectorAll(sel)].filter((e) => e.offsetParent !== null || e.getClientRects().length);
    const describir = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.getAttribute('data-testid') ? `[data-testid=${el.getAttribute('data-testid')}]` : '');
    const out = [];
    visibles('button, a[href], [role=button]').filter((e) => !nombre(e) && !e.querySelector('img[alt]:not([alt=""])'))
      .slice(0, 10).forEach((e) => out.push({ tipo: 'A11Y_SIN_NOMBRE', detalle: describir(e) }));
    visibles('input:not([type=hidden]), select, textarea').filter((e) => {
      if (e.getAttribute('aria-label') || e.getAttribute('aria-labelledby') || e.getAttribute('title')) return false;
      if (e.id && document.querySelector(`label[for="${CSS.escape(e.id)}"]`)) return false;
      return !e.closest('label');
    }).slice(0, 10).forEach((e) => out.push({ tipo: 'A11Y_SIN_ETIQUETA', detalle: describir(e) }));
    visibles('img').filter((e) => !e.hasAttribute('alt')).slice(0, 10).forEach((e) => out.push({ tipo: 'A11Y_IMG_SIN_ALT', detalle: describir(e) + ' ' + (e.getAttribute('src') || '').slice(0, 60) }));
    visibles('img').filter((e) => e.complete && e.naturalWidth === 0).slice(0, 10).forEach((e) => out.push({ tipo: 'IMAGEN_ROTA', detalle: (e.getAttribute('src') || '').slice(0, 100) }));
    return out;
  });
}

async function recorridoTeclado(page, c) {
  const fallos = [];
  const pasos = Math.min(Number(c.tabs) || 5, 30);
  const vistos = [];
  // Chromium recuerda dónde quedó la navegación secuencial; se reinicia en el body.
  await page.evaluate(() => {
    const b = document.body; const t = b.getAttribute('tabindex');
    b.setAttribute('tabindex', '-1'); b.focus();
    if (t === null) b.removeAttribute('tabindex'); else b.setAttribute('tabindex', t);
    window.scrollTo(0, 0);
  });
  for (let i = 0; i < pasos; i++) {
    await page.keyboard.press('Tab');
    const actual = await page.evaluate((n) => {
      const a = document.activeElement;
      if (!a || a === document.body) return null;
      const r = a.getBoundingClientRect();
      return { id: a.tagName + '#' + (a.id || a.getAttribute('data-testid') || (a.textContent || '').trim().slice(0, 20) || n), visible: r.width > 0 && r.height > 0 };
    }, i);
    if (!actual) { fallos.push(`Tab ${i + 1}: el foco no llegó a ningún control`); break; }
    if (!actual.visible) fallos.push(`Tab ${i + 1}: foco en un elemento invisible (${actual.id})`);
    vistos.push(actual.id);
  }
  if (vistos.length >= 3 && new Set(vistos).size === 1) fallos.push('trampa de teclado: el foco no sale del mismo control');
  return fallos;
}

function validarChecks(checks) {
  const CHECKS_CON_SELECTOR = new Set(['element-exists', 'required-attr', 'select-usable', 'en-pantalla']);
  const CHECKS_CONOCIDOS = new Set(['flujo', 'a11y', 'teclado', 'movimiento-reducido', 'xss-sentinela', ...CHECKS_CON_SELECTOR]);
  const schemaChecks = [];
  for (const c of checks || []) {
    if (!c || !c.type) { schemaChecks.push({ id: 'sin-tipo', reason: 'CHECK_SIN_TIPO' }); continue; }
    if (!CHECKS_CONOCIDOS.has(c.type)) { schemaChecks.push({ id: c.id || c.type, reason: 'TIPO_DESCONOCIDO' }); continue; }
    if (CHECKS_CON_SELECTOR.has(c.type) && !c.selector && !c.testid && !c.rol) {
      schemaChecks.push({ id: c.id || c.type, reason: 'SELECTOR_AUSENTE' }); continue;
    }
    if (c.type === 'flujo') {
      const pasos = Array.isArray(c.pasos) ? c.pasos : [];
      const espera = Array.isArray(c.espera) ? c.espera : [];
      if (!pasos.length && !espera.length) schemaChecks.push({ id: c.id || c.nombre || 'flujo', reason: 'FLUJO_INCOMPLETO' });
      const accionesValidas = new Set(['click', 'dblclick', 'fill', 'select', 'press', 'reload', 'back', 'esperar']);
      for (const p of pasos) {
        if (!p || !p.accion) { schemaChecks.push({ id: c.id || 'flujo', reason: 'PASO_SIN_ACCION' }); continue; }
        if (!accionesValidas.has(p.accion)) schemaChecks.push({ id: c.id || 'flujo', reason: 'ACCION_DESCONOCIDA' });
      }
    }
  }
  return { CHECKS_CONOCIDOS, schemaChecks };
}

async function runBrowserGate(url, opts) {
  opts = opts || {};
  const projectRoot = opts.projectRoot || process.cwd();
  const mode = opts.mode === 'own' ? 'own' : 'system';
  const outDir = resolveOutputDir(projectRoot, opts.outDir || '_output');
  const checksPrevios = Array.isArray(opts.checks) ? opts.checks : [];
  const { schemaChecks } = validarChecks(checksPrevios);
  if (schemaChecks.length) {
    return {
      status: 'UNVERIFIED',
      reason_code: schemaChecks[0].reason,
      passed: false,
      findings: schemaChecks.map((s) => ({ tipo: 'CHECK_INVALIDO', detalle: s.id + ': ' + s.reason })),
      contratos: schemaChecks.map((s) => ({ id: s.id, status: 'UNVERIFIED', reason_code: s.reason })),
      message: `BROWSER GATE UNVERIFIED — checks malformados: ${schemaChecks.map((s) => s.reason).join(', ')}`,
    };
  }

  const findings = [];
  let browser = null;

  try {
    browser = await launchBrowser(mode);
  } catch (err) {
    return {
      status: 'UNVERIFIED',
      reason_code: 'SIN_NAVEGADOR',
      passed: false,
      warn: true,
      findings: [],
      message: `BROWSER GATE UNVERIFIED — no se pudo abrir un navegador: ${err.message}`,
    };
  }

  try {
    const page = await browser.newPage(opts.viewport ? { viewport: opts.viewport } : undefined);

    page.on('console', msg => {
      if (msg.type() === 'error') {
        findings.push({ tipo: 'CONSOLE_ERROR', detalle: msg.text().slice(0, 300) });
      }
    });
    page.on('pageerror', err => {
      findings.push({ tipo: 'PAGE_ERROR', detalle: String(err.message || err).slice(0, 300) });
    });
    const red = [];
    const ASSET = ['image', 'font', 'script', 'stylesheet'];
    page.on('response', (r) => {
      const req = r.request();
      red.push({ metodo: req.method(), url: r.url(), status: r.status(), tipo: req.resourceType() });
      if (ASSET.includes(req.resourceType()) && r.status() >= 400) findings.push({ tipo: 'ASSET_ROTO', detalle: `${r.status()} ${r.url().slice(0, 160)}` });
    });
    page.on('requestfailed', (req) => {
      if (ASSET.includes(req.resourceType())) findings.push({ tipo: 'ASSET_FALLIDO', detalle: `${req.resourceType()} ${req.url().slice(0, 160)}` });
    });
    try { await page.emulateMedia({ reducedMotion: 'reduce' }); } catch { /* playwright viejo */ }

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
    const checks = checksPrevios;
    const checkOutcomes = [];
    const { CHECKS_CONOCIDOS } = validarChecks(checks);
    if (!navError && checks.length) {
      for (const c of checks) {
        if (!c || !CHECKS_CONOCIDOS.has(c.type)) continue;
        let checkOk = false;
        try {
          if (c.type === 'flujo') {
            const espera = Array.isArray(c.espera) ? c.espera : [];
            const pasos = Array.isArray(c.pasos) ? c.pasos : [];
            if (pasos.length && !espera.length && c.intencion !== 'vista-inicial') {
              findings.push({ tipo: 'FLUJO_SMOKE', contrato: true, detalle: `${c.nombre || c.id || 'flujo'}: click o espera temporal sin resultado observable es smoke, no contrato funcional` });
              checkOk = false;
            } else {
              const fallos = await ejecutarFlujo(page, c, red);
              fallos.forEach((f) => findings.push({ tipo: 'FLUJO_ROTO', contrato: true, detalle: `${c.nombre || c.id || 'flujo'}: ${f}` }));
              checkOk = fallos.length === 0;
            }
          } else if (c.type === 'a11y') {
            const hall = await barridoA11y(page);
            const ignorar = new Set(c.ignorar || []);
            const propios = hall.filter((h) => !ignorar.has(h.tipo));
            propios.forEach((h) => findings.push(Object.assign({ contrato: true }, h)));
            checkOk = propios.length === 0;
          } else if (c.type === 'teclado') {
            const fallos = await recorridoTeclado(page, c);
            fallos.forEach((f) => findings.push({ tipo: 'TECLADO_ROTO', contrato: true, detalle: f }));
            checkOk = fallos.length === 0;
          } else if (c.type === 'element-exists') {
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
          } else if (c.type === 'en-pantalla') {
            const r = await page.$eval(c.selector, (el) => {
              const b = el.getBoundingClientRect();
              return { w: b.width, h: b.height, izq: b.left, der: b.right, ancho: window.innerWidth };
            }).catch(() => null);
            if (!r) findings.push({ tipo: 'UI_FUERA_DE_PANTALLA', contrato: true, detalle: `${c.etiqueta || c.selector} no existe en la página` });
            else if (!r.w || !r.h || r.izq < 0 || r.der > r.ancho + 0.5) findings.push({ tipo: 'UI_FUERA_DE_PANTALLA', contrato: true, detalle: `${c.etiqueta || c.selector} ocupa ${Math.round(r.izq)}–${Math.round(r.der)}px en un ancho de ${r.ancho}px` });
            else checkOk = true;
          } else if (c.type === 'movimiento-reducido') {
            // El gate pide prefers-reduced-motion: reduce; una animación que
            // sigue corriendo sin fin ignoró esa preferencia.
            const vivas = await page.evaluate(() => document.getAnimations()
              .filter((a) => a.playState === 'running' && a.effect && a.effect.getComputedTiming().endTime === Infinity)
              .map((a) => (a.animationName || a.id || 'animación') + ' en ' + ((a.effect.target && a.effect.target.tagName) || '?').toLowerCase()));
            vivas.slice(0, 5).forEach((v) => findings.push({ tipo: 'MOVIMIENTO_NO_REDUCIDO', contrato: true, detalle: v }));
            checkOk = vivas.length === 0;
          } else if (c.type === 'xss-sentinela') {
            // Solo prueba lo sembrado: el dato de prueba lleva un payload que, si
            // se interpreta como HTML, escribe esta variable global.
            const variable = String(c.variable || '__akddXss');
            await page.waitForTimeout(Math.min(Number(c.esperaMs) || 300, 3000));
            const ejecutado = await page.evaluate((v) => window[v] !== undefined, variable);
            if (ejecutado) findings.push({ tipo: 'XSS_EJECUTADO', contrato: true, detalle: `el dato sembrado ejecutó código (window.${variable})` });
            else checkOk = true;
          }
        } catch (e) {
          findings.push({ tipo: 'UI_CHECK_ERROR', detalle: `${c.type} ${c.selector}: ${String(e.message || e).slice(0, 120)}` });
        }
        checkOutcomes.push({ behavior_id: c.behavior_id || null, tipo: c.type, id: c.id || c.nombre || c.selector || c.type, ok: checkOk });
      }

      // Telemetría (Plan 5, T6): UN evento por behavior por corrida — PASS solo
      // si TODOS sus checks pasaron (la promoción por mérito cuenta corridas
      // verificadas, no checks sueltos). Fail-soft: sin BD, el gate sigue igual.
      try {
        const dbPath = path.join(projectRoot, '.agentic', 'memoria.db');
        if (fs.existsSync(dbPath)) {
          const gt = require(path.join(__dirname, 'gate-telemetry.cjs'));
          const tdb = require(path.join(__dirname, 'db-adapter.cjs')).openWrite(dbPath);
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

    if (navError) {
      return {
        status: 'UNVERIFIED',
        reason_code: /timeout/i.test(navError) ? 'TIMEOUT' : 'NAV_ERROR',
        passed: false,
        warn: true,
        mode,
        url,
        findings,
        message: `BROWSER GATE UNVERIFIED — ${url} no se pudo cargar: ${navError}`,
      };
    }

    const contratos = checkOutcomes.map((o) => ({
      id: o.id, tipo: o.tipo, behavior_id: o.behavior_id,
      status: o.ok ? 'PASS' : (findings.some((f) => f.tipo === 'FLUJO_SMOKE' && String(f.detalle || '').includes(o.id)) ? 'UNVERIFIED' : 'FAIL'),
    }));
    const a11yPedido = checks.some((c) => c && c.type === 'a11y');
    const rotos = contratos.filter((c) => c.status === 'FAIL');
    const smoke = contratos.filter((c) => c.status === 'UNVERIFIED');
    if (smoke.length && !rotos.length) {
      return {
        status: 'UNVERIFIED',
        reason_code: 'FLUJO_SMOKE',
        passed: false,
        mode,
        url,
        findings,
        contratos,
        screenshot: screenshotOk ? screenshotPath : null,
        message: `BROWSER GATE UNVERIFIED — flujo sin resultado observable en ${url}`,
      };
    }
    if (rotos.length) {
      return {
        status: 'FAIL',
        reason_code: 'CONTRATO_UI_ROTO',
        passed: false,
        mode,
        url,
        findings,
        contratos,
        limites: a11yPedido ? A11Y_LIMITES : undefined,
        screenshot: screenshotOk ? screenshotPath : null,
        message: `🛑 BROWSER GATE FAIL — ${rotos.length} contrato(s) de interfaz roto(s) en ${url}:\n` +
          findings.map(f => `   ${f.contrato ? '🔴' : '🟡'} [${f.tipo}] ${f.detalle}`).join('\n') +
          (screenshotOk ? `\n   Captura: ${screenshotPath}` : ''),
      };
    }

    if (findings.length === 0) {
      return {
        status: 'PASS',
        passed: true,
        mode,
        url,
        contratos,
        limites: a11yPedido ? A11Y_LIMITES : undefined,
        screenshot: screenshotOk ? screenshotPath : null,
        message: `✅ BROWSER GATE PASS — ${url} cargó sin errores de consola (modo: ${mode})` +
          (screenshotOk ? `\n   Captura: ${screenshotPath}` : ''),
      };
    }

    return {
      status: 'WARN',
      passed: false,
      warn: true,
      mode,
      url,
      findings,
      contratos,
      screenshot: screenshotOk ? screenshotPath : null,
      message: `⚠️  BROWSER GATE WARN — ${findings.length} hallazgo(s) en ${url}:\n` +
        findings.map(f => `   🟡 [${f.tipo}] ${f.detalle}`).join('\n') +
        (screenshotOk ? `\n   Captura: ${screenshotPath}` : ''),
    };
  } finally {
    if (browser) await browser.close();
  }
}

// ─── SNAPSHOTS VISUALES ──────────────────────────────────────────────────────
// Capturar deja un CANDIDATO; la referencia solo cambia con `aprobar`
// (baseline-visual.cjs). Cada variante (viewport, densidad, tema, estado) tiene
// su propia referencia.

const SNAPSHOT_VIEWPORT = { width: 1280, height: 800 };
const SNAPSHOT_SETTLE_MS = 500;
const HORA_CONGELADA = '2026-01-01T12:00:00.000Z';

function snapshotDir(projectRoot) {
  const dir = path.join(projectRoot, '.agentic', 'snapshots');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sanitizarNombre(name) {
  return String(name || 'vista').replace(/[^a-z0-9-_]/gi, '_').slice(0, 80);
}

/** Viewports a cubrir: los pedidos, los de .agentic/browser-gate.json, o el base. */
function matrizViewports(projectRoot, pedidos) {
  if (Array.isArray(pedidos) && pedidos.length) return pedidos;
  try {
    const c = JSON.parse(fs.readFileSync(path.join(projectRoot, '.agentic', 'browser-gate.json'), 'utf8'));
    if (Array.isArray(c.viewports) && c.viewports.length) return c.viewports;
  } catch { /* sin config */ }
  return [Object.assign({}, SNAPSHOT_VIEWPORT)];
}

/** Captura reproducible: viewport y densidad fijos, tema, idioma y hora
 *  congelados, animaciones apagadas y fuentes cargadas antes de fotografiar. */
async function capturarPagina(browser, url, v = SNAPSHOT_VIEWPORT) {
  const context = await browser.newContext({
    viewport: { width: v.width || SNAPSHOT_VIEWPORT.width, height: v.height || SNAPSHOT_VIEWPORT.height },
    deviceScaleFactor: v.dpr || 1,
    colorScheme: v.theme === 'dark' ? 'dark' : 'light',
    locale: v.locale || 'es-ES',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
  });
  await context.addInitScript((iso) => {
    const fija = new Date(iso).getTime();
    const D = Date;
    function F(...a) {
      if (!(this instanceof F)) return new D(fija).toString();
      return new D(...(a.length ? a : [fija]));
    }
    F.prototype = D.prototype; F.now = () => fija; F.parse = D.parse; F.UTC = D.UTC;
    // eslint-disable-next-line no-global-assign
    Date = F;
  }, HORA_CONGELADA);
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200)); });
  try {
    await page.goto(url, { timeout: NAV_TIMEOUT_MS, waitUntil: 'load' });
    await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' });
    await page.evaluate(() => (document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true));
    await page.waitForTimeout(SNAPSHOT_SETTLE_MS);
    const buf = await page.screenshot({ fullPage: true });
    return { buf, consoleErrors, browser: browser.version(), viewport: v };
  } finally {
    await context.close();
  }
}

function registrarSnapshot(projectRoot, verdict, file, detalle) {
  try {
    const dbPath = path.join(projectRoot, '.agentic', 'memoria.db');
    if (!fs.existsSync(dbPath)) return;
    const gt = require(path.join(__dirname, 'gate-telemetry.cjs'));
    const db = require(path.join(__dirname, 'db-adapter.cjs')).openWrite(dbPath);
    try { gt.recordGateEvent(db, { gate: 'snapshot', verdict, file, detalle }); } finally { db.close(); }
  } catch { /* la libreta no frena la comparación */ }
}

/** Captura candidatos por variante. Nunca toca la referencia aprobada. */
async function runSnapshot(url, name, opts) {
  opts = opts || {};
  const projectRoot = opts.projectRoot || process.cwd();
  const bv = require(path.join(__dirname, 'baseline-visual.cjs'));
  const nombre = sanitizarNombre(name);
  let browser = null;
  try {
    browser = await launchBrowser(opts.mode === 'own' ? 'own' : 'system');
    const candidatos = [];
    for (const v of matrizViewports(projectRoot, opts.viewports)) {
      const cap = await capturarPagina(browser, url, v);
      const vari = bv.variante(v);
      const c = bv.guardarCandidato(projectRoot, nombre, vari, cap.buf, {
        url, viewport: v, browser: cap.browser, locale: v.locale || 'es-ES', hora: HORA_CONGELADA,
        subject_hash: opts.subject_hash || null, mascaras: opts.mascaras || [], regiones: opts.regiones || [],
      });
      let aprobado = null;
      if (opts.aprobar) aprobado = bv.aprobar(projectRoot, nombre, vari, c.id, opts.aprobar);
      candidatos.push({ variante: vari, candidato: c.id, path: c.path, aprobado });
    }
    const lineas = candidatos.map((c) => `   ${c.variante}: candidato ${c.candidato}` +
      (c.aprobado ? (c.aprobado.ok ? ' → aprobado' : ` → no aprobado (${c.aprobado.reason_code})`) : ''));
    return {
      passed: true, status: 'CANDIDATO', candidatos,
      message: `📸 SNAPSHOT — "${nombre}": ${candidatos.length} candidato(s); la referencia aprobada no cambió.\n` + lineas.join('\n') +
        `\n   Aprobar: node .agentic/grafo/browser-gate.cjs --approve=${nombre} --variante=<v> --candidato=<id> --aprobador="..." --motivo="..."`,
    };
  } catch (err) {
    return { passed: false, warn: true, status: 'UNVERIFIED', reason_code: 'CAPTURA_FALLIDA', message: `⚠️  SNAPSHOT — no se pudo capturar "${nombre}": ${err.message.split('\n')[0]}` };
  } finally {
    if (browser) await browser.close();
  }
}

/** Compara cada variante contra su referencia aprobada. Un diff en una zona
 *  protegida o sobre el umbral es FAIL, no un aviso. */
async function runCompare(url, name, opts) {
  opts = opts || {};
  const projectRoot = opts.projectRoot || process.cwd();
  const bv = require(path.join(__dirname, 'baseline-visual.cjs'));
  const threshold = opts.threshold != null ? opts.threshold : 0.5;
  const nombre = sanitizarNombre(name);
  const viewports = matrizViewports(projectRoot, opts.viewports);

  const refs = viewports.map((v) => ({ v, vari: bv.variante(v), ref: bv.referencia(projectRoot, nombre, bv.variante(v)) }));
  const faltan = refs.filter((r) => !r.ref.ok);
  if (faltan.length === refs.length) {
    return {
      passed: false, warn: true, status: 'UNVERIFIED', reason_code: faltan[0].ref.reason_code, sinReferencia: true,
      message: `⚠️  SNAPSHOT COMPARE UNVERIFIED — "${nombre}" sin referencia aprobada (${faltan.map((f) => f.vari + ': ' + f.ref.reason_code).join(', ')}).\n` +
        `   Capturar candidato: node .agentic/grafo/browser-gate.cjs ${url} --snapshot=${nombre}`,
    };
  }

  let browser = null;
  try {
    browser = await launchBrowser(opts.mode === 'own' ? 'own' : 'system');
    const resultados = [];
    for (const r of refs) {
      if (!r.ref.ok) { resultados.push({ variante: r.vari, status: 'UNVERIFIED', reason_code: r.ref.reason_code }); continue; }
      const m = r.ref.manifest || {};
      const ruta = (u) => { try { return new URL(u).pathname.replace(/\/+$/, '') || '/'; } catch { return null; } };
      if (m.url && ruta(m.url) !== ruta(url)) {
        resultados.push({ variante: r.vari, status: 'UNVERIFIED', reason_code: 'RUTA_DISTINTA', ref: ruta(m.url), actual: ruta(url) });
        continue;
      }
      const cap = await capturarPagina(browser, url, r.v);
      let d = bv.compararConContexto(r.ref.buf, cap.buf, {
        threshold, tolerance: opts.tolerance, mascaras: m.mascaras || [], regiones: m.regiones || [],
        manifiesto_ref: m,
        manifiesto_actual: {
          project_id: opts.project_id != null ? opts.project_id : null,
          fixture_hash: opts.fixture_hash != null ? opts.fixture_hash : null,
          language: opts.language != null ? opts.language : null,
          locale: r.v.locale || 'es-ES',
          browser: cap.browser,
          theme: r.v.theme != null ? r.v.theme : null,
          estado: r.v.estado != null ? r.v.estado : null,
        },
      });
      if (r.ref.legacy) d = Object.assign({}, d, { status: 'UNVERIFIED', reason_code: 'REFERENCIA_SIN_APROBAR', comparado: d.status });
      const res = Object.assign({ variante: r.vari }, d);
      if (d.status === 'FAIL') {
        const c = bv.guardarCandidato(projectRoot, nombre, r.vari, cap.buf, { url, viewport: r.v, browser: cap.browser, motivo_captura: 'compare FAIL' });
        res.candidato = c.id;
        const pngDiff = require(path.join(__dirname, 'png-diff.cjs'));
        const dd = pngDiff.diffPNG(r.ref.buf, cap.buf, {});
        if (dd && dd.diffImage) {
          const outDir = resolveOutputDir(projectRoot, opts.outDir || '_output');
          res.diffImage = path.join(outDir, `snapshot-diff-${nombre}-${r.vari}-${c.id}.png`);
          try { fs.writeFileSync(res.diffImage, dd.diffImage); } catch { res.diffImage = null; }
        }
      }
      registrarSnapshot(projectRoot, d.status, nombre, { variante: r.vari, diffPct: d.diffPct, reason_code: d.reason_code || null });
      resultados.push(res);
    }
    const peor = resultados.some((r) => r.status === 'FAIL') ? 'FAIL'
      : resultados.some((r) => r.status !== 'PASS') ? 'UNVERIFIED' : 'PASS';
    const lineas = resultados.map((r) => `   ${r.status === 'PASS' ? '✅' : r.status === 'FAIL' ? '🔴' : '⚪'} ${r.variante}: ${r.status}` +
      (r.diffPct != null ? ` (${r.diffPct}% distinto, umbral ${threshold}%)` : '') + (r.reason_code ? ` ${r.reason_code}` : '') +
      (r.diffImage ? `\n      diff: ${r.diffImage}` : '') + (r.candidato ? `\n      candidato: ${r.candidato}` : ''));
    return {
      passed: peor === 'PASS', warn: peor !== 'PASS', status: peor, resultados,
      diffPct: resultados[0] && resultados[0].diffPct, diffImage: resultados[0] && resultados[0].diffImage,
      message: `${peor === 'PASS' ? '✅' : peor === 'FAIL' ? '🛑' : '⚠️ '} SNAPSHOT COMPARE ${peor} — "${nombre}"\n` + lineas.join('\n') +
        (peor === 'FAIL' ? '\n   Si el cambio es intencional, apruébalo explícitamente (--approve); no se acepta solo.' : ''),
    };
  } catch (err) {
    return { passed: false, warn: true, status: 'UNVERIFIED', reason_code: 'COMPARACION_FALLIDA', message: `⚠️  SNAPSHOT COMPARE — no se pudo comparar "${nombre}": ${err.message.split('\n')[0]}` };
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
    const dbPath = path.join(projectRoot, '.agentic', 'memoria.db');
    if (!fs.existsSync(dbPath)) return checks;
    const db = require(path.join(__dirname, 'db-adapter.cjs')).openReadOnly(dbPath);
    const { cubre } = require(path.join(__dirname, 'regression-guard.cjs'));
    try {
      const hay = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'protected_behaviors'").get();
      const rows = hay ? db.prepare("SELECT id, critical_flows, related_files, confidence FROM protected_behaviors WHERE status IN ('active', 'candidate', 'stale')").all() : [];
      const seen = new Set();
      for (const b of rows) {
        let files = [];
        try { files = JSON.parse(b.related_files || '[]'); } catch {}
        const aplica = files.some(f => cubre(f, viewFile) || cubre(viewFile, f));
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
    console.log('     node browser-gate.cjs <url> --snapshot=<vista> [--viewports=1280x800,390x844@2-dark] [--inicial --aprobador=..] → capturar candidato(s)');
    console.log('     node browser-gate.cjs <url> --compare=<vista> [--threshold=0.5]   → comparar contra la referencia aprobada (FAIL = salida 1)');
    console.log('     node browser-gate.cjs --approve=<vista> --variante=<v> --candidato=<id> --aprobador=.. --motivo=..');
    console.log('Por defecto usa Chrome/Edge instalado (modo system). --own usa la copia de Playwright si está instalada.');
    console.log('--view deriva checks UI (element-exists/required-attr/select-usable) de los behaviors protegidos de esa vista.');
    console.log('Con .agentic/browser-gate.json ({port, routes}) la URL puede omitirse si --view está mapeada.');
    process.exit(0);
  }

  // Snapshots: --snapshot captura candidatos, --approve los vuelve referencia
  // (con aprobador y motivo), --compare da PASS/FAIL/UNVERIFIED por variante.
  const opt = (k) => { const a = args.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
  const approveArg = opt('approve');
  if (approveArg) {
    const bv = require(path.join(__dirname, 'baseline-visual.cjs'));
    const r = bv.aprobar(process.cwd(), sanitizarNombre(approveArg), opt('variante') || bv.variante({}), opt('candidato'), {
      aprobador: opt('aprobador'), motivo: opt('motivo'), origen: opt('origen') || 'humano',
    });
    console.log(r.ok ? `✅ Referencia "${approveArg}" (${r.manifest.variante || opt('variante')}) aprobada: ${r.manifest.sha256.slice(0, 16)}` : `⛔ No aprobado: ${r.reason_code}`);
    process.exit(r.ok ? 0 : 1);
  }
  const snapArg = opt('snapshot');
  const compareArg = opt('compare');
  if (snapArg || compareArg) {
    const threshold = opt('threshold') != null ? parseFloat(opt('threshold')) : 0.5;
    let viewports;
    if (opt('viewports')) {
      viewports = opt('viewports').split(',').map((s) => {
        const m = /^(\d+)x(\d+)(?:@(\d+(?:\.\d+)?))?(?:-(light|dark))?$/.exec(s.trim());
        return m ? { width: +m[1], height: +m[2], dpr: m[3] ? +m[3] : 1, theme: m[4] || 'light' } : null;
      }).filter(Boolean);
    }
    const aprobar = args.includes('--inicial')
      ? { aprobador: opt('aprobador'), motivo: opt('motivo') || 'baseline inicial', origen: 'baseline_inicial' } : null;
    const fn = snapArg
      ? runSnapshot(url, snapArg, { mode, outDir, viewports, aprobar })
      : conIdentidad('visual', runCompare)(url, compareArg, { mode, outDir, threshold, viewports, subject_hash: opt('subject') });
    fn.then(result => {
      console.log(args.includes('--json') ? JSON.stringify(result) : result.message);
      process.exit(result.status === 'FAIL' ? 1 : 0);
    }).catch(err => {
      console.error('SNAPSHOT ERROR:', err.message);
      process.exit(2);
    });
    return;
  }

  let checks = [];
  if (viewArg) checks = deriveChecksForView(process.cwd(), viewArg.split('=')[1]);
  if (checksFileArg) {
    try { checks = checks.concat(JSON.parse(fs.readFileSync(checksFileArg.split('=')[1], 'utf8'))); }
    catch (e) { console.error(`--checks-file ilegible: ${e.message}`); process.exit(2); }
  }

  conIdentidad('browser', runBrowserGate)(url, { mode, outDir, checks, subject_hash: opt('subject') }).then(result => {
    console.log(args.includes('--json') ? JSON.stringify(result) : result.message);
    // Un contrato de interfaz roto es FAIL; consola con errores sigue siendo WARN.
    process.exit(result.status === 'FAIL' ? 1 : 0);
  }).catch(err => {
    console.error('BROWSER GATE ERROR:', err.message);
    process.exit(2);
  });
}

/** Cada corrida sale con su identidad: qué gate, qué ejecución, qué sujeto y qué política. */
function conIdentidad(gate, fn) {
  return async (url, ...rest) => {
    const opts = (gate === 'browser' ? rest[0] : rest[1]) || {};
    const root = opts.projectRoot || process.cwd();
    const before = require('./source-evidence.cjs').capture(root);
    const r = await fn(url, ...rest);
    const after = require('./source-evidence.cjs').capture(root);
    if (!before.complete || before.hash !== after.hash) { r.status='UNVERIFIED'; r.passed=false; r.reason_code='SOURCE_CHANGED_OR_INCOMPLETE'; }
    const esc = require('./escenarios.cjs');
    const result = Object.assign({}, r, { gate, execution_id: require('crypto').randomUUID(), policy_id: esc.POLICY_ID,
      subject_hash: opts.subject_hash || require('./tdd-gate.cjs').subjectHash(root), cycle_id: opts.cycle_id || null });
    const saved = esc.guardarArtefacto(root, { ...result, source_files: Object.keys(before.files).length ? before.files : undefined, source_manifest_hash: before.hash, provenance: gate, comprobador: 'browser-gate.cjs',
      runner_status: result.status || (result.passed && !result.warn ? 'PASS' : 'UNVERIFIED'),
      status: result.status || (result.passed && !result.warn ? 'PASS' : 'UNVERIFIED'),
      expected: [], executed: [], escenarios: {} });
    if (!saved.ok) return { ...result, passed: false, status: 'ERROR', reason_code: saved.reason_code };
    return result;
  };
}

module.exports = {
  runBrowserGate: conIdentidad('browser', runBrowserGate),
  runSnapshot,
  runCompare: conIdentidad('visual', runCompare),
  deriveChecksForView, symbolToSelector, validarChecks,
  ejecutarFlujo, barridoA11y, recorridoTeclado, matrizViewports, capturarPagina, A11Y_LIMITES, launchBrowser,
};
