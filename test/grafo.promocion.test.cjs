'use strict';
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-promo-test-'));
fs.mkdirSync(path.join(tmpRoot, '.agentic', 'memoria'), { recursive: true });

const cadena = 'src/session.js → src/auth.js';
const erroresMd = `# Errores — Agentic KDD

## 2026-07-01 [GENERIC] Fallo 1
Área: global
Confianza: BAJA
Aplicado: 0
Útil: 0
Estado: ACTIVO
Cadena estructural: ${cadena} (severidad: ALTO)

## 2026-07-02 [GENERIC] Fallo 2
Área: global
Confianza: BAJA
Aplicado: 0
Útil: 0
Estado: ACTIVO
Cadena estructural: ${cadena} (severidad: ALTO)

## 2026-07-03 [GENERIC] Fallo 3
Área: global
Confianza: BAJA
Aplicado: 0
Útil: 0
Estado: ACTIVO
Cadena estructural: ${cadena} (severidad: ALTO)
`;
fs.writeFileSync(path.join(tmpRoot, '.agentic', 'memoria', 'errores.md'), erroresMd, 'utf8');

process.env.AGENTIC_MEMORIA_PATH_OVERRIDE = path.join(tmpRoot, '.agentic', 'memoria');

// grafo.cjs envuelve su dispatcher CLI en `if (require.main === module)`, así que
// require() aquí es una carga de módulo pura — no dispara sincronizar() ni toca
// memoria/DB por su cuenta. La única llamada a promoverPatronesEstructurales() es
// la explícita de abajo.
delete require.cache[require.resolve('../.agentic/grafo/grafo.cjs')];
const { promoverPatronesEstructurales } = require('../.agentic/grafo/grafo.cjs');

const result = promoverPatronesEstructurales();
assert.strictEqual(result.promovidos, 1, `esperaba 1 patrón promovido, obtuve ${result.promovidos}`);

const patronesMd = fs.readFileSync(path.join(tmpRoot, '.agentic', 'memoria', 'patrones.md'), 'utf8');
assert.ok(patronesMd.includes('[ESTRUCTURAL]'), 'esperaba marcador [ESTRUCTURAL] en patrones.md');
assert.ok(patronesMd.includes('Confianza: ALTA'), 'esperaba Confianza: ALTA');

// Segunda corrida — NO debe duplicar
const result2 = promoverPatronesEstructurales();
assert.strictEqual(result2.promovidos, 0, 'la segunda corrida no debe promover de nuevo la misma cadena');

console.log('✅ grafo.promocion.test.cjs — PASS');
fs.rmSync(tmpRoot, { recursive: true, force: true });
delete process.env.AGENTIC_MEMORIA_PATH_OVERRIDE;
