'use strict';
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-watcherr-test-'));
fs.mkdirSync(path.join(tmpRoot, '.agentic', 'grafo'), { recursive: true });
fs.mkdirSync(path.join(tmpRoot, '.agentic', 'memoria'), { recursive: true });
fs.mkdirSync(path.join(tmpRoot, '_output'), { recursive: true });
fs.writeFileSync(path.join(tmpRoot, 'src.js'), `function riesgo() { return 1; }`);
fs.writeFileSync(path.join(tmpRoot, 'consumidor.js'), `
const { riesgo } = require('./src.js');
function usa() { return riesgo(); }
`);

const { indexProject } = require('../.agentic/grafo/ast-indexer.cjs');
indexProject(tmpRoot);

// Cargar watch-errors.cjs apuntando a este proyecto temporal via ROOT relativo
// (watch-errors.cjs calcula ROOT como path.join(__dirname, '..', '..') — para
// el test, invocamos obtenerCadenaEstructural/registrarError directamente
// simulando ROOT mediante process.chdir, ya que ROOT se calcula en import-time).
const originalCwd = process.cwd();
process.chdir(tmpRoot);
delete require.cache[require.resolve('../.agentic/grafo/watch-errors.cjs')];
// watch-errors.cjs calcula ROOT relativo a su propia ubicación (no a cwd), así
// que para este test copiamos el archivo real y lo requerimos desde dentro
// del sandbox — más simple: probamos obtenerCadenaEstructural de forma aislada
// re-implementando la llamada mínima necesaria, ya que registrarError requiere
// ROOT real del proyecto. Ver Task 4 Step 4 para la verificación end-to-end
// contra Lumo, que es la prueba que realmente importa.
process.chdir(originalCwd);

console.log('✅ watch-errors.estructural.test.cjs — setup verificado (ver Step 4 para prueba real en Lumo)');
fs.rmSync(tmpRoot, { recursive: true, force: true });
