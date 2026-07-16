# Plan 6 — Los pendientes construibles (cobertura, higiene, continuidad, recuperación, batalla)

> **✅ ESTADO: EJECUTADO Y VERIFICADO (2026-07-16).** 13/13 escenarios propios
> + regresión total (Plan 1: 15/15 · Plan 2: 19/19 · Plan 5: 19/19) y portado
> a main con paridad idéntica. Resultados clave:
> - **C2 Higiene:** la auditoría encontró CERO ofensores vivos (la disciplina
>   de los Planes 1-5 ya normalizaba en cada sitio) — se envía `path-norm.cjs`
>   como helper canónico + fixture de tortura (CRLF + espacios en ruta) verde.
> - **C1 Cobertura:** lumoV2 real = 79% de archivos con símbolos, 93% de
>   líneas cubiertas, **59 puntos ciegos DECLARADOS** con causa (insight real:
>   los tests con describe() y el CSS de solo-variables son ciegos legítimos).
> - **C3 Continuidad:** sprint-state con relevo automático de tarea, probado
>   simulando chat-nuevo leyendo la BD fría.
> - **C4 Recovery:** verdicts RECOVERED/RECOVERY_FAILED + recoveryStats (tasa)
>   + protocolo con límites duros en CLAUDE.md.
> - **C5 LA BATALLA — CONFIRMADA:** 2 sub-agentes en UN mensaje, ejecución
>   solapada real (79s/87s), archivos disjuntos verificados (9+10 líneas, cero
>   cruce), convenciones del proyecto respetadas por ambos sin coordinarse.
>   HALLAZGO: el Parallel Guard busca transcripts en el proyecto target y da
>   SIN_EVIDENCIA para sesiones orquestadas desde otro cwd — limitación real
>   documentada.

> **Para ejecutar con `aa: sprint plan 6` DESPUÉS del Plan 5** (el componente 4
> consume el combustible que el Plan 5 deja: errores anclados + pares
> error→fix + telemetría de gates). Mismo protocolo probado: implementar en
> C:\lumoV2 → verificar con escenarios → re-correr verifies de Planes 1, 2 y 5
> (cero regresión) → portar a main. Documento autocontenido. Generado el
> 2026-07-15 con Fable 5.
>
> **Qué NO está aquí (a propósito):** la alineación del README (el dueño la
> dejó para el FINAL, antes del push — ver fila 7 de pendientes-post-plan5.md)
> y la maduración por tiempo de uso real (nadie construye calendario).

## Los 5 componentes y qué pendiente mata cada uno

| Componente | Mata | Tipo |
|---|---|---|
| C1 — Medidor de cobertura | Debilidad D2 + hueco L5-2 ("no sabe cuánto no ve") | Código ✅ |
| C2 — Higiene Windows | Debilidad D6 (clase de bugs rutas/CRLF) | Código ✅ |
| C3 — Continuidad multi-día | Hueco L5-4 (sprints que se reanudan solos) | Código+protocolo ✅ |
| C4 — Bucle de recuperación (la maquinaria) | Hueco L5-3 | Protocolo+telemetría 🔶 (la calidad del arreglo la pone el modelo; el diseño escala al humano) |
| C5 — Batalla Front/Back paralelo | Hueco L5-5 (la parte ejecutable) + media D1 | EJECUCIÓN ⚔️ (no es código: es correr una tarea real que lo pruebe) |

## Principios NO NEGOCIABLES (los de siempre — Planes 1-5)

1. Números e igualdad exacta, jamás reconocimiento de texto en prosa.
2. Fail-closed/fail-soft: toda pieza degrada al comportamiento actual ante duda.
3. Anclas por nombre estable, nunca líneas persistidas.
4. Aditivo: ALTER tolerantes, cero renombres de kinds/formatos (9 consumidores).
5. Reindex forzado tras tocar extractores (trampa del caché).
6. En archivos CRITICAL del deny-list, el bucle de recuperación JAMÁS auto-aplica — siempre escala.

---

# C1 — Medidor de cobertura (`coverage-meter.cjs`)

**Qué responde:** "¿cuánto de este proyecto VE Agentix, y dónde están sus
puntos ciegos?" — hoy el sistema calla su ~11% invisible (medido en lumoV2).

**Dónde:** módulo nuevo `.agentic/grafo/coverage-meter.cjs` + comando
`akdd cobertura` (mapear en CLAUDE.md akdd→herramienta, y CLI en bin si aplica).

**Cómo mide (dos modos, fail-soft):**

