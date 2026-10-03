'use strict';
// Canarios: valores FALSOS con formato de secreto, codificados para que el escáner de secretos del repo no los confunda con una filtración real.
const dec = (b) => Buffer.from(b, 'base64').toString('utf8');
/* C01 — Privacidad antes de persistir. No necesita base de datos. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const priv = require('../.agentic/grafo/memory-privacy.cjs');

// Canarios: cada uno es un secreto de formato distinto. Ninguno puede sobrevivir.
const CANARIOS = {
  bearer: [dec('QmVhcmVyIGFiY2RlZjEyMzQ1Njc4OTBaWlpa'), 'abcdef1234567890ZZZZ'],
  github: [dec('Z2hwX2ExQjJjM0Q0ZTVGNmc3SDhpOUowazFMMm0zTjRvNVA2'), 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6'],
  stripe: [dec('c2tfbGl2ZV9aejlZeThYeDdXdzZWdjVVdTQ='), 'Zz9Yy8Xx7Ww6Vv5Uu4'],
  aws: [dec('QUtJQUFCQ0RFRkdISUpLTE1OT1A='), 'ABCDEFGHIJKLMNOP'],
  jwt: [dec('ZXlKaGJHY2lPaUpJVXpJMU5pSjkuZXlKemRXSWlPaUl4TWpNME5UWTNPRGt3SW4wLmRCamZ0SmVaNENWUG1COTJLMjd1aGJVSlUxcDFy'), 'dBjftJeZ4CVPmB92K27uhbUJU1p1r'],
  pem: [dec('LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tCk1JSUV2UUlCQURBTkJna3Foa2lHOXcwQkFRRUZBQVNDCi0tLS0tRU5EIFBSSVZBVEUgS0VZLS0tLS0='), 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'],
  url: [dec('cG9zdGdyZXM6Ly9hZG1pbjpTM2NyM3RQNHNzQGRiLmludGVybm86NTQzMi9wcm9k'), 'S3cr3tP4ss'],
  env: ['DATABASE_PASSWORD=hunter2hunter2', 'hunter2hunter2'],
  json: ['{"client_secret":"zzz-top-secret-zzz"}', 'zzz-top-secret-zzz'],
  header: ['Cookie: sessionid=9f8e7d6c5b4a3210', '9f8e7d6c5b4a3210'],
};

test('privacidad: cada formato de secreto canario queda tapado', () => {
  for (const [nombre, [valor, secreto]] of Object.entries(CANARIOS)) {
    const r = priv.redactarSecretos('antes ' + valor + ' después');
    assert.ok(r.ok, nombre);
    assert.ok(!r.text.includes(secreto), nombre + ' sobrevivió: ' + r.text);
    assert.ok(r.redactions >= 1, nombre + ' sin conteo');
  }
});

test('privacidad: FALLA CERRADO — si la redacción lanza, jamás se devuelve el original', () => {
  const peligroso = { toString() { throw new Error('boom'); } };
  const r = priv.redactarSecretos(peligroso);
  assert.equal(r.ok, false);
  assert.equal(r.text, priv.FALLO);
  assert.equal(priv.redactar(peligroso), priv.FALLO);
  const p = priv.prepararParaPersistir({ text: peligroso });
  assert.equal(p.privacy_class, 'unknown');
  assert.equal(p.text, null, 'ni payload ni vista previa');
  assert.equal(priv.resumenSeguro({ get a() { throw new Error('x'); } }), priv.FALLO);
});

test('privacidad: rutas privadas conservan solo metadatos (sin payload ni preview)', () => {
  for (const ruta of ['.env', '.env.production', 'config/secrets.json', 'a/b/id_rsa', 'x/clave.pem', '.ssh/config', '.npmrc']) {
    const p = priv.prepararParaPersistir({ path: ruta, text: 'API_KEY=1234567890abcdef' });
    assert.equal(p.privacy_class, 'private', ruta);
    assert.equal(p.text, null, ruta);
  }
  assert.equal(priv.prepararParaPersistir({ path: 'src/app.js', text: 'ok' }).privacy_class, 'authorized');
});

test('privacidad: un binario no se puede escanear → unknown, solo metadatos', () => {
  const p = priv.prepararParaPersistir({ bytes: Buffer.from([1, 2, 0, 255]) });
  assert.equal(p.privacy_class, 'unknown');
  assert.equal(p.text, null);
});

test('privacidad: la política del proyecto añade rutas denegadas y patrones propios; una política ilegible NO relaja nada', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-pol-'));
  try {
    fs.mkdirSync(path.join(root, '.agentic'));
    fs.writeFileSync(path.join(root, '.agentic', 'privacy-policy.json'), JSON.stringify({ policy_id: 'cliente-x', deny_paths: ['datos-clientes/**'], deny_fields: ['cedula'], extra_patterns: ['CLI-\\d{6}'] }));
    const pol = priv.cargarPolitica(root);
    assert.equal(pol.policy_id, 'cliente-x');
    assert.equal(priv.prepararParaPersistir({ path: 'datos-clientes/a/b.csv', text: 'x' }, pol).privacy_class, 'private');
    assert.equal(priv.prepararParaPersistir({ field: 'cedula', text: 'x' }, pol).privacy_class, 'private');
    assert.ok(!priv.redactarSecretos('id CLI-123456 fin', pol).text.includes('CLI-123456'));
    assert.equal(priv.rutaPrivada(root, 'datos-clientes/z.txt'), true);
    // Ilegible: cae a la política por defecto (más estricta que ninguna) y avisa.
    fs.writeFileSync(path.join(root, '.agentic', 'privacy-policy.json'), '{ no es json');
    const mala = priv.cargarPolitica(root);
    assert.equal(mala.origen, 'default');
    assert.ok(mala.aviso);
    assert.equal(priv.prepararParaPersistir({ path: '.env', text: 'x' }, mala).privacy_class, 'private', 'el denegado base sigue vigente');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('privacidad: en código fuente no se destruye lo legítimo; en logs sí se tapa el valor plano', () => {
  const codigo = dec('Y29uc3QgdG9rZW4gPSByZXF1aXJlKCd4Jyk7CmNvbnN0IGFwaUtleSA9ICdza19saXZlX2FiY2RlZmdoaWprbDEyMzQnOwpjb25zdCB0ID0gcHJvY2Vzcy5lbnYuVE9LRU47Cg==');
  const c = priv.prepararParaPersistir({ path: 'src/a.js', text: codigo });
  assert.equal(c.mode, 'codigo');
  assert.ok(c.text.includes("require('x')"), 'la llamada legítima queda intacta');
  assert.ok(c.text.includes('process.env.TOKEN'));
  assert.ok(!c.text.includes('abcdefghijkl1234'), 'el literal secreto sí se tapa');
  const log = priv.prepararParaPersistir({ path: 'run.log', text: 'token = abc12345 api_key: zzzzzzzz' });
  assert.ok(!log.text.includes('abc12345') && !log.text.includes('zzzzzzzz'));
});

test('privacidad: resúmenes tapan secretos y PII; fechas y cifras de un log no se destruyen en el cuerpo', () => {
  const s = priv.resumenSeguro({ user: 'ana@correo.com', password: 'p4ss', n: 5, nota: 'llamar al +58 412 555 1234' });
  assert.ok(!/ana@correo|p4ss|412 555/.test(s), s);
  const cuerpo = priv.redactarSecretos('2026-10-03 10:07:34 · 1234567 filas · 500 ms').text;
  assert.equal(cuerpo, '2026-10-03 10:07:34 · 1234567 filas · 500 ms', 'el original de un log no pierde fechas ni cifras (solo secretos)');
  const largo = priv.resumenSeguro('x'.repeat(5000), { max: 100 });
  assert.ok(largo.length <= 100);
});

test('privacidad: sanitizarValor tapa por NOMBRE de clave sin importar el valor', () => {
  const v = priv.sanitizarValor({ headers: { Authorization: 'x', ok: 'visible' }, creds: [{ password: 'p', user: 'u' }], 'api-key': 'k' });
  assert.equal(v.headers.Authorization, priv.MARCA);
  assert.equal(v.headers.ok, 'visible');
  assert.equal(v.creds[0].password, priv.MARCA);
  assert.equal(v.creds[0].user, 'u');
  assert.equal(v['api-key'], priv.MARCA);
});

test('privacidad: nunca se guarda un hash del secreto en lugar de redactarlo', () => {
  const s = priv.redactarSecretos('password=hunter2hunter2').text;
  assert.ok(!/[a-f0-9]{16,}/.test(s), 'un hash de un valor de baja entropía se invierte probando candidatos');
});
