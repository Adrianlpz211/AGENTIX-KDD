'use strict';
/* Instrucciones propias en CLAUDE.md: ningún segmento del usuario puede desaparecer (3.20.1). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { migrarInstruccionesUsuario } = require('../src/update.js');
const { partirInstrucciones } = require('../src/update-classify.js');
const { update } = require('../src/update.js');
const legacy = require('./helpers/legacy-real.cjs');
const { SIN_DRIVER } = require('./helpers/db-real.cjs');

const REPO = path.resolve(__dirname, '..');
const PLANTILLA = fs.readFileSync(path.join(REPO, 'CLAUDE.md'), 'utf8').replace(/\r\n/g, '\n');
const MARCO = '# ============================================================';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-instr-'));

/** CLAUDE.md = plantilla real + lo que escribió el usuario debajo del marcador. */
function conUsuario(texto, { eol = '\n', pegar = '\n' } = {}) {
  const base = PLANTILLA.replace(/\s+$/, '\n');
  return (base + pegar + texto).split('\n').join(eol);
}
function migrar(contenido) {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), contenido);
  const destino = path.join(root, '.agentic', 'INSTRUCCIONES-PROYECTO.md');
  const hizo = migrarInstruccionesUsuario(root, destino);
  return { hizo, destino, guardado: fs.existsSync(destino) ? fs.readFileSync(destino, 'utf8') : null, root };
}
const norm = (t) => t.replace(/\r\n/g, '\n').trim();

const USUARIO = ['## Mi regla crítica', 'No tocar dbo.pedido.', '', '### Detalle', '- Cierre el día 3', '', '# Un título de nivel 1 mío', 'texto bajo H1'].join('\n');

test('instrucciones: LF y CRLF dan lo mismo y no se pierde ningún encabezado (#, ##, ###)', () => {
  const lf = migrar(conUsuario(USUARIO));
  const crlf = migrar(conUsuario(USUARIO, { eol: '\r\n' }));
  for (const r of [lf, crlf]) {
    assert.equal(r.hizo, true);
    for (const h of ['## Mi regla crítica', '### Detalle', '# Un título de nivel 1 mío', 'texto bajo H1', 'No tocar dbo.pedido.']) assert.ok(norm(r.guardado).includes(h), 'falta: ' + h);
  }
  assert.equal(norm(lf.guardado), norm(crlf.guardado));
});

test('instrucciones: un encabezado # PEGADO al cierre del marco (sin línea en blanco) tampoco se come', () => {
  const r = migrar(conUsuario('# Reglas del equipo\nUsar pnpm.\n## Estilo\nSin punto y coma.', { pegar: '' }));
  assert.equal(r.hizo, true);
  assert.match(r.guardado, /# Reglas del equipo\nUsar pnpm\./);
  assert.match(r.guardado, /## Estilo/);
});

test('instrucciones: texto ANTES del marcador (plantilla editada) y DESPUÉS: solo lo de debajo se mueve', () => {
  const conCabeza = '# MI PRÓLOGO PROPIO ANTES DEL MARCADOR\n\n' + conUsuario(USUARIO);
  const r = migrar(conCabeza);
  assert.equal(r.hizo, true);
  assert.ok(!r.guardado.includes('PRÓLOGO'), 'lo de arriba es la zona del framework: no se mueve');
  assert.ok(fs.readFileSync(path.join(r.root, 'CLAUDE.md'), 'utf8').includes('PRÓLOGO'), 'y el CLAUDE.md original no se tocó al migrar');
});

test('instrucciones: VARIOS marcadores — se usa el primero y todo lo que sigue (incluido otro marcador pegado) se conserva', () => {
  const doble = conUsuario('## Antes\nregla uno\n\n' + MARCO + '\n# INSTRUCCIONES DEL PROYECTO\n' + MARCO + '\n## Después de otro marcador\nregla dos');
  const r = migrar(doble);
  assert.equal(r.hizo, true);
  for (const t of ['## Antes', 'regla uno', '# INSTRUCCIONES DEL PROYECTO', '## Después de otro marcador', 'regla dos']) assert.ok(r.guardado.includes(t), 'falta: ' + t);
});

test('instrucciones: sin marcador no se mueve nada; sin texto del usuario tampoco', () => {
  assert.equal(migrar('# Un CLAUDE.md sin marcador\ncontenido\n').hizo, false);
  const vacio = migrar(PLANTILLA);
  assert.equal(vacio.hizo, false);
  assert.equal(vacio.guardado, null);
});

test('instrucciones: Unicode (acentos, eñes, emoji, CJK) intacto', () => {
  const u = '## Reglas 🦆\nñandú, canción, árbol — "comillas"\n日本語のルール\nقاعدة';
  const r = migrar(conUsuario(u));
  assert.equal(r.hizo, true);
  assert.ok(r.guardado.includes('ñandú, canción, árbol'));
  assert.ok(r.guardado.includes('🦆') && r.guardado.includes('日本語のルール') && r.guardado.includes('قاعدة'));
});

test('instrucciones: INSTRUCCIONES-PROYECTO.md ya existente NO se pisa', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), conUsuario('## Texto nuevo en CLAUDE.md'));
  fs.mkdirSync(path.join(root, '.agentic'), { recursive: true });
  const propio = path.join(root, '.agentic', 'INSTRUCCIONES-PROYECTO.md');
  fs.writeFileSync(propio, '# mis reglas de siempre\n');
  assert.equal(migrarInstruccionesUsuario(root, propio), false);
  assert.equal(fs.readFileSync(propio, 'utf8'), '# mis reglas de siempre\n');
});

