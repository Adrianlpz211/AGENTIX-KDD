# AGENTIX KDD — Dossier técnico completo (v3.13/v3.14, 2026-07-16)

> **Propósito de este documento:** descripción exhaustiva y honesta de qué ES
> Agentix hoy, qué TIENE, qué HACE y qué PROMETE de verdad — escrita para ser
> entregada a un tercero que hará su propio análisis profundo, sin acceso a las
> conversaciones donde se construyó. Todos los números citados fueron MEDIDOS
> el 2026-07-15/16 contra un proyecto SaaS real (Lumo, ~414 archivos, TS+JS).
> Autor: la IA que implementó y verificó las versiones 3.13-3.14 (6 planes,
> ~85 escenarios de verificación, 6 bugs reales encontrados y corregidos en el
> proceso). Sesgo declarado: quien escribe construyó parte de lo descrito; el
> documento compensa con números, límites explícitos y niveles de madurez.

---

## 1. IDENTIDAD — qué es en una frase

**Agentix KDD es una capa de infraestructura local que convierte el
conocimiento acumulado de un repositorio en fuerza activa de prevención: hace
que la IA de código recuerde el proyecto, no rompa lo que ya funcionaba, y
deje rastro verificable de cada decisión.**

- NO es una IA que programa: es la armadura de la IA que ya usas (Claude
  Code / Cursor, vía CLAUDE.md + MCP + hooks de git).
- NO es solo memoria: la memoria aquí BLOQUEA (gates), VERIFICA (tests +
  navegador real) y APRENDE (telemetría + promoción por mérito).
- Vive dentro del proyecto: SQLite local (`.agentic/memoria.db`), sin nube,
  sin cuenta, sin suscripción. Paquete npm: `agentic-kdd`.

**La propiedad medida que lo define (el corazón del pitch honesto):**
> **La armadura falla CERRADA.** Cuando Agentix duda, protege; cuando se
> equivoca, se equivoca hacia el lado seguro. Medido contra un parser real:
> de 1,989 símbolos comparados, el error de rango cae del lado seguro en
> 1,894 casos y del lado peligroso en 5 (0.25%, todos ≤5 líneas).

## 2. EL PROBLEMA QUE RESUELVE

El flujo real de desarrollar con IA: le explicas el proyecto otra vez, empieza
de cero otra vez, rompe algo que funcionaba otra vez, cambia una regla de
negocio sin saber por qué estaba así. Los dos casos cliente que motivaron la
generación actual: (a) un combobox aplicado "en todos lados" rompió selects
que YA funcionaban; (b) trabajo de CSS rompió validaciones `required`
existentes. Ambos son la misma enfermedad: **la IA no ve lo que ya está
probado, y nadie mecánico se lo impide.**

## 3. ARQUITECTURA — las tres piezas y sus órganos

### ⚓ ANCLA — Memoria (4 capas, arquitectura CoALA, SQLite local)
| Capa | Tabla(s) | Contenido |
|---|---|---|
| Working | working_memory | contexto de la tarea en curso |
| Procedural | nodos (patron/error/decision) | reglas del proyecto con confianza BAJA→MEDIA→ALTA, contadores aplicado/útil, y desde v3.13 **anclas de símbolo** (`anclas`) |
| Episódica | episodios | trayectorias completas de ciclos (sin resumir — evita summarization drift); alimenta el motor de predicción |
| Semántica | entidades, relaciones_semanticas (bi-temporal: valid_at/invalid_at), ast_symbols, ast_edges | el grafo del código y del conocimiento, con edges causales (`caused_failure`, `was_fixed_by`…) |

Búsqueda: híbrida BM25 + vectorial (embeddings locales) con RRF. Curación
autónoma (MemCurator: TTL episódico, dedup, conflictos, límites) + validador
de conocimiento (obsolescencia, sospecha de poisoning).

