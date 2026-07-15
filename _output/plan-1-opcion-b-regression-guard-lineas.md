# Plan 1 — Regression Guard con precisión por líneas (Opción B completa)

> **✅ ESTADO: IMPLEMENTADO Y VERIFICADO (2026-07-15).** Ejecutado primero en
> C:\lumoV2 (15/15 escenarios de verificación pasando contra endpoints y
> behaviors reales) y portado el mismo día a AGENTIX-KDD-main (paridad byte a
> byte, 322/322 funciones con line_end). Este documento queda como referencia
> de diseño y para replicar en otros proyectos. Dos refinamientos descubiertos
> al implementar ya están incorporados abajo: (1) diff vacío → DOUBT; (2)
> `struct` (Go) agregado a los kinds de frontera.

> **Para ejecutar con `aa:` en el repo AGENTIX-KDD.** Documento autocontenido: no
> requiere el chat donde se diseñó. Generado el 2026-07-15 con Fable 5 después de
> leer el código real — cada afirmación de "estado actual" fue verificada contra
> los archivos ese día. Ejecutar los pasos EN ORDEN.

---

## Objetivo en una línea

Que el Regression Guard deje de decidir a nivel "archivo completo" y pueda
responder: **"¿las líneas que cambiaste caen DENTRO del rango de algo protegido,
o tocan otra parte del archivo que nunca dio problema?"** — sin usar comparación
de texto/nombres (la clase de bug que ya falló 3 veces), y sin que ninguna falla
de la maquinaria nueva pueda dejar pasar algo que hoy se detecta.

---

## Los 2 principios NO NEGOCIABLES (todo el plan se cae si violas uno)

1. **Números, no palabras.** Toda decisión nueva es comparación de enteros
   (¿línea 45 ∈ [40,60]?) o igualdad EXACTA de strings generados mecánicamente
   por el mismo código en ambos lados. PROHIBIDO: `LIKE`, substring, regex sobre
   nombres en prosa. Razón: el 2026-07-15 hubo 3 bugs reales de reconocimiento de
   texto (nombres SQL entre comillas, palabra `CONCURRENTLY` capturada como
   nombre, palabras comunes NEGOCIO/HTML confundidas con símbolos).

2. **Portón cerrado ante la duda (fail-closed).** Ante CUALQUIER duda — hash
   viejo, símbolo no encontrado, `line_end = 0`, diff no parseable, behavior sin
   flows — el guardia se comporta EXACTAMENTE como hoy (nivel archivo). El peor
   caso posible de TODA la maquinaria nueva debe ser "igual que el guardia
   actual". Ninguna falla puede abrir el portón; solo pueden costar una falsa
   alarma. La precisión solo se usa con evidencia fresca y positiva COMPLETA.

---

## Estado actual verificado (2026-07-15)

| Hecho | Dónde |
|---|---|
| `ast_symbols.line_start` se llena bien; `line_end` está SIEMPRE en 0 (321 funciones indexadas, 0 con fin) | tabla `ast_symbols`, `.agentic/memoria.db` |
| Causa DOBLE del line_end=0: nadie lo calcula **Y** el INSERT ni siquiera incluye la columna | `.agentic/grafo/ast-indexer.cjs:557-561` |
| `content_hash` (SHA-256 del archivo completo) YA se guarda por fila — el chequeo de frescura es gratis | `ast-indexer.cjs:535` y columna en schema |
| El patrón "frontera por siguiente símbolo" YA está validado en el propio código (`ownerAt`) | `ast-indexer.cjs:237` (`extractCallsWithinFile`) |
| `protected_behaviors`: columnas `module, description, critical_flows(JSON), test_patterns(JSON), related_files(JSON), pass_count, confidence, status` | `.agentic/grafo/regression-guard.cjs:23-55` |
| `checkBeforeBuild` hoy: relaciona behaviors por overlap de rutas (substring), HIGH → corre tests y STOP si fallan; MEDIA → WARN siempre | `regression-guard.cjs:175-239` |
| **BUG conocido:** `extractFlows` solo matchea `app.<método>(` — pierde TODOS los endpoints declarados con `router.<método>(` | `regression-guard.cjs:85` |
| El indexador SÍ ve ambos (`router\|app`) | `ast-indexer.cjs:344` |
| `getDiff()` devuelve SOLO nombres de archivo, NO números de línea | `.agentic/grafo/git-context.cjs:37-63` |
| Consumidores de `ast_symbols` que NO deben romperse (solo cambios ADITIVOS) | `causal-edges.cjs`, `collab-manager.cjs`, `context-enricher.cjs`, `grafo.cjs`, `health-check.cjs`, `mcp-server.cjs`, `metrics.cjs`, `dashboard.cjs` |
| Memoria KDD ya registrada sobre esto (leerla con `grafo.cjs buscar "line_end"`) | `patrones.md` (frontera por siguiente símbolo), `errores.md` (columna fantasma + tryTreeSitter muerto), `decisiones.md` (dos capas, WASM) |