test('instrucciones: la lógica del actualizador y la del clasificador cortan en el MISMO punto', () => {
  for (const u of [USUARIO, '# H1 pegado\ntexto', '## solo h2', 'línea suelta', '## Mi regla\n\n\n### x\n- a']) {
    for (const eol of ['\n', '\r\n']) {
      const c = conUsuario(u, { eol });
      const a = migrar(c);
      const p = partirInstrucciones(c);
      const delActualizador = a.guardado ? a.guardado.split('\n').slice(5).join('\n') : '';
      assert.equal(norm(delActualizador), norm(p.usuario), 'divergen con ' + JSON.stringify(u) + (eol === '\r\n' ? ' CRLF' : ''));
    }
  }
});

test('update de punta a punta: INSTRUCCIONES existente DISTINTO al texto de CLAUDE.md — se conservan AMBOS originales y no desaparece nada', { skip: SIN_DRIVER }, async () => {
  const p = legacy.proyectoReal('3.20.0', 'instr');
  const claude = path.join(p.root, 'CLAUDE.md');
  const textoEnClaude = '## Regla que vivía en CLAUDE.md\nNunca usar SELECT *.';
  const textoEnArchivo = '# Instrucciones del proyecto\n\n## Regla del archivo propio\nSiempre revisar tenant_id.';
  fs.writeFileSync(claude, conUsuario(textoEnClaude));
  fs.writeFileSync(path.join(p.root, '.agentic', 'INSTRUCCIONES-PROYECTO.md'), textoEnArchivo);
  const claudeOriginal = fs.readFileSync(claude, 'utf8');
  const r = await update({ projectPath: p.root, salir: false, silent: true, __sinFuncional: true });
  assert.ok(r.ok, JSON.stringify([r.status, r.errors]));
  const final = norm(fs.readFileSync(claude, 'utf8'));
  assert.ok(final.includes('Nunca usar SELECT *'), 'el texto que vivía en CLAUDE.md se conserva');
  assert.ok(final.includes('Siempre revisar tenant_id'), 'el del archivo propio también');
  assert.ok(r.instructions.merged_previous_text, 'se informó la fusión');
  assert.equal(fs.readFileSync(path.join(p.root, '.agentic', 'INSTRUCCIONES-PROYECTO.md'), 'utf8'), textoEnArchivo, 'el archivo propio no se escribió');
  const respaldo = fs.readFileSync(path.join(p.root, '.agentic', '_update', 'tx', r.op_id, 'backup', 'CLAUDE.md'), 'utf8');
  assert.equal(respaldo, claudeOriginal, 'el CLAUDE.md original quedó respaldado en el journal');
  assert.equal((final.match(/# INSTRUCCIONES DEL PROYECTO/g) || []).length, 1, 'el marcador no se duplica');
});
