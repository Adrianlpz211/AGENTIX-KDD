# Plan 5 — Los 6 potenciadores de la memoria (+ telemetría de gates y promoción por mérito)

> **✅ ESTADO: IMPLEMENTADO Y VERIFICADO (2026-07-15).** Ejecutado en C:\lumoV2
> — 19/19 escenarios propios (incluido el sabotaje de la libreta: el gate
> sobrevive con la tabla rota) + re-run Plan 1 (15/15) y Plan 2 (19/19) = cero
> regresión — y portado el mismo día a AGENTIX-KDD-main (paridad idéntica en
> los 7 archivos; la única delta es un comentario de cabecera que main tiene de
> más en ui-native-gate). El Step 2.5+ ya disparó EN VIVO en un post-cycle real
> y `gate-telemetry.cjs stats` imprime desde datos reales:
> "Eventos totales: 10 | Protecciones activadas (HIT/STOP/FAIL): 2".
>
> **Bug real cazado por la verificación (E4):** la primera versión de
> linkErrorFixes ASUMIÓ la firma de addCausalEdge (`desde`/`hacia`) sin leerla
> — la real es `desde_entidad`/`hacia_entidad`. El edge nunca se creaba y el
> fail-soft lo tragaba en silencio. Lección reincidente del día: jamás asumir
> firmas; el escenario de verificación existía justo para esto y lo cazó.

> **Para ejecutar con `aa: sprint` — mismo protocolo que los Planes 1-4:**
> implementar en C:\lumoV2 (sandbox), verificar con escenarios contra datos
> reales, re-correr las verificaciones de los Planes 1 y 2 (cero regresión), y
> portar a AGENTIX-KDD-main solo si todo queda verde. Documento autocontenido.
> Generado el 2026-07-15 con Fable 5, con el motor v3.13 recién leído y medido.

---

## Qué mata este plan (el mapeo pedido por el dueño)

Este plan NO son solo los 6 potenciadores — está diseñado para que, de paso,
resuelva 2 de las 6 debilidades detectadas y 1 de los 5 huecos hacia L5:

| Ítem | ¿Lo resuelve este plan? | Cómo |
|---|---|---|
| P1-P6 (potenciadores de memoria) | ✅ TODOS | Tareas 1-6 |
| Debilidad D3 (confianza escala lento: 3/48 HIGH) | ✅ | P1 + P6 + la regla de mérito (Tarea 7) |
| Debilidad D5 (veredictos de gates efímeros) | ✅ | P1 diseñado como telemetría GENERAL de gates, no solo "regresiones evitadas" |
| Hueco L5-1 (telemetría + auto-promoción WARN→STOP por evidencia) | ✅ los datos y la primera regla | Tarea 1 (tabla) + Tarea 7 (regla conservadora v1) |
| Debilidad D4 (post-cycle timeout con suites pesadas) | ✅ bonus de fontanería | Tarea 8 (pequeña, mismo territorio de cierre de ciclo) |
| Debilidades D1 (jerarquía docs), D2 (cobertura declarada), D6 (higiene Windows) | ❌ NO — fuera de alcance | D1 = tarea de README/batallas · D2 = medidor de cobertura propio (apalanca ts-enricher) · D6 = mini-auditoría aparte |
| Huecos L5-3 (recuperación autónoma), L5-4 (continuidad multi-día), L5-5 (batallas) | ❌ NO — construcciones/validaciones aparte | P2+P3 dejan el COMBUSTIBLE para L5-3 (el bucle es otro plan) |

## Principios NO NEGOCIABLES (heredados de los Planes 1-4)

1. **Números e igualdad exacta, no reconocimiento de texto en prosa** (la clase
   de bugs con 3 casos reales el 2026-07-15). Los enlaces error↔fix se hacen
   por INTERSECCIÓN DE LÍNEAS con anclas, jamás por parecido de títulos.
2. **Fail-closed / fail-soft:** cada pieza nueva degrada al comportamiento de
   hoy ante cualquier duda. La telemetría JAMÁS bloquea un gate (si el INSERT
   falla, el gate sigue); la promoción por mérito solo PROMUEVE en v1, nunca
   degrada.
3. **Anclas por nombre estable, nunca por número de línea** (las líneas se
   pudren; se resuelven frescas contra el índice en el momento de uso).
4. **Aditivo, nunca renombrar:** columnas nuevas con `try { ALTER } catch {}`
   (patrón del repo); kinds y formatos existentes intactos (9 consumidores de
   ast_symbols + los JOINs de los Planes 1-2).
5. **Trampa del caché:** cualquier cambio de extractor exige reindex forzado
   (`ast-indexer.cjs clear && index`). Este plan NO toca extractores, pero si
   una tarea lo hiciera, la regla aplica.

