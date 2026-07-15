# Plan 3 — Tree-sitter sin romper nada: adopción por sombra (punto 7) + veredicto del punto 8

> **✅ ETAPAS 1-3 EJECUTADAS Y VEREDICTO EMITIDO (2026-07-15) — LA ETAPA 4 QUEDA
> DIFERIDA CON EVIDENCIA CONTUNDENTE.** La medición corrió contra el código real
> de lumoV2 (314 archivos, 1,989 símbolos emparejados contra tree-sitter):
>
> - **Dirección del error — la métrica decisiva:** SOBRA (dirección segura, el
>   guardia revisa de más): **1,894** · FALTA (dirección peligrosa): **5 = 0.25%**,
>   todas con delta ≤5 líneas. El truco del siguiente símbolo se equivoca hacia
>   el lado seguro en el 99.75% de los casos medidos.
> - Los 237 símbolos que el regex no ve son huecos de COBERTURA, no de rango —
>   ancla ausente = DOUBT = portón cerrado. Nunca fallan abierto.
> - **La medición se pagó sola:** destapó y arregló 3 bugs reales de la capa
>   regex — (1) los template literals gigantes con código incrustado creaban
>   332 símbolos FANTASMA y recortaban rangos reales (los únicos 4 casos
>   peligrosos originales); (2) el backtick dentro de un regex literal
>   (`escHtml`: `.replace(/\`/g,...)`) desincronizaba el lexer; (3) los const
>   con anotación de tipo TS (`const X: Record<...> =`) nunca matchearon.
>   Fixes: `blankTemplateLiterals` (lexer-lite + detección de regex literals)
>   + constPattern con anotación opcional. Planes 1 (15/15) y 2 (19/19)
>   re-verificados después — cero regresión.
> - **Evidencia extra CONTRA adoptar:** fragilidad de ABI vivida en carne
>   propia — web-tree-sitter 0.26 NO puede cargar las grammars de
>   tree-sitter-wasms 0.1.13 (hubo que fijar 0.22.6). Ese tipo de rotura en
>   máquinas de clientes = carga de soporte.
> - Herramienta permanente: `.agentic/grafo/ts-enricher.cjs` (status/compare,
>   fail-soft sin la dependencia) en ambos repos. La dependencia (~49MB) vive
>   SOLO en node_modules de AGENTIX-KDD-main, fuera de package.json, borrable.
>   Reporte completo: `_output/ts-compare-2026-07-15.md`.

> **Análisis + plan para el repo AGENTIX-KDD.** Documento autocontenido.
> Generado el 2026-07-15 con Fable 5 tras leer el código real. Este plan NO es
> para ejecutar ya — define CÓMO hacerlo el día que se decida, y CUÁNDO ese día
> llega (hay un disparador medible, no un "cuando se sienta").

---

## Veredicto del análisis

El otro chat tiene razón en que es peligroso — **pero el peligro está en el
MÉTODO ("reemplazar los extractores"), no en el objetivo.** Reemplazar de golpe
la capa regex por tree-sitter sí puede romper el sistema en cadena. Existe una
forma conocida y segura de adoptarlo: **sombra → refinamiento aditivo →
activación por lenguaje** — donde en ningún paso el sistema puede quedar peor
que hoy. Con esa forma, el punto 7 deja de ser "peligroso" y pasa a ser
"pospuesto con un plan de entrada seguro y un disparador medible".

Contexto ya registrado en memoria KDD (verificable con
`node .agentic/grafo/grafo.cjs buscar "tree-sitter"`):
- El indexador declara una estrategia de dos capas (regex siempre + tree-sitter
  opcional) pero **la capa 2 nunca se conectó**: `tryTreeSitter`
  (`ast-indexer.cjs:504-518`) existe y NADIE lo llama; `web-tree-sitter` y
  `tree-sitter-wasms` NO están instalados (verificado 2026-07-15).
- Decisión previa: si se conecta, es por la vía **WASM** (sin compilación
  nativa) — los binarios nativos ya dolieron en Windows en este proyecto
  (`tar`, `better-sqlite3` relegado a optionalDependency).

---

## Los 5 vectores de peligro reales — y la mitigación de cada uno

### 1. La trampa sync/async (la que nadie mencionó — el mayor riesgo estructural)

