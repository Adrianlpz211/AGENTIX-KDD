'use strict';
/* En Windows, un proceso que lanza otro SIN `windowsHide: true` abre una ventana de consola (el «node» que parpadea cada pocos
   segundos mientras corren los vigilantes, el puente de Telegram, ntfy y los hooks). Esta prueba recorre el código de Agentix que
   se instala en los proyectos y exige que cada llamada a child_process lo lleve. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIRS = ['.agentic/grafo', 'src', 'bin'];
const EXTRA = ['dashboard.cjs'];
const RE = /(?<![\w.$])((?:cp|child_process|childProcess|cps)\.)?(spawnSync|spawn|execSync|execFileSync|execFile|exec)\(/g;
// Llamadas que reciben las opciones por una variable que YA trae windowsHide (se verifica abajo).
const VARIABLE_CON_OCULTO = [
  { archivo: 'src/run-safe.js', args: /,\s*o$|Object\.assign\(\{\},\s*o,/ },
];

function cierre(s, i) {
  let d = 0;
  for (let k = i; k < s.length; k++) {
    const c = s[k];
    if (c === '/' && s[k + 1] === '/') { k = s.indexOf('\n', k); if (k < 0) return -1; continue; }
    if (c === '/' && s[k + 1] === '*') { k = s.indexOf('*/', k) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; k++;
      while (k < s.length && s[k] !== q) {
        if (s[k] === '\\') k++;
        else if (q === '`' && s[k] === '$' && s[k + 1] === '{') { let dd = 0; for (; k < s.length; k++) { if (s[k] === '{') dd++; else if (s[k] === '}') { dd--; if (dd === 0) break; } } }
        k++;
      }
      continue;
    }
    if (c === '(') d++;
    else if (c === ')') { d--; if (d === 0) return k; }
  }
  return -1;
}

function archivos() {
  const out = [];
  for (const d of DIRS) {
    const abs = path.join(REPO, d);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs)) if (/\.(cjs|js|mjs)$/.test(f) && !/\.test\./.test(f)) out.push(path.join(abs, f));
  }
  for (const f of EXTRA) out.push(path.join(REPO, f));
  return out;
}

function llamadasSinOcultar() {
  const malas = [];
  for (const f of archivos()) {
    const s = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
    const rel = path.relative(REPO, f).split(path.sep).join('/');
    let m; RE.lastIndex = 0;
    while ((m = RE.exec(s))) {
      const antes = s.slice(Math.max(0, m.index - 12), m.index);
      if (/function\s*$/.test(antes) || (/\.\s*$/.test(antes) && !m[1])) continue;
      const linea = s.slice(s.lastIndexOf('\n', m.index) + 1, m.index);
      if (/^\s*(\/\/|\*|\/\*)/.test(linea)) continue;   // mención en un comentario
      const abre = m.index + m[0].length - 1;
      const fin = cierre(s, abre);
      if (fin < 0) continue;
      const args = s.slice(abre + 1, fin);
      if (/windowsHide/.test(args)) continue;
      if (VARIABLE_CON_OCULTO.some((v) => v.archivo === rel && v.args.test(args.trim()))) continue;
      malas.push(`${rel}:${s.slice(0, m.index).split('\n').length}  ${m[0]}${args.slice(0, 60).replace(/\n/g, ' ')}`);
    }
  }
  return malas;
}

test('VO-1 ninguna llamada a child_process del código instalable deja la ventana de consola visible', () => {
  const malas = llamadasSinOcultar();
  assert.deepStrictEqual(malas, [], 'agrega `windowsHide: true` a estas llamadas:\n  ' + malas.join('\n  '));
});

test('VO-2 las opciones por defecto de src/run-safe.js llevan windowsHide (las llamadas con variable dependen de eso)', () => {
  const s = fs.readFileSync(path.join(REPO, 'src', 'run-safe.js'), 'utf8');
  assert.match(s, /function nodo[\s\S]*?Object\.assign\(\{ stdio: 'pipe', windowsHide: true \}/);
  assert.match(s, /function herramienta[\s\S]*?Object\.assign\(\{ stdio: 'pipe', windowsHide: true \}/);
});