---

## PASO 1 — Calcular `line_end` con "frontera por siguiente símbolo"

**Dónde:** `ast-indexer.cjs`, dentro de `indexFile()`, después de obtener
`{ symbols }` del extractor y de agregar los comment markers, ANTES del INSERT.

**La regla de fronteras — CRÍTICO, elegir mal esto invierte la dirección del
error (de "sobra rango, seguro" a "falta rango, peligroso"):**

- **SON frontera** solo los kinds cuyo regex está anclado a columna 0 (`^` con
  flag `m`): `function`, `class`, `interface`, `type`, `enum`, `constant`,
  `struct` (Go emite kind 'struct' desde su typePat anclado).
  (En Python `def/class` también están anclados con `^`; en Go/Rust/Java/Kotlin/
  PHP igual — verificado en los extractores.)
- **NO son frontera:**
  - `note/why/hack/fixme` (comment markers): viven DENTRO de cuerpos de función.
    Si los usas como frontera, un `// NOTE:` en la línea 50 de una función 40-60
    recorta el rango a 40-49 → una edición en la 55 quedaría "fuera" → **dirección
    peligrosa**. Excluirlos SIEMPRE.
  - `endpoint`: su regex NO está anclado a columna 0 (puede vivir indentado
    dentro de una función que registra rutas) → mismo riesgo de recorte.
  - `sql_table` / `sql_index`: los `.sql` se calculan aparte (cada tabla/índice
    termina donde empieza el siguiente símbolo SQL; último = EOF).

**Cálculo:**

```
const totalLineas = content.split('\n').length;
const FRONTERA = new Set(['function','class','interface','type','enum','constant']);
const fronteras = symbols.filter(s => FRONTERA.has(s.kind))
                         .sort((a,b) => a.line_start - b.line_start);

// 1) fronteras entre sí
for (let i = 0; i < fronteras.length; i++) {
  fronteras[i].line_end = (i+1 < fronteras.length)
    ? fronteras[i+1].line_start - 1
    : totalLineas;
}

// 2) endpoints: hasta el próximo endpoint O la próxima frontera, lo que llegue antes
//    (cubre el handler inline de router.get('/x', async (req,res)=>{...}))
const endpoints = symbols.filter(s => s.kind === 'endpoint')
                         .sort((a,b) => a.line_start - b.line_start);
for (const ep of endpoints) {
  const siguientes = [
    ...endpoints.map(e => e.line_start).filter(l => l > ep.line_start),
    ...fronteras.map(f => f.line_start).filter(l => l > ep.line_start),
  ];
  ep.line_end = siguientes.length ? Math.min(...siguientes) - 1 : totalLineas;
}

// 3) markers y cualquier otro kind: línea única
symbols.forEach(s => { if (!s.line_end) s.line_end = s.line_start; });
```

**Dirección del error resultante:** los rangos SOBRAN (incluyen líneas en blanco
y comentarios entre símbolos) — para un guardia eso es el lado seguro: revisa de
más, nunca de menos. Verificado contra datos reales: `readConfig` en
`dashboard.cjs` da rango 32→145 con este truco; su `}` real está en la 144.

**PROHIBIDO:** implementar esto contando llaves `{}`. Ese es exactamente el
problema difícil (strings, comentarios, template literals, regex literals) que
este diseño rodea a propósito.

---

## PASO 2 — Escribir `line_end` (arreglar la columna fantasma)

El INSERT actual (`ast-indexer.cjs:557-561`) es:

```sql
INSERT OR REPLACE INTO ast_symbols
  (file, language, symbol_name, kind, line_start, exported, signature, content_hash)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
```

Agregar `line_end` a la lista de columnas y su `?` a VALUES, y pasar
`sym.line_end || 0` en el `.run(...)`. La columna YA existe en el schema — no
hay migración.

### ⚠️ TRAMPA DEL CACHÉ (si te la saltas, los pasos 1-2 no tienen NINGÚN efecto)

`indexFile()` hace early-return `{cached:true}` cuando el `content_hash` del
archivo coincide con el guardado (`ast-indexer.cjs:538-541`). Los archivos que
no cambiaron **jamás recalculan** — o sea, después de implementar los pasos 1-2,
si corres `index` normal, casi todo queda cacheado con `line_end=0` igual que
antes. **Después de implementar, correr UNA VEZ:**

```bash
node .agentic/grafo/ast-indexer.cjs clear
node .agentic/grafo/ast-indexer.cjs index
```

**Verificación del paso:** este query debe dar ≈ el total de funciones (no 0):