## Estado actual verificado (2026-07-15, contra el código v3.13)

- `protected_behaviors`: module, critical_flows, test_patterns, related_files,
  **protected_symbols** (anclas v3.13), pass_count, confidence (5+ → HIGH).
  En Lumo real: 48 activos, solo 3 HIGH.
- `invariant_violations` existe (regresiones DETECTADAS post-TDD) — pero los
  veredictos HIT/MISS/DOUBT de `lineContainmentVerdict` y los findings del
  browser-gate NO se persisten en ningún lado (D5).
- `nodos` (memoria KDD): tipo patron/error/decision, area, confianza,
  aplicado/util, y columna `archivos_aplica` (v3.12) — SIN anclas de símbolos.
- `relaciones_semanticas` con tipos causales declarados en ast-indexer.cjs:
  `caused_failure | was_fixed_by | tested_by | regressed_by` — el vocabulario
  existe, el uso es superficial.
- `context-enricher.cjs`: imprime riesgo estimado (BAJO/MEDIO/ALTO) pero el
  brief tiene el MISMO tamaño para cualquier riesgo (P5).
- `browser-gate.cjs` v2: deriveChecksForView lee behaviors pero NO devuelve el
  id del behavior (solo confidence) — P6 necesita ese id.
- `mem-curator.cjs` (akdd cure) y `creative-engine.cjs auto-confirm` existen —
  P4 se cuelga de ese territorio.
- `post-cycle.cjs`: paso "2. Registrando contratos" murió DOS veces hoy por
  ETIMEDOUT con el `npm test` completo de Lumo (D4) — spawnSync con timeout
  60s en tdd-gate/regression-guard.

---

# TAREA 1 — P1: Telemetría de gates (`gate_events`) — la pieza madre

**Dónde:** nueva sección en `regression-guard.cjs` (o módulo propio
`gate-telemetry.cjs` si supera ~120 líneas — preferible módulo propio, con
require fail-soft desde los gates).

**Schema (migración tolerante en ensureSchema):**

```sql
CREATE TABLE IF NOT EXISTS gate_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT DEFAULT (datetime('now')),
  gate        TEXT NOT NULL,       -- regression|tdd|browser|ui_native|spec|security
  verdict     TEXT NOT NULL,       -- HIT|MISS|DOUBT|STOP|WARN|PASS|FAIL
  behavior_id TEXT,                -- FK suave a protected_behaviors (nullable)
  file        TEXT,
  detalle     TEXT DEFAULT '{}',   -- JSON: {flow, lineas, why, check_type...}
  cycle_hint  TEXT                 -- área/tarea si se conoce (nullable)
);
CREATE INDEX IF NOT EXISTS idx_ge_gate ON gate_events(gate, verdict);
CREATE INDEX IF NOT EXISTS idx_ge_behavior ON gate_events(behavior_id);
```

**API:** `recordGateEvent(db, {gate, verdict, behavior_id, file, detalle, cycle_hint})`
— envuelto COMPLETO en try/catch: **si la telemetría falla, el gate sigue como
si nada** (principio 2). Exportar también `gateStats(db, {desde})` para
reportes.

**Puntos de escritura (v1 — solo lo mecánico):**
1. `checkBeforeBuild`: un evento por behavior evaluado con su veredicto de
   contención (HIT/MISS/DOUBT) + un evento STOP si hay violations.
2. `verifyAfterTDD`: evento FAIL por violación detectada (además de
   invariant_violations, que se mantiene igual).
3. `browser-gate.cjs`: un evento por check ejecutado (PASS o el tipo de
   finding) — solo si `.agentic/memoria.db` existe (fail-soft: el gate corre
   igual sin BD).
4. `ui-native-gate.cjs`: evento WARN por finding.
5. Los gates que ejecuta el LLM (Spec/Security, viven en CLAUDE.md): NO se
   auto-registran mecánicamente — v1 los deja fuera y lo documenta. (v2: CLI
   `gate-telemetry.cjs record ...` que el pipeline instruye llamar.)

**Qué responde esto:** D5 completa + los DATOS de L5-1 + la materia prima de
"regresiones evitadas" (eventos STOP/HIT = protección activada — el número
para vender: "Agentix te frenó N roturas este mes").

# TAREA 2 — P2: Memoria negativa anclada (errores con ancla de símbolo)

**Dónde:** `nodos` + `post-cycle.cjs` (escritura) + `context-enricher.cjs`
(lectura).

