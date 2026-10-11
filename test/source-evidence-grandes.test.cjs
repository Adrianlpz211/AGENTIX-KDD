'use strict';
/* Caso real (medinet, octubre 2026): un `repomix-output.xml` de 122 MB en la raíz superaba el tope de 100 MB de la huella del código, que salía SIEMPRE
   incompleta: toda verificación terminaba UNVERIFIED (SOURCE_CHANGED_OR_INCOMPLETE), no nació ningún contrato en 10 días y el motor creativo se quedó sin
   datos. Un archivo enorme no se lee (huella = tamaño + fecha), y una caché evita releer lo que no cambió. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SE = require(path.join(__dirname, '..', '.agentic', 'grafo', 'source-evidence.cjs'));
const MB = 1024 * 1024;

function proyecto() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-huella-'));
  fs.mkdirSync(path.join(root, '.agentic'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(root, 'src', 'a.test.ts'), "import { a } from './a';\n");
  return root;
}
function archivoGrande(ruta, mb) { const fd = fs.openSync(ruta, 'w'); fs.ftruncateSync(fd, mb * MB); fs.closeSync(fd); }

test('SEG-1 un archivo más grande que el umbral no se lee: va por tamaño + fecha y la huella queda completa', () => {
  const root = proyecto();
  archivoGrande(path.join(root, 'volcado.xml'), 3);
  const h = SE.capture(root, { grande: 1 * MB, maxBytes: 2 * MB });
  assert.equal(h.complete, true, 'motivo: ' + h.motivo);
  assert.match(h.files['volcado.xml'], /^grande:\d+:\d+$/);
  assert.match(h.files['src/a.ts'], /^[0-9a-f]{64}$/, 'el código normal sí se lee y se hashea');
});

test('SEG-2 el caso real: un volcado de 120 MB en la raíz ya no vuelve la huella incompleta', () => {
  const root = proyecto();
  archivoGrande(path.join(root, 'repomix-output.xml'), 120);
  const t = Date.now();
  const h = SE.capture(root);
  assert.equal(h.complete, true, 'motivo: ' + h.motivo);
  assert.ok(Date.now() - t < 20000, 'no lee los 120 MB: tardó ' + (Date.now() - t) + ' ms');
  assert.ok('src/a.test.ts' in h.files, 'las pruebas sí están en la huella');
});

test('SEG-3 un cambio en el archivo grande (otro tamaño) se sigue detectando', () => {
  const root = proyecto();
  const g = path.join(root, 'volcado.xml'); archivoGrande(g, 3);
  const antes = SE.capture(root, { grande: 1 * MB });
  archivoGrande(g, 4);
  const despues = SE.capture(root, { grande: 1 * MB });
  assert.deepEqual(SE.diff(antes, despues), ['volcado.xml']);
});

test('SEG-4 si se agota el presupuesto de lectura, el resto va por tamaño + fecha y la huella sigue completa; el tope de archivos sí la rompe, con su motivo', () => {
  const root = proyecto();
  for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(root, 'src', `f${i}.ts`), 'x'.repeat(600 * 1024));   // 4 × 600 KB, bajo el umbral de «grande»
  const h = SE.capture(root, { maxBytes: 1 * MB, grande: 1 * MB, cache: false });
  assert.equal(h.complete, true, 'motivo: ' + h.motivo);
  assert.ok(Object.values(h.files).some((v) => /^presupuesto:\d+:\d+$/.test(v)), 'lo que no cupo en el presupuesto quedó con marca de tamaño + fecha');
  assert.ok(Object.values(h.files).some((v) => /^[0-9a-f]{64}$/.test(v)), 'lo que sí cupo se hasheó');
  const h2 = SE.capture(root, { maxArchivos: 2, cache: false });
  assert.equal(h2.complete, false);
  assert.match(h2.motivo, /más de 2 archivos/);
});

test('SEG-7 el caso protocolo_reserva: miles de imágenes bajo 2 MB que juntas pasan de 100 MB no vuelven la huella incompleta', () => {
  const root = proyecto();
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  for (let i = 0; i < 6; i++) { const fd = fs.openSync(path.join(root, 'assets', `img${i}.png`), 'w'); fs.ftruncateSync(fd, 1.5 * MB); fs.closeSync(fd); }
  const h = SE.capture(root, { maxBytes: 4 * MB, cache: false });   // 9 MB de imágenes con un presupuesto de 4 MB
  assert.equal(h.complete, true, 'motivo: ' + h.motivo);
  assert.match(h.files['assets/img0.png'], /^bin:\d+:\d+$/);
  assert.match(h.files['src/a.ts'], /^[0-9a-f]{64}$/, 'el código sigue por contenido');
});

test('SEG-5 la caché: lo que no cambió no se relee y lo que cambió se detecta (aunque mida lo mismo)', () => {
  const root = proyecto();
  const a = SE.capture(root);
  assert.ok(fs.existsSync(path.join(root, '.agentic', '_cache', 'huella-v1.json')), 'deja su caché');
  const b = SE.capture(root);
  assert.equal(b.hash, a.hash, 'misma huella con la caché');
  const f = path.join(root, 'src', 'a.ts');
  fs.writeFileSync(f, 'export const a = 2;\n');   // mismo tamaño, otro contenido
  const t = new Date(Date.now() + 5000); fs.utimesSync(f, t, t);   // y una fecha distinta, como en cualquier edición real
  const c = SE.capture(root);
  assert.notEqual(c.hash, a.hash);
  assert.deepEqual(SE.diff(a, c), ['src/a.ts']);
  const sinCache = SE.capture(root, { cache: false });
  assert.equal(sinCache.hash, c.hash, 'con y sin caché sale lo mismo');
});

test('SEG-6 sin carpeta .agentic no siembra ninguna caché', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-huella-sin-'));
  fs.writeFileSync(path.join(root, 'x.js'), '1');
  const h = SE.capture(root);
  assert.equal(h.complete, true);
  assert.ok(!fs.existsSync(path.join(root, '.agentic')), 'no crea .agentic');
});
