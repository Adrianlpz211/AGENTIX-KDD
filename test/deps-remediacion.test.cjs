'use strict';

/* H14 — dependencias remediadas sin --force ni downgrade ciego; avisos
   clasificados por exposición con fuente; aviso nuevo visible sin cambio de lock. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const da = require('../.agentic/grafo/deps-audit.cjs');

function proyecto() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-h14-'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"p","version":"1.0.0"}');
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'p' },
      'node_modules/axios': { version: '1.18.1' },
      'node_modules/@xenova/transformers': { version: '2.17.2', dev: true },
      'node_modules/protobufjs': { version: '6.11.4', dev: true },
      'node_modules/better-sqlite3': { version: '9.6.0', optional: true },
    },
  }));
  return root;
}

const aviso = (url, title, range) => ({ url, title, range, severity: 'high' });
function respuesta(extra = []) {
  return {
    stdout: JSON.stringify({
      vulnerabilities: {
        axios: { severity: 'high', isDirect: true, fixAvailable: true, via: [aviso('https://github.com/advisories/GHSA-vh66-26gq-q6x8', 'Axios prototype pollution', '<1.20.0')] },
        protobufjs: { severity: 'critical', isDirect: false, fixAvailable: { name: '@xenova/transformers', version: '1.4.2', isSemVerMajor: true },
          via: [aviso('https://github.com/advisories/GHSA-xq3m-2v4x-88gg', 'Arbitrary code execution in protobufjs', '<7.5.5'), ...extra] },
        'better-sqlite3': { severity: 'high', isDirect: true, fixAvailable: false, via: [aviso('https://github.com/advisories/GHSA-test-0000-0000', 'x', '*')] },
      },
      metadata: { vulnerabilities: { critical: 1, high: 2, moderate: 0, low: 0, info: 0, total: 3 } },
    }),
    code: 1,
  };
}

test('H14: avisos clasificados por exposición, con fuente y arreglo honesto', () => {
  const r = da.auditar(proyecto(), { ejecutar: () => respuesta() });
  const por = Object.fromEntries(r.paquetes.map((p) => [p.nombre, p]));
  assert.strictEqual(por.axios.exposicion, 'prod');
  assert.strictEqual(por.axios.arreglo, 'compatible');
  assert.strictEqual(por.protobufjs.exposicion, 'dev');
  assert.strictEqual(por.protobufjs.arreglo, 'solo_mayor');
  assert.strictEqual(por.protobufjs.arreglable, false, 'bajar a 1.4.2 no se ofrece como arreglo automático');
  assert.strictEqual(por['better-sqlite3'].exposicion, 'optional');
  assert.strictEqual(por['better-sqlite3'].arreglo, 'sin_arreglo');
  assert.ok(por.protobufjs.fuentes[0].startsWith('https://github.com/advisories/'));
  const texto = da.formatear(r);
  assert.match(texto, /nunca --force/);
  assert.match(texto, /mitigar y documentar/);
});

test('H14: aviso nuevo detectado sin que cambie el lock; revisión periódica', () => {
  const root = proyecto();
  const t0 = Date.parse('2026-10-01T00:00:00Z');
  da.auditar(root, { ejecutar: () => respuesta(), ahora: t0 });
  assert.deepStrictEqual(da.tocaRevisar(root, ['src/a.js'], { ahora: t0 + 3600e3 }).revisar, false);
  const tarde = da.tocaRevisar(root, ['src/a.js'], { ahora: t0 + da.PERIODO_MS + 1 });
  assert.strictEqual(tarde.revisar, true);
  assert.strictEqual(tarde.motivo, 'revisión periódica');
  assert.strictEqual(da.tocaRevisar(root, ['package-lock.json'], { ahora: t0 + 1 }).revisar, true);

  const nuevo = aviso('https://github.com/advisories/GHSA-f38q-mgvj-vph7', 'protobufjs names shadow properties', '<=7.6.2');
  const r = da.auditar(root, { ejecutar: () => respuesta([nuevo]), ahora: t0 + da.PERIODO_MS + 1 });
  assert.deepStrictEqual(r.nuevos, [nuevo.url]);
  assert.strictEqual(r.lock_igual, true);
  assert.match(da.formatear(r), /NUEVO\(s\) sin que cambiara el lock/);
});

test('H14: remediación en el repo — axios fuera, transformers sucesor, sin instalación silenciosa', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8'));
  const todas = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies };
  assert.strictEqual(todas.axios, undefined, 'axios no lo usaba nadie: fuera de producción');
  assert.strictEqual(todas['@xenova/transformers'], undefined);
  assert.ok(pkg.devDependencies['@huggingface/transformers']);
  const lock = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package-lock.json'), 'utf8'));
  assert.strictEqual(lock.packages['node_modules/@xenova/transformers'], undefined);
  assert.strictEqual(lock.packages['node_modules/axios'], undefined);
  const pb = lock.packages['node_modules/protobufjs'];
  if (pb) {
    const [ma, mi, pa] = pb.version.split('.').map(Number);
    assert.ok(ma > 7 || (ma === 7 && (mi > 6 || (mi === 6 && pa > 2))), `protobufjs ${pb.version} fuera de los rangos avisados`);
  }

  const emb = require('../.agentic/grafo/embeddings.cjs');
  assert.strictEqual(emb.LIBRERIAS[0].nombre, '@huggingface/transformers');
  const src = fs.readFileSync(path.join(RAIZ, '.agentic', 'grafo', 'embeddings.cjs'), 'utf8');
  assert.doesNotMatch(src, /execSync|npm install @xenova/, 'el framework no instala paquetes en el proyecto por su cuenta');
});