1. Migración: `try { ALTER TABLE nodos ADD COLUMN anclas TEXT DEFAULT '[]' } catch {}`
   — mismo formato que protected_symbols: `[{file, symbol_name, kind}]`.
   **Nombres estables, jamás líneas** (principio 3).
2. Escritura: cuando post-cycle (o el pipeline al registrar un error) conoce el
   changeset del fix → `computeTouchedSymbols(db, files, root)` (YA EXISTE,
   exportada por regression-guard v3.13) → guardar como anclas del nodo error.
3. Lectura (el pago): en context-enricher, para la tarea entrante con archivos
   detectados (git-context ya los da), resolver las anclas de los errores del
   área contra el índice FRESCO (mismo patrón del veredicto del Plan 1: lookup
   exacto por kind+symbol_name, líneas frescas) y si las líneas/archivos de la
   tarea intersectan → línea en el brief:
   `⚠️ Estás sobre la zona del error [título] (símbolo X, resuelto en ciclo Y)`.
4. DOUBT-friendly: ancla no localizable → simplemente no se menciona (es un
   brief informativo, no un gate).

# TAREA 3 — P3: Emparejamiento error→fix automático (por números, no texto)

**Dónde:** `causal-edges.cjs` + `post-cycle.cjs`.

1. Al cerrar un ciclo: tomar los símbolos tocados del ciclo
   (computeTouchedSymbols del changeset) y buscar nodos error ACTIVOS cuyo
   campo `anclas` intersecte esos MISMOS símbolos (igualdad exacta
   file+symbol_name+kind — cero fuzzy de títulos, principio 1).
2. Match → crear en `relaciones_semanticas` el edge
   `error --was_fixed_by--> ciclo` (el vocabulario causal YA está declarado) +
   marcar en el nodo error `estado: RESUELTO?` — NO: v1 solo crea el edge y
   sube `aplicado`+1 del nodo; cambiar estado es decisión del curator/humano.
3. CLI manual de respaldo: `node .agentic/grafo/causal-edges.cjs fix-link <error_id> <ciclo_id>`
   para cuando el dev quiera enlazar a mano.
4. Consumo: el enricher, al mencionar un error (P2), sigue el edge y agrega
   `(fix: ciclo Y — [tarea])`. El agente llega con el error Y su cura.

**Nota de diseño:** P2 es prerequisito de P3 (los anclas son el idioma común).
Un error viejo sin anclas simplemente nunca auto-enlaza — sin drama.

# TAREA 4 — P4: Re-validación de anclas (curación anti-pudrición)

**Dónde:** función `revalidateAnchors(db, projectRoot)` en regression-guard (o
el módulo de telemetría), llamada desde `mem-curator` (akdd cure) y desde
post-cycle (barata: solo lookups).

1. Para cada behavior activo: por cada ancla de `protected_symbols`, resolver
   (kind, symbol_name) en el índice dentro de sus related_files.
   - Localizada → nada.
   - NO localizada → marcarla `{..., stale_since: fecha}` (la primera vez).
   - `stale_since` > 30 días → moverla a un campo `anclas_obsoletas` (nueva
     columna tolerante) y dejar rastro en gate_events (gate:'curator',
     verdict:'WARN').
2. Mismo tratamiento para `nodos.anclas` (P2).
3. **Regla conservadora:** JAMÁS borrar el behavior ni bajar su confianza por
   anclas obsoletas — el efecto natural ya es correcto (sin anclas → nivel
   archivo → comportamiento de siempre). Esto solo LIMPIA y AVISA:
   `akdd cure report` lista "N anclas obsoletas — un ciclo verde las renueva".

# TAREA 5 — P5: Brief con presupuesto por riesgo

**Dónde:** `context-enricher.cjs` (ya calcula riesgo BAJO/MEDIO/ALTO).

| Riesgo | Presupuesto del brief |
|---|---|
| BAJO | top-3 nodos relevantes, sin episodios, sin contratos (lo de hoy recortado) |
| MEDIO | lo de hoy + zonas de error ancladas (P2) si intersectan |
| ALTO | todo lo anterior + contratos del módulo + último episodio del área + edges was_fixed_by (P3) |

Implementación: los queries existentes reciben LIMIT parametrizado por riesgo;
las secciones nuevas (P2/P3) solo entran en MEDIO/ALTO. Nunca bloquea (el
enricher ya es "plus, no gate" por diseño — se mantiene).

# TAREA 6 — P6: Confianza acelerada por verificación real

**Dónde:** `browser-gate.cjs` + el módulo de telemetría.

1. `deriveChecksForView` devuelve también `behavior_id` en cada check (hoy solo
   trae confidence — agregar el id al SELECT y al objeto).