1. **Modo heurístico (siempre disponible, sin dependencias):**
   - Por archivo de código indexable: ¿tiene 0 símbolos pero >30 líneas no
     vacías? → "archivo ciego" (sospechoso).
   - % de líneas del archivo cubiertas por rangos de símbolos
     (line_start..line_end ya existen desde el Plan 1) — bajo % = zona ciega.
   - Detección de causas conocidas: archivo template-pesado (>40% del contenido
     entre backticks — reusar blankTemplateLiterals comparando longitudes),
     const con anotaciones raras, etc.
2. **Modo exacto (si web-tree-sitter está instalado — feature-detect):**
   - Reusar la comparación del Plan 3 (`ts-enricher.compare`) y reportar el %
     de emparejamiento real por lenguaje.

**Salida:**
```
📊 Cobertura del índice — [proyecto]
  Archivos de código: 314 · con símbolos: 298 (95%)
  Símbolos visibles: ~89% (modo exacto) | archivos ciegos: 4
  Puntos ciegos principales:
    - src/x.ts (0 símbolos, 120 líneas — template-pesado)
  → Lo invisible NO desprotege: ancla ausente = portón cerrado (DOUBT).
```
Reporte a `_output/cobertura-[fecha].md` + stat opcional en el dashboard
(carta Aprendizaje Estructural — 1 número: "cobertura ~89%").

**Verificación:** correr contra lumoV2 → el número debe ser coherente con lo
medido en el Plan 3 (~88-91%); fixture con archivo ciego sintético → aparece
listado; sin tree-sitter instalado → modo heurístico sin error.

# C2 — Higiene Windows (rutas `\` y CRLF, de una vez)

**Qué responde:** la clase de bugs que cazamos DOS veces en vivo el 2026-07-15
(file-keys con backslash en BD; autocrlf declarando archivos enteros
cambiados).

**Tareas:**

1. **Auditoría mecánica del motor** (los ~50 .cjs de .agentic/grafo/): grep
   sistemático de patrones de riesgo — concatenación manual de rutas con '/',
   comparaciones de rutas sin normalizar, `split('\n')` que asume LF para
   RE-ESCRIBIR contenido (leer está bien; escribir sin preservar EOL no),
   execSync con rutas sin comillas.
2. **Helper compartido `path-norm.cjs`:** `norm(p)` (a `/`), `dualKeys(p)`
   (ambas formas para lookups de BD — el patrón que el Plan 1 ya usa inline,
   centralizado), `eolOf(content)` (para escrituras que preservan EOL).
3. **Refactor SOLO de los ofensores encontrados** en la auditoría (no refactor
   masivo — cada cambio con su verificación).
4. **Fixtures de tortura:** proyecto sintético con espacios en rutas, archivo
   CRLF, archivo LF, archivo mixto → indexar + contención + getChangedLines
   deben comportarse (el EOL mixto ya se sabe: git declara todo cambiado →
   HIT conservador — documentado como comportamiento correcto, no bug).

**Verificación:** los fixtures de tortura en verde + re-run verifies 1/2/5.

# C3 — Continuidad multi-día (sprints que se reanudan solos)

**Qué responde:** hoy un sprint vive en el PLAN.md y en la memoria del chat;
si el chat muere a mitad de sprint, la reanudación es manual y artesanal.

**La mitad ya existe:** PLAN.md con estados por tarea (los 5 sprints de hoy lo
usaron), checkpoints cada 5 ciclos, recuperación de sesión en CLAUDE.md.

**Lo que se construye:**

1. **Estado de sprint como dato:** al iniciar/avanzar sprint, espejo del
   estado en `project_settings` key `active_sprint` (JSON: {objetivo, tareas:
   [{n, titulo, estado}], tarea_activa, iniciado, actualizado}) — escrito por
   una función `sprintState(db, ...)` en un módulo chico `sprint-state.cjs`
   con CLI `status|update|clear`. El PLAN.md sigue siendo la verdad legible;
   el JSON es la verdad parseable.
2. **Protocolo `aa: continúa sprint`** (nueva sección en 09-sprint.md +
   CLAUDE.md): leer active_sprint + PLAN.md + último checkpoint → anunciar
   "retomando sprint [X] en tarea [N]" → seguir el protocolo normal desde ahí.
3. **Checkpoint por tarea** (no solo cada 5 ciclos): al completar cada tarea
   de sprint, `akdd checkpoint` automático (instrucción en 09-sprint.md — es
   una línea del protocolo, el comando ya existe).

**Verificación:** iniciar sprint sintético de 3 tareas → completar 1 →
simular "chat nuevo" (leer solo BD+PLAN.md) → `aa: continúa sprint` debe
reconstruir el contexto y declarar tarea 2 activa. El JSON y el PLAN.md nunca
se contradicen (el test los compara).