### 🔧 PALANCA — Verificación (los gates)
| Gate | Qué hace | Severidad | Madurez |
|---|---|---|---|
| **Regression Guard** | ANTES del build: ¿el cambio toca algo que ya probamos que funciona? Desde v3.13 con **precisión de LÍNEAS**: HIT (tocas la zona exacta → comportamiento pleno + zona en el mensaje), MISS (mismo archivo, zona no tocada → degrada la falsa alarma), DOUBT (cualquier duda → comportamiento clásico por archivo completo). Frescura verificada por SHA-256 contra el índice; re-indexa solo si cambió | STOP (HIGH) / WARN (MEDIA) | Batalla |
| **TDD Gate** | corre la suite real; acumula contratos por módulo; jamás declara verde en falso | STOP | Batalla |
| **Spec Gate** | frena cambios que contradicen reglas de negocio guardadas (valores como trial_days) — SIEMPRE decisión humana | STOP | Batalla |
| **Security Gate** | archivos CRITICAL/SENSITIVE (auth, tenant, JWT) + escaneo de secretos/PII/prompt-injection en todo changeset | STOP/WARN | Batalla |
| **UI Native Gate** | confirm/alert/prompt nativos vs wrappers del proyecto — chequeo mecánico | WARN | Batalla |
| **Browser Gate** (v3.13) | abre la app en el Chrome/Edge YA instalado (playwright-core, cero descargas) y verifica POR COMPORTAMIENTO derivado de la memoria: element-exists, required-attr, select-usable — los dos bugs cliente, mecanizados | WARN (STOP se gana con uso) | Verificado |
| **Parallel Guard** | verifica evidencia de despacho paralelo real (no confía en la palabra del modelo) | Informe | Verificado, con limitación conocida (ver §9) |

### 🔨 MARTILLO — Autonomía con correa
- Pipeline `aa:` (Context Enricher → Orquestador → Analista → Front/Back →
  TDD → QA 4-lentes → Memoria) — sin pausas entre fases, STOP solo genuino.
- MODO LEGIÓN: sub-agentes en paralelo SOLO en pasos de lectura/juicio
  (análisis, QA, audit) y en Front+Back cuando los archivos NO se cruzan —
  **confirmado en batalla real el 2026-07-16**: dos sub-agentes despachados en
  un mismo mensaje, ejecución solapada (79s/87s), cada uno tocó SOLO su
  archivo, ambos respetaron las convenciones del proyecto sin coordinarse.
- Creative Engine: sugiere mejoras con niveles de autonomía escalonados.
- Protocolo RECOVERY (v3.14): ante un STOP mecánico, propone arreglo al diff
  mínimo consultando la memoria (error anclado + cura conocida), re-corre el
  MISMO gate, máximo 2 intentos, y escala con traza completa. Límites duros:
  jamás auto-aplica en archivos CRITICAL ni en veredictos del Spec Gate.
- Departamento QA (`audit:`): 7 sub-agentes en paralelo, solo lee, no toca código.

## 4. LO NUEVO DE v3.13/v3.14 (los 6 planes, todo verificado)

1. **Precisión por líneas** (Plan 1): `line_end` calculado por
   frontera-de-siguiente-símbolo (sin brace-matching — decisión medida),
   contención HIT/MISS/DOUBT fail-closed, anclas de símbolos acumulándose por
   ciclo (nombres estables, jamás líneas persistidas).
2. **Portabilidad** (Plan 4): perfil por proyecto autodetectado (front_dirs,
   frameworks, wrappers de API) + catálogo de endpoints de 10 frameworks
   (Express/Fastify/NestJS/Flask/FastAPI/Django/Rails/Laravel/gin/Spring) +
   endpoint≈ v2 que lee del índice. El caso "Express JS plano + fetch" pasó
   de 0 conexiones a conectar.
3. **Ojos UI** (Plan 2): forms/selects/campos con `required` (detección
   exacta) y clases CSS como nodos del grafo; edges CSS→vista (blast radius de
   estilos); flujos UI protegidos por el Regression Guard; Browser Gate por
   comportamiento. Números reales del proyecto de prueba: 27 forms, 25
   selects, 105 campos, 1,194 clases CSS, 1,101 conexiones CSS→vista.
4. **Medición tree-sitter** (Plan 3): se construyó el comparador
   (ts-enricher), se midió, y el veredicto CON EVIDENCIA fue diferir la
   adopción: la aproximación regex es suficiente (99.75% de errores en
   dirección segura) y la medición además destapó y pagó 3 bugs reales del
   extractor (símbolos fantasma por template literals, backtick dentro de
   regex literal, const con anotación de tipo TS).
5. **Potenciadores de memoria** (Plan 5): telemetría de gates (`gate_events` —
   la libreta donde por fin quedan los veredictos), errores anclados a
   símbolos, emparejamiento error→cura por INTERSECCIÓN de anclas (cero
   matching de texto), curación anti-pudrición de anclas, brief del enricher
   dimensionado por riesgo, y **promoción de confianza POR MÉRITO**: un
   behavior MEDIA con 3 ciclos + 1 protección real activada o 2 verificaciones
   en navegador → HIGH anticipado (solo promueve, jamás degrada en v1).