2. Al terminar el gate: por cada behavior cuyos checks pasaron TODOS → evento
   `{gate:'browser', verdict:'PASS', behavior_id}`.
3. La regla de mérito (Tarea 7) cuenta esos PASS como evidencia.

# TAREA 7 — La regla de promoción por mérito (v1, conservadora)

**Dónde:** `applyMeritPromotion(db)` en el módulo de telemetría, llamada desde
post-cycle (después de registerBehavior).

```
Para cada behavior MEDIA activo:
  hits    = gate_events(gate='regression', verdict IN ('HIT','STOP'), behavior_id)
  passes  = gate_events(gate='browser', verdict='PASS', behavior_id)
  Si (hits >= 1 AND pass_count >= 3) OR (passes >= 2 AND pass_count >= 3):
      → confidence = 'HIGH' (promoción anticipada por mérito)
      → gate_events(gate='curator', verdict='PROMOTED', detalle con la evidencia)
```

- **Solo promueve, jamás degrada** (v1). La degradación por falsas alarmas es
  v2, cuando haya datos de meses.
- El umbral pass_count>=3 evita promover behaviors bebés por un golpe de
  suerte.
- Esto ataca D3 de frente: la confianza se gana por PROTEGER DE VERDAD o por
  VERIFICARSE EN NAVEGADOR, no solo por repetición de calendario.

# TAREA 8 — Bonus de fontanería: el timeout del post-cycle (D4)

**Dónde:** `runTestFile` en regression-guard.cjs (timeout 60000 hardcoded) y el
paso de contratos de post-cycle/tdd-gate.

1. Timeout configurable: `parseInt(process.env.AKDD_TEST_TIMEOUT_MS, 10) || 60000`
   (mismo patrón que AKDD_DASH_PORT).
2. En post-cycle, si el paso de contratos da ETIMEDOUT: reintentar UNA vez con
   `--testPathPattern` scoped al área del ciclo (suite parcial en vez de
   completa) antes de rendirse con el WARN de siempre. Documentar en el WARN:
   `contratos: timeout con suite completa — corre a mano: node .agentic/grafo/tdd-gate.cjs run [área]`.

---

## Verificación (Tarea 9 — antes de declarar nada)

Escenarios mínimos (mismo estilo verify-planN.cjs, fixtures sintéticas que se
limpian, sobre lumoV2):

1. **P1:** correr checkBeforeBuild con un behavior sintético (HIT y MISS como
   en verify-plan1) → gate_events contiene los veredictos con behavior_id;
   romper la BD a propósito (renombrar tabla) → el gate SIGUE funcionando
   (fail-soft probado).
2. **P2:** nodo error sintético con anclas → editar dentro del rango del
   símbolo → el brief del enricher menciona la zona; ancla inexistente → el
   brief no explota ni la menciona.
3. **P3:** ciclo sintético que toca los mismos símbolos del error → edge
   was_fixed_by creado; error sin anclas → cero enlaces (sin fuzzy).
4. **P4:** ancla apuntando a símbolo borrado → primera pasada marca
   stale_since; con fecha >30 días simulada → pasa a obsoletas + evento.
5. **P5:** misma tarea con riesgo BAJO vs ALTO → brief corto vs brief con
   secciones extra (medir líneas del output).
6. **P6+P7:** behavior MEDIA con pass_count=3 + 2 eventos browser PASS →
   promovido a HIGH con evento PROMOTED; con pass_count=1 → NO promovido.
7. **P8:** AKDD_TEST_TIMEOUT_MS=1 → timeout controlado + reintento scoped.
8. **Regresión:** re-correr verify-plan1.cjs (15/15) y verify-plan2.cjs (19/19).
9. Limpieza total (fixtures + eventos sintéticos + behaviors de prueba).

## Qué NO hacer

- NO enlazar errores con fixes por parecido de texto/título — SOLO por
  intersección de anclas (números).
- NO dejar que un fallo de telemetría tumbe un gate (try/catch total).
- NO degradar confianza en v1 — solo promover.
- NO borrar behaviors/nodos desde el curator de anclas — solo marcar y avisar.
- NO guardar números de línea en anclas ni eventos como fuente de verdad.
- NO tocar el schema existente destructivamente — solo ALTER tolerantes.

## Al terminar cada bloque (obligatorio, CLAUDE.md)

```bash
node .agentic/grafo/post-cycle.cjs grafo --tests=[N] --task="Plan 5: potenciadores de memoria [tarea]"
```

## Orden recomendado del sprint

T1 (telemetría, la madre) → T6+T7 (mérito, paga inmediato con T1) → T2 → T3
(necesita T2) → T4 → T5 → T8 (bonus) → T9 (verificación) → porte a main.
