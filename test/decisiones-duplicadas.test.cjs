'use strict';
/* medinet (11/10/2026): una sesión individual sugirió decisiones al tablero, el dueño las respondió y la sesión siguió pidiéndolas porque nada le decía que ya estaban
   resueltas. Ahora una pregunta parecida a una abierta o resuelta se rechaza con la respuesta, y todas las sesiones ven lo resuelto en su aviso de cada turno. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const G = path.join(__dirname, '..', '.agentic', 'grafo');
const T = require(path.join(G, 'teams.cjs'));
const D = require(path.join(G, 'decisiones.cjs'));
const TB = require(path.join(G, 'tablero.cjs'));
process.env.AKDD_TEAMS_NO_AVISO = '1';

function proyecto() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-dup-'));
  fs.mkdirSync(path.join(root, '.agentic'), { recursive: true });
  T.ejecutar(['activar'], root); T.ejecutar(['modo', 'individual'], root); T.ejecutar(['iniciar'], root);
  return root;
}
const Q = 'Que politica de lectura aplicamos al bucket consultas para que la paciente vea las fotos del informe';
const crear = (root, t, extra = {}) => TB.crearItem(root, Object.assign({ titulo: t, clase: 'decision', opciones: 'Si=Aprobar|No=Rechazar', recomendacion: 'Si', impacto: 'x', por_que: 'y' }, extra), { por: 'director' });

test('DUP-1 una pregunta parecida a una que sigue abierta se rechaza (no se duplica)', () => {
  const root = proyecto();
  const a = crear(root, Q); assert.equal(a.ok, true, JSON.stringify(a));
  const b = crear(root, 'Politica de lectura del bucket consultas: que la paciente vea las fotos del informe');
  assert.equal(b.ok, false); assert.equal(b.code, 'YA_PREGUNTADA'); assert.match(b.message, new RegExp(a.id));
});

test('DUP-2 una pregunta ya RESUELTA se rechaza mostrando la respuesta del dueño', () => {
  const root = proyecto();
  const a = crear(root, Q);
  D.responder(root, a.id, { opcion: 'Si', texto: 'Preparar la politica y mostrarme el SQL' }, { via: 'dashboard' });
  D.aplicada(root, a.id, 'politica preparada', 'director');
  const b = crear(root, 'Que politica de lectura va en el bucket consultas para que la paciente vea las fotos del informe?');
  assert.equal(b.code, 'YA_RESUELTA', JSON.stringify(b)); assert.match(b.message, /resuelta y ejecutada/);
});

test('DUP-3 --forzar permite repetir; una pregunta distinta y las tareas nunca se bloquean', () => {
  const root = proyecto();
  crear(root, Q);
  assert.equal(crear(root, Q, { forzar: true }).ok, true);
  assert.equal(crear(root, 'Que proveedor de correo usamos para los recordatorios de citas de los pacientes').ok, true);
  assert.equal(TB.crearItem(root, { titulo: Q, clase: 'tarea' }, { por: 'director' }).ok, true);
});

test('DUP-4 el aviso de cada turno lleva lo resuelto reciente con su respuesta, aunque ya esté ejecutado', () => {
  const root = proyecto();
  const a = crear(root, Q);
  D.responder(root, a.id, { opcion: 'Si', texto: 'Preparar la politica' }, { via: 'dashboard' });
  D.aplicada(root, a.id, 'hecho', 'director');
  const aviso = TB.avisoParaHook(root, 'director');
  assert.match(aviso, /ya RESUELTAS/); assert.match(aviso, new RegExp(a.id)); assert.match(aviso, /Preparar la politica/);
});