6. **Construibles finales** (Plan 6): medidor de cobertura (declara los puntos
   ciegos), higiene Windows (auditoría: cero ofensores vivos + helper
   canónico), continuidad multi-día (`aa: continúa sprint` con espejo
   parseable del estado), maquinaria del bucle RECOVERY, y la batalla
   Front/Back confirmada.

## 5. NÚMEROS MEDIDOS (no estimados — medidos)

| Métrica | Valor | Fuente |
|---|---|---|
| Dirección del error de rangos (vs parser real, 1,989 símbolos) | 99.75% lado seguro (falta: 5 casos, ≤5 líneas) | ts-enricher compare |
| Grafo del proyecto de prueba | 325 archivos, 3,761 símbolos, ~4,900 edges — 100% con line_end | ast stats |
| Cobertura declarada | 79% de archivos con símbolos · 93% de líneas cubiertas (muestra JS/TS) · 59 puntos ciegos DECLARADOS con causa | coverage-meter |
| Escenarios de verificación de v3.13/14 | ~85, todos en verde, re-corridos tras cada plan (regresión cero) | verify-plan1/2/5/6 |
| Bugs reales encontrados POR la propia verificación durante la construcción | 6 (3 del extractor + firma asumida + EOL/autocrlf + phantom-símbolos) | sesión 2026-07-15/16 |
| Benchmark previo (19 fases, SaaS multi-tenant, con/sin Agentix) | errores por fase 2.6→~0 · tests al primer intento 79%→100% · cascada de refactor 4/7→11/11 | benchmark/ (N=1, direccional, así etiquetado) |
| Telemetría viva | gate_events registrando: HIT/MISS/DOUBT/STOP/PASS/FAIL/PROMOTED/RECOVERED | gate-telemetry stats |

## 6. NIVELES DE MADUREZ (la jerarquía que faltaba — asignación exacta)

**PROBADO EN BATALLA** (uso real repetido): pipeline aa:, memoria 4 capas +
búsqueda híbrida, gates clásicos (Spec/TDD/Security/Regression clásico),
registro automático por commit, checkpoints, locks multi-instancia, dashboard,
MCP (54 herramientas), contención por líneas (verificada contra endpoints y
forms reales), Front/Back paralelo (confirmado 2026-07-16).

**VERIFICADO CON FIXTURES/NAVEGADOR** (escenarios controlados, aún sin meses
de producción): Browser Gate por comportamiento, catálogo multi-framework (8
de los 10 verificados con fixtures; Express/TS en batalla), Ojos UI, telemetría
+ promoción por mérito, error→cura por anclas, coverage-meter, sprint-state,
protocolo RECOVERY (maquinaria).

**IMPLEMENTADO SIN CONFIRMACIÓN REAL**: colaboración de equipo (beta privada
cerrada), escalada del Browser Gate a STOP (se gana con semanas de uso),
calidad de los arreglos del bucle RECOVERY (depende del modelo; la maquinaria
escala al humano).

## 7. AUTONOMÍA — dónde cae en la escala L1-L5

**L4 sólido.** Opera ciclos multi-paso con memoria, verificación, telemetría y
recuperación acotada, con humano en el loop de intención. Lo que lo separa de
L5 no es potencia sino AUTO-CONOCIMIENTO, y v3.14 empezó a cerrarlo: ya se
mide (telemetría), ya declara sus puntos ciegos (coverage-meter), ya se
promueve por mérito. Falta: auto-ajuste de umbrales con meses de datos,
recuperación autónoma probada en volumen, y continuidad de objetivo
completamente autónoma. Importante conceptualmente: **el framework no ES el
agente — crea las condiciones para que el modelo actúe de forma agéntica**
(memoria, gobernanza, continuidad). Sin modelo no hay agente; sin Agentix el
modelo es amnésico y sin frenos.

## 8. QUÉ TIENE QUE OTROS NO (la combinación, no las piezas)

Cada capa existe por separado en el mercado (memoria: Mem0/Zep/Letta;
spec-driven: Kiro; repo-map: Aider; guardrails: CI custom). Lo que no existe
junto en ninguna otra herramienta conocida por el autor:
memoria local que BLOQUEA con precisión de líneas + materia UI como
conocimiento de primera clase + verificación en navegador derivada de la
memoria + telemetría de sus propios veredictos + medición de sus propias
aproximaciones + disciplina fail-closed medida — todo dentro del editor que ya
usas y sin nube.