```sql
SELECT COUNT(*) FROM ast_symbols WHERE kind='function' AND line_end > 0;
```

---

## PASO 3 — Helper de líneas cambiadas (en `git-context.cjs`, ADITIVO)

Nueva función exportada `getChangedLines(projectPath, file)`:

- Correr `git diff HEAD --unified=0 -- <file>` y parsear los headers de hunk
  `@@ -a[,b] +c[,d] @@`.
- **Regla de coordenadas — "compara números de la misma foto":** usar el lado
  NUEVO (`+c,d`). Razón: el índice (después del re-index por hash del Paso 4a)
  describe el archivo EN DISCO, que es exactamente el lado nuevo del diff.
  Mezclar coordenadas viejas con índice nuevo da contenciones falsas.
- `d` omitido = 1 línea. `d = 0` (hunk de borrado puro) → marcar la costura
  generosamente: líneas `[c, c+1]` (dirección segura: marcar de más).
- Devolver array ordenado de números de línea, o **`null`** si git falla, el
  archivo es untracked/nuevo, o el output no parsea. `null` = DUDA (el Paso 4
  lo trata como nivel archivo). Nunca lanzar excepción.

---

## PASO 4 — La pregunta de contención en `checkBeforeBuild` (el corazón)

Implementar como **función pura separada** para poder probarla sola:

```
lineContainmentVerdict(db, behavior, changedFiles, projectRoot)
  → { mode: 'HIT' | 'MISS' | 'DOUBT', detalle: {...} }
```

**Flujo por behavior relacionado:**

1. `flows = parseJ(behavior.critical_flows)`. Si está vacío → `DOUBT`
   (behaviors sin ancla siguen a nivel archivo, como hoy).
2. Para cada archivo del changeset que solape con `related_files`:
   - **a. Frescura:** calcular SHA-256 del contenido actual en disco y comparar
     con `ast_symbols.content_hash` de ese archivo. Si difiere → llamar
     `indexFile(db, fullPath, projectRoot)` (es barato e idempotente, re-indexa
     solo si cambió) y releer. Si sigue difiriendo o no hay filas → `DOUBT`.
   - **b. Localizar cada flow como símbolo — igualdad EXACTA, nada de LIKE:**
     ```sql
     SELECT line_start, line_end FROM ast_symbols
     WHERE file = ? AND kind = 'endpoint' AND symbol_name = ?
     ```
     Algún flow no encontrado, o con `line_end = 0` → `DOUBT`.
   - **c.** `changedLines = getChangedLines(...)`. Si es `null` → `DOUBT`.
     **Si es `[]` (diff vacío) → también `DOUBT`** — descubierto al implementar:
     en el Step 4 pre-build el cambio AÚN NO está aplicado, así que el diff está
     vacío; sin evidencia de líneas NO se degrada nada (si se tratara como MISS,
     el pre-check se saltaría siempre antes del build — exactamente el bug que
     el fail-closed existe para impedir).
   - **d.** `HIT` si ∃ línea cambiada dentro de `[line_start, line_end]` de
     ALGÚN flow. Si todas las líneas cambiadas quedan fuera de TODOS los flows
     (con evidencia completa de a-c) → `MISS`.

**Tabla de decisión (integrarla donde hoy se separan HIGH/MEDIA):**

| Veredicto | HIGH confidence | MEDIA confidence |
|---|---|---|
| `DOUBT` (cualquier duda) | **Exactamente como hoy**: correr tests, STOP si fallan | **Como hoy**: WARN |
| `HIT` | Como hoy (tests/STOP) **+ mensaje enriquecido**: qué flow exacto y sus líneas — "tocas `PUT /:negocioId` (líneas 45-60), protegido con N ciclos" | WARN **+ flow y líneas** |
| `MISS` (evidencia completa y fresca) | **Degradar**: no correr tests; emitir NOTICE informativo: "archivo compartido con [flows], pero tus líneas (X,Y) están fuera de las zonas protegidas" | Silencio o NOTICE |

El "poder" de la Opción B es exactamente ese `MISS` degradado: el guardia deja
de gritar por partes del archivo que no tocaste → cada alarma que SÍ suena
vuelve a significar algo (anti fatiga de alertas). El `HIT` enriquecido es la
"Opción A" que sale gratis.

---

## PASO 5 — Arreglar `extractFlows` (bug `router.*`) y garantizar el JOIN

En `regression-guard.cjs:85` el regex es `app\.<método>(` — cambiarlo por el
MISMO patrón del indexador para que los strings coincidan carácter por carácter:

```js
const endpointPattern = /\b(?:router|app)\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/g;
// flow generado: `${m[1].toUpperCase()} ${m[2]}`  → idéntico a ast-indexer.cjs:344-348
```