`indexFile()` e `indexProject()` son **síncronos** de punta a punta. La API de
`web-tree-sitter` es **async** (`await Parser.init()`, `Language.load()`).
Integrarlo inline en `indexFile` obliga a volver async toda la cadena de
llamadas: CLI, MCP server, post-cycle, hooks — el clásico refactor "toqué todo
y algo se rompió". **Este es el "puede romper" concreto del otro chat, con
nombre y apellido.**

**Mitigación:** tree-sitter NUNCA corre inline dentro de `indexFile`. Corre como
**pasada de enriquecimiento SEPARADA y async** (módulo nuevo
`ts-enricher.cjs`, o comando `ast-indexer.cjs enrich-exact`), que se ejecuta
DESPUÉS del index normal. La ruta regex queda **byte-idéntica** a la actual.

### 2. Deriva de contrato (los consumidores y los JOINs)

Nueve módulos consumen `ast_symbols` (`causal-edges`, `collab-manager`,
`context-enricher`, `grafo`, `health-check`, `mcp-server`, `metrics`,
`dashboard`, `ast-indexer`) y los Planes 1 y 2 agregan JOINs por
`symbol_name` EXACTO (`"PUT /path"`, `"form#login"`). Tree-sitter ve el mundo
distinto: funciones anidadas, métodos, otra granularidad de nombres. Si
INSERTa su propia visión o sobreescribe filas, los JOINs y filtros por kind se
rompen EN SILENCIO.

**Mitigación — v1 es refinamiento puro:** tree-sitter solo puede hacer
`UPDATE line_start, line_end` de filas que YA existen, matcheadas por
`(file, symbol_name, kind)`. Prohibido crear filas, renombrar o cambiar kinds.
Agregar columna `source` (`'regex'` | `'ts'`) para auditar qué refinó.
Los símbolos nuevos (métodos, funciones anidadas) son **v2**, detrás de flag,
y con kinds NUEVOS (ej. `'method'`) para que ningún filtro existente vea
valores inesperados.

### 3. Peso e instalación

La colección completa de grammars WASM pesa decenas de MB; y la compilación
nativa está descartada por decisión previa.

**Mitigación — seguir los DOS precedentes que ya viven en este repo:**
- `better-sqlite3`: dependencia pesada como `optionalDependency` con cadena de
  fallback (`node:sqlite`, `sql.js`) → `web-tree-sitter` (que es liviano) como
  optionalDependency; feature-detect en runtime; ausencia = comportamiento de
  hoy.
- `browser-gate.cjs`: **jamás auto-descargar binarios grandes** — si falta, se
  imprime el comando exacto para instalarlo. → las grammars NO se empaquetan:
  comando explícito `akdd ts-install js,ts` que descarga SOLO las pedidas a
  `.agentic/grammars/` (o instala `tree-sitter-wasms` como opt-in explícito).
  Por defecto, solo JS/TS (el 95% del valor en los proyectos reales del
  producto).

### 4. Divergencia regex↔tree-sitter (churn de protecciones)

Si de un día para otro los rangos/símbolos cambian en masa, las protecciones
acumuladas (behaviors, contratos, contención del Plan 1) cambian de
comportamiento en masa — aunque cada cambio individual sea "más correcto".

**Mitigación — MODO SOMBRA primero:**
1. La pasada async escribe a una tabla espejo `ast_symbols_ts` — NO toca la
   real.
2. Comando `compare`: reporte a `_output/ts-compare-[fecha].md` con, por
   lenguaje: símbolos solo-regex, solo-ts, en ambos, y la **distribución de
   deltas de line_end** (aproximación vs exacto).
3. **Criterio de promoción POR LENGUAJE** (no global): ej. ≥95% de acuerdo en
   `(symbol_name, kind)` sobre el proyecto real → recién ahí se enciende el
   flag de refinamiento de ESE lenguaje. Flags en `project_settings`.
4. **Killswitch:** apagar el flag devuelve el sistema a regex-only idéntico
   (porque la ruta regex nunca se tocó — vector 1).

### 5. Fallas de runtime

WASM que no inicializa, grammar corrupta, archivo raro que crashea el parser.

**Mitigación:** `try/catch` POR ARCHIVO; una falla de tree-sitter NUNCA aborta
el index ni deja menos datos que regex (portón cerrado, la misma regla de todo
lo demás). Las fallas se cuentan y aparecen en el reporte `compare`, no se
lanzan.

---

## El disparador honesto: ¿CUÁNDO vale la pena hacerlo?