## 9. LÍMITES HONESTOS (lo que NO es y lo que NO ve)

1. **No es invulnerable:** la armadura reduce y direcciona el error; no lo
   elimina. La calidad de los arreglos autónomos la pone el modelo de turno.
2. **Techo de cobertura declarado:** ~21% de archivos del proyecto de prueba
   sin símbolos (tests con describe(), CSS de solo-variables, archivos
   template-pesados). Lo invisible NO desprotege (DUDA = portón cerrado), pero
   tampoco recibe precisión fina. El medidor lo declara por proyecto.
3. **Extractores regex, no parser:** decisión deliberada y medida (§5). Casos
   límite existirán; el diseño hace que caigan en DUDA, no en silencio.
4. **Parallel Guard:** busca transcripts del proyecto target; una sesión que
   orquesta desde OTRO directorio produce SIN_EVIDENCIA aunque el paralelismo
   sea real (limitación conocida, documentada el 2026-07-16).
5. **Suites de test pesadas:** el cierre automático de contratos puede
   requerir subir `AKDD_TEST_TIMEOUT_MS` (default 180s) o correr el gate a
   mano — el mensaje de error lo dice.
6. **Gates que ejecuta el LLM** (Spec/Security como protocolo): su registro en
   telemetría depende de que el modelo siga la instrucción; los gates
   mecánicos se registran solos.
7. **Colaboración de equipo:** beta privada, no disponible públicamente.
8. **Benchmark N=1:** direccional, reproducible en `benchmark/`, no
   peer-reviewed — y así está etiquetado en el README.

## 10. LA PROMESA REAL (formulación exacta, sin inflar)

> **"Agentix hace que tu IA de código recuerde, respete y preserve tu proyecto
> mientras evoluciona — y cuando algo la haga dudar, se detiene del lado
> seguro. Cada protección que ejerce queda anotada y auditable."**

Lo que el comprador puede verificar por sí mismo en 10 minutos:
`akdd init` → `aa: configurar` → romper a propósito algo protegido → ver el
STOP con la zona exacta → `node .agentic/grafo/gate-telemetry.cjs stats` →
ver el evento anotado. `node .agentic/grafo/coverage-meter.cjs` → ver lo que
el sistema ve y lo que no.

## 11. INVENTARIO TÉCNICO RÁPIDO (para el analista)

- **Motor:** ~50 módulos CJS en `.agentic/grafo/` (grafo, kdd-memory,
  ast-indexer, regression-guard, tdd-gate, spec/security/contract/browser/
  ui-native gates, gate-telemetry, stack-profile, endpoint-heuristic,
  coverage-meter, sprint-state, path-norm, ts-enricher, lock-manager,
  mem-curator, creative-engine, prediccion, causal-edges, post-cycle,
  context-enricher, harness, telemetry, effectiveness-report…).
- **Agentes:** 10 roles en `.agentic/agentes/` orquestados por CLAUDE.md.
- **Persistencia:** SQLite (better-sqlite3 con fallback node:sqlite/sql.js).
- **Distribución:** dos canales — motor por `akdd update` (tarball de GitHub
  main) y CLI por `npm install -g agentic-kdd`. Deps pesadas siempre
  opcionales o bajo comando explícito (playwright-core optional; tree-sitter
  jamás se auto-descarga).
- **Superficie de usuario:** comandos de chat (`aa:`, `audit:`, `akdd …` vía
  MCP), CLI de terminal, dashboard local (localhost:3847, configurable con
  `AKDD_DASH_PORT`), 54 herramientas MCP.
- **Documentos de diseño de v3.13/14:** `_output/plan-1..6-*.md` (cada uno con
  estado, escenarios de verificación y refinamientos descubiertos) +
  `_output/ts-compare-*.md` + `_output/cobertura-*.md` +
  `_output/pendientes-post-plan5.md`.

## 12. LO QUE SIGUE (transparencia de roadmap)

Corto plazo: alineación completa del README (ES+EN) a v3.13/14 y publicación;
acumulación de telemetría real para calibrar la promoción por mérito.
Mediano: escalada ganada del Browser Gate a STOP; recuperación autónoma en
volumen; medidor de cobertura en el dashboard. Largo: auto-ajuste de umbrales
con datos longitudinales (el peldaño L5). Lo que solo el calendario da:
madurez pública de los "verificados" a "batalla".