**Por qué importa tanto:** el Paso 4b busca por igualdad exacta. Si el formato
difiere en UN carácter (espacio, mayúscula), la contención jamás encuentra el
símbolo y todo cae a `DOUBT` — seguro, pero inútil: nunca habría precisión.
Ideal: exportar el regex desde `ast-indexer.cjs` y requerirlo en
`regression-guard.cjs` (una sola fuente de verdad).

---

## PASO 6 — Fase 2 (semilla): anclas de símbolos al registrar

1. **Migración tolerante** (patrón que el proyecto ya usa):
   ```js
   try { db.exec(`ALTER TABLE protected_behaviors ADD COLUMN protected_symbols TEXT DEFAULT '[]'`); } catch {}
   ```
2. En `registerBehavior()`: después del registro normal, para cada archivo
   cambiado consultar `ast_symbols` (índice fresco — correr `indexFile` antes),
   intersectar los rangos con `getChangedLines`, y guardar los símbolos tocados:
   ```json
   [{ "file": "src/routes/ia.ts", "symbol_name": "PUT /:negocioId", "kind": "endpoint" }]
   ```
3. **REGLA ANTI-PUDRICIÓN — NUNCA guardar números de línea dentro del behavior.**
   Las líneas se pudren con cada edición del archivo. El ancla estable es
   `(file, symbol_name, kind)`; las líneas se resuelven EN EL MOMENTO del check
   contra el índice fresco (Paso 4b ya lo hace así para flows — tratar
   `protected_symbols` idéntico, solo que el `kind` viene guardado).
4. Protecciones viejas sin anclas siguen a nivel archivo hasta que un nuevo
   ciclo las re-registre. Sin migración de datos, sin drama.

---

## PASO 7 — Verificación de punta a punta (ANTES de declarar PASS)

1. Reindex completo (Paso 2) y verificar `line_end > 0` en ≈ todas las funciones.
2. Crear un archivo de prueba `pruebas-guard/rutas.js` con un
   `router.get('/ping', handler)` arriba y una función `helperLejano()` 40
   líneas más abajo. Indexarlo.
3. Insertar un behavior sintético HIGH con
   `critical_flows = ["GET /ping"]`, `related_files = ["pruebas-guard/rutas.js"]`.
4. **Escenario MISS:** editar SOLO `helperLejano` → correr
   `node .agentic/grafo/regression-guard.cjs check pruebas-guard/rutas.js`
   → esperar NOTICE informativo, SIN correr tests.
5. **Escenario HIT:** editar la línea del endpoint o su handler → esperar el
   comportamiento de hoy + mensaje enriquecido con "GET /ping (líneas X-Y)".
6. **Escenario DOUBT:** borrar las filas de `ast_symbols` de ese archivo
   (`DELETE FROM ast_symbols WHERE file='pruebas-guard/rutas.js'`) SIN volver a
   indexar y con un flow que no exista → esperar comportamiento nivel archivo
   (como hoy). También probar con `critical_flows=[]`.
7. Borrar el behavior sintético y el archivo de prueba al terminar.
8. Correr los gates del propio proyecto: `node .agentic/grafo/tdd-gate.cjs run grafo`.

**Criterios de aceptación (checklist):**
- [ ] `line_end > 0` en ≈100% de funciones tras reindex forzado
- [ ] MISS degrada (no corre tests) SOLO con evidencia completa
- [ ] HIT mantiene el comportamiento actual + mensaje con flow y líneas
- [ ] Cualquier DUDA reproduce EXACTAMENTE el comportamiento actual
- [ ] `extractFlows` captura `router.*` y el formato coincide con el indexador
- [ ] Ningún consumidor de `ast_symbols` roto (correr `akdd health`, dashboard)
- [ ] Cero comparaciones LIKE/substring/regex sobre nombres en el código nuevo

---

## Qué NO hacer

- NO comparar nombres con LIKE/substring/regex en prosa (la clase de bug de los
  3 fallos del 2026-07-15).
- NO guardar números de línea dentro de `protected_behaviors` (se pudren).
- NO degradar a MISS sin evidencia positiva completa (hash fresco + todos los
  flows localizados + `line_end > 0` + diff parseado).
- NO contar llaves. Jamás. Si en algún momento parece necesario, la respuesta
  es el Plan 3 (tree-sitter por sombra), no un brace-counter artesanal.
- NO cambiar formatos de `symbol_name` ni kinds existentes (9 consumidores).
- NO olvidar el reindex forzado (trampa del caché) — síntoma de haberla
  olvidado: "implementé todo y line_end sigue en 0".

---

## Al terminar (obligatorio, CLAUDE.md)

```bash
node .agentic/grafo/post-cycle.cjs grafo --tests=[N] --task="Regression Guard precisión por líneas — fase 1 (line_end + contención + fail-closed)"
```