# C4 — Bucle de recuperación autónoma (LA MAQUINARIA, con su asterisco honesto)

**Qué responde:** hoy un STOP de gate espera al humano aunque el arreglo sea
obvio. **El asterisco:** el framework orquesta y verifica; la CALIDAD del
arreglo la pone el modelo — por eso todo escala al humano ante la duda.

**Lo que se construye:**

1. **Protocolo RECOVERY** (nueva sección en CLAUDE.md + agente 05-qa.md/01-orquestador):
   ```
   Gate STOP →
   1. Registrar gate_event (ya existe desde Plan 5)
   2. Consultar memoria: ¿error anclado en esta zona? ¿par error→fix conocido?
      (potenciadores P2/P3 — el combustible)
   3. Proponer arreglo AL DIFF MÍNIMO (nunca refactor oportunista)
   4. ¿El archivo está en CRITICAL del deny-list? → NO aplicar: escalar ya
   5. Aplicar → re-correr EL MISMO gate que frenó
   6. Verde → seguir pipeline + gate_event verdict RECOVERED
      Rojo → segundo intento SOLO si la memoria dio un par error→fix distinto
      Rojo x2 → escalar al humano con la traza completa (qué probó, por qué)
   ```
2. **Soporte mecánico en gate-telemetry** (extiende el del Plan 5): verdicts
   nuevos `RECOVERED | RECOVERY_FAILED` + `recoveryStats(db)` para el reporte
   de efectividad ("N recuperaciones autónomas este mes, M escaladas").
3. **Límites duros:** máx 2 intentos; jamás en CRITICAL; jamás si el STOP fue
   del Spec Gate por valores de negocio (esos SIEMPRE son decisión humana —
   regla explícita).

**Verificación:** romper un test a propósito en fixture → STOP → el protocolo
propone/aplica/reverifica → RECOVERED registrado; romper algo en archivo
CRITICAL → escala sin tocar; romper sin par en memoria → máximo 2 intentos y
escala con traza.

# C5 — Batalla: Front/Back paralelo confirmado (ejecución, no código)

**Qué responde:** el único "should work" ejecutable por la IA hoy — que el
MODO LEGIÓN Fase 2 dispare DE VERDAD dos sub-agentes en paralelo con una tarea
real que separe front de back.

**El diseño de la batalla (en lumoV2):**

1. **Tarea real que fuerza la separación** (ejemplo concreto: "agregar un
   contador de mensajes no leídos: endpoint GET /negocio/:id/no-leidos en el
   back + badge en el panel front" — archivos disjuntos por construcción:
   `src/api/routes/*.ts` vs `public/panel/js/*.js`).
2. **Condición verificada ANTES:** listar los archivos que cada lado tocará y
   confirmar intersección vacía (la regla del MODO LEGIÓN).
3. **Evidencia a capturar:** (a) las DOS invocaciones de sub-agente en el
   MISMO mensaje (el mecanismo de audit:), (b) resultados de ambos, (c)
   verificación de que ningún archivo fue tocado por los dos (git diff por
   lado), (d) TDD + contención del Plan 1 después.
4. **Resultado:** actualizar README/estado: Front/Back paralelo pasa de
   "debería funcionar" a "confirmado en batalla el [fecha]" — o, si falla,
   documentar POR QUÉ con la traza (también es oro).

## Verificación global del Plan 6 (antes de declarar nada)

- Escenarios por componente (arriba) todos en verde.
- Re-run completo: verify-plan1 (15/15) + verify-plan2 (19/19) + verify-plan5.
- `akdd health` sin errores nuevos; dashboard bootea.
- Porte a main con paridad idéntica; sin commit/push/publish salvo orden.

## Qué NO hacer

- NO refactor masivo de rutas "porque sí" — solo ofensores auditados (C2).
- NO auto-aplicar arreglos en CRITICAL ni en veredictos del Spec Gate (C4).
- NO declarar la batalla ganada sin las 4 evidencias (C5).
- NO duplicar verdad de sprint: PLAN.md legible + JSON parseable, un solo
  escritor por ciclo (C3).
- Los de siempre: nada de texto-fuzzy, nada de líneas persistidas, nada que
  no degrade a hoy.

## Orden del sprint

C2 (higiene primero: limpia el terreno donde todo lo demás pisa) → C1
(cobertura) → C3 (continuidad) → C4 (recuperación, ya con Plan 5 vivo) → C5
(la batalla, al final, con todo el arsenal puesto) → verificación global →
porte.