Después de que el Plan 1 esté en producción, el reporte `compare` (etapa 3)
mide **gratis** cuánto se equivoca la aproximación del "siguiente símbolo":
la distribución de deltas entre el `line_end` aproximado y el exacto.

- Si el delta es ≤ 2 líneas en ~todos los símbolos del código real del proyecto
  (que es lo esperable en código formateado con Prettier/ESLint) → tree-sitter
  aporta poco al Regression Guard y **se queda diferido — el instinto original
  del punto 7 era correcto.**
- Sus killer apps reales son otras: rangos exactos de **símbolos anidados y
  métodos de clase** (la v2 de granularidad) — que solo se vuelven necesarios
  cuando la Fase 2 de anclas por función (Plan 1, Paso 6) lo exija en proyectos
  con clases grandes.

**Traducción:** el punto 7 sigue siendo "después" — pero ahora con una rampa de
entrada segura y una condición medible para decidir, en vez de un "ver si hace
falta" a ojo.

---

## El plan por etapas (cuando se decida entrar)

| Etapa | Qué se hace | Riesgo si falla |
|---|---|---|
| 0 | Prerrequisito: Plan 1 en producción (línea base que comparar) | — |
| 1 | `web-tree-sitter` como optionalDependency + feature-detect + comando `akdd ts-status` (dice qué hay instalado y qué grammars) | Cero: sin instalar, todo igual |
| 2 | Pasada async de sombra → tabla espejo `ast_symbols_ts` (no toca la real) | Cero: tabla aparte |
| 3 | Comando `compare` + reporte de acuerdo por lenguaje | Cero: solo lee |
| 4 | Flip por lenguaje: refinamiento UPDATE-only de `line_start/line_end` en filas existentes + columna `source` | Bajo: killswitch lo revierte; JOINs intactos (nombres no cambian) |
| 5 | v2 opcional: símbolos anidados/métodos con kinds NUEVOS, detrás de flag | Medio: solo si la Fase 2 del Plan 1 lo exige |
| 6 | Documentar killswitch y criterio de promoción en config.md | — |

---

## Punto 8 (nodos de documentación: PDFs, papers, URLs) — veredicto corto

**De acuerdo con dejarla al final o descartarla.** Razones:

1. La tajada de mayor valor de "documentación como nodos" **ya está cosechada**:
   la minería de comentarios (`NOTE/WHY/HACK/FIXME` → nodos del grafo,
   `ast-indexer.cjs:156-186`) captura el "por qué" que los devs dejan donde
   de verdad lo escriben — en el código.
2. Agentix es **memoria de decisiones de código**, no biblioteca de referencias.
   Indexar PDFs/papers agrega peso (parsers de PDF, embeddings de documentos
   largos) para consultas que casi nunca ocurren en el flujo `aa:`.
3. Si algún día se retoma, el alcance correcto es mínimo: **solo URLs
   referenciadas en comentarios** como nodos `reference` (regex trivial, cero
   dependencias, se cuelga de la minería de comentarios existente). PDFs: no.

---

## Nota sobre la conversación de origen (para no re-trabajar)

- **Playwright empaquetado en Agentix:** ya está resuelto MEJOR de lo que esa
  conversación planteaba — `browser-gate.cjs` existe y usa `playwright-core` +
  el Chrome/Edge del sistema (cero descarga de binarios de 100-300MB; modo
  `--own` opcional para copia aislada). No re-hacer. Su evolución está en el
  Plan 2, Fase C.
- **Graphiti / grafo temporal:** la memoria ya es bi-temporal
  (`valid_at/invalid_at/expired_at`), con episodios y embeddings. Sin acción.

---

## Qué NO hacer (lista dura)

- NO hacer `require('web-tree-sitter')` obligatorio ni inline en `indexFile`
  (trampa sync/async — vector 1).
- NO reemplazar los extractores regex. Nunca. Se refinan sus resultados, no se
  sustituye su ruta.
- NO dejar que tree-sitter INSERTe símbolos o cambie nombres/kinds en v1.
- NO auto-descargar grammars ni binarios sin comando explícito del dev.
- NO activar refinamiento global — siempre por lenguaje, con criterio de
  acuerdo medido y killswitch.
- NO empezar por aquí: este plan es el TERCERO en orden. Primero Plan 1
  (precisión por líneas), luego Plan 2 (UI), y este solo cuando el reporte
  `compare` demuestre que hace falta.
