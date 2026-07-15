# Plan 4 — Portabilidad: sacar las convenciones de Lumo del código y moverlas a datos

> **✅ ESTADO: IMPLEMENTADO Y VERIFICADO (2026-07-15).** Ejecutado en C:\lumoV2
> (19/19 escenarios: regresión Lumo 50→52 conexiones con CERO perdidas; los 8
> frameworks del catálogo indexando; e2e Express JS plano + require + fetch
> conectando donde el legacy daba 0) y portado el mismo día a AGENTIX-KDD-main
> (paridad idéntica). Módulos nuevos: `.agentic/grafo/stack-profile.cjs` y
> `.agentic/grafo/endpoint-heuristic.cjs`; dashboard.cjs solo recibió 3 hunks
> quirúrgicos con fallback al legacy (que quedó intacto).
> **Refinamiento descubierto al implementar (incorporado):** los archivos
> "pegamento" sin símbolos extraíbles (un server.js de solo require+use+listen,
> o un panel.js de solo fetch) NO existen como nodos del grafo — los montajes y
> las llamadas front se escanean TAMBIÉN desde disco (acotado: raíz/src/server/
> api/backend + carpetas front del perfil, profundidad ≤3, tope 500 archivos).

> **Para ejecutar con `aa:` en el repo AGENTIX-KDD.** Documento autocontenido.
> Generado el 2026-07-15 con Fable 5 tras leer el código real (cada hardcode
> citado con archivo:línea fue verificado ese día). Resuelve: "Agentix instalado
> en proyectos de clientes que NO siguen las convenciones de Lumo (carpetas,
> frameworks, wrappers) pierde features en silencio".

---

## Objetivo en una línea

Que la clasificación front/back, la extracción de endpoints y la conexión
front↔back (endpoint≈) funcionen en proyectos con **otras carpetas, otros
frameworks y otros lenguajes** — moviendo cada convención horneada en el código
a **datos**: un catálogo universal de patrones + un perfil por proyecto
autodetectado (con override manual).

## El principio (y sus precedentes en este mismo repo)

**Las convenciones no se programan — se declaran.** El código pregunta "¿qué
patrones aplican aquí?" a un catálogo y a un perfil, en vez de traer `public/`
o `createXRouter` quemados adentro.

Precedentes ya vivos en el repo (no es una arquitectura nueva):
- `NATIVE_RULES` en `ui-native-gate.cjs` — reglas como datos, agregar una es
  agregar una entrada.
- La sección `Stack` de `.agentic/config.md` — ya existe un lugar donde vive
  "qué es este proyecto", autodetectado por `aa: configurar`.
- La cadena de fallback de `better-sqlite3` — si el dato no está, se degrada al
  comportamiento actual, jamás se rompe.

---

## Los hardcodes verificados (el inventario exacto de lo que hay que soltar)

| # | Convención quemada | Dónde | Efecto en proyectos de clientes |
|---|---|---|---|
| 1 | Front = módulo que empieza con `public` | `dashboard.cjs:771-772` (`esModuloFrontendServer`) + su gemelo client-side `esNodoFrontend()` (mismo criterio + `.jsx/.tsx`) | Front en `client/`, `frontend/`, Vue, HTML plano → todo pintado/posicionado como backend |
| 2 | Archivos "server" = `server\|app\|index` **solo `.ts/.tsx`** | `dashboard.cjs:668` (`\.tsx?$`) | Un Express en JavaScript plano (`server.js`) → endpoint≈ muere en el paso 1 |
| 3 | Montaje = literalmente `app.use('/p', create*Router(...))` | `dashboard.cjs:672` | Express sin esa función-fábrica con ese NOMBRE → cero conexiones |
| 4 | Rutas del back = carpeta `routes/` **solo `.ts/.tsx`** | `dashboard.cjs:680` | Rutas en otra carpeta o en `.js` → invisibles |
| 5 | Llamadas del front = SOLO el wrapper `api('...')` | `dashboard.cjs:702` | Proyectos con `fetch`/`axios` directo → cero conexiones |
| 6 | Front files para endpoint≈ = `public/` otra vez | `dashboard.cjs:697` | Mismo efecto que #1 |

**Dato clave que abarata todo:** el indexador AST **ya extrae endpoints de forma
genérica** — `kind='endpoint'` con patrón `(router|app).METODO('ruta')` sobre
CUALQUIER archivo JS/TS (`ast-indexer.cjs:344-348`), sin exigir `createXRouter`
ni carpeta `routes/` ni TypeScript. El endpoint≈ del dashboard NO usa el índice:
re-grepea archivos por su cuenta con el patrón angosto. **La mitad del problema
se resuelve leyendo del índice que ya existe.**

**Cálculo de riesgo de este plan:** endpoint≈ y los colores son features
INFORMATIVAS (visualización + contexto), no el guardia que bloquea. Aquí las
heurísticas generosas son aceptables — fallar = una conexión de menos en un
dibujo, no un STOP incorrecto. Lo único que toca al guardia (catálogo de
endpoints en el indexador) es aditivo y con los mismos formatos existentes.

---

# COMPONENTE 1 — Perfil del proyecto (`stack-profile`)

**Qué es:** una sección nueva en `.agentic/config.md` (y espejo en
`project_settings`) que declara las convenciones de ESTE proyecto:

```yaml
## Perfil de convenciones
front_dirs: [public, client]          # autodetectado, editable a mano
back_dirs: [src/routes, src/lib]
front_framework: vue                  # react | vue | svelte | angular | vanilla
back_framework: express               # express | fastify | nest | flask | fastapi | django | rails | laravel | spring | gin
api_wrappers: [api]                   # nombres de funciones wrapper de fetch propias del proyecto
```

**Autodetección (corre en `aa: configurar` / `akdd init` / comando propio
`node .agentic/grafo/stack-profile.cjs detect`):** señales puntuadas, ninguna
sola decide:

1. **Dependencias** (la señal más fuerte): `package.json` deps → react/vue/
   svelte/angular = front framework; express/fastify/@nestjs = back.
   `requirements.txt`/`pyproject.toml` → flask/fastapi/django. `Gemfile` →
   rails. `composer.json` → laravel. `go.mod` → gin/echo.
2. **Carpetas candidatas a front:** `public/`, `client/`, `frontend/`, `front/`,
   `web/`, `static/`, `src/pages/`, `src/components/`, `src/views/`,
   `templates/`. Se confirma carpeta a carpeta con la señal 3.
3. **Contenido (desempate, barato — el contenido ya está en mano al indexar):**
   `document.`/`window.`/`useState(`/`<template>` → front; `app.listen`/
   `require('express')`/imports de DB → back.
4. **Extensiones:** `.vue`/`.svelte`/`.jsx`/`.tsx`/`.html`/`.css` → front.

**Quién lo consume (el cambio real):** toda pregunta "¿esto es front?" pasa por
UNA función nueva `esFront(file, profile)` en un módulo compartido — y
`esModuloFrontendServer` (dashboard server-side), `esNodoFrontend` (client-side,
el perfil viaja al HTML como JSON embebido), y el paso 3 del endpoint≈ la usan.

**Regla de degradación:** sin perfil (proyecto viejo, config sin la sección) →
la heurística actual (`public/` + `.jsx/.tsx`) tal cual. Nadie queda peor.

**Opcional recomendado:** tercer balde `shared/desconocido` con tono neutro en
la coraza — más honesto que pintar de violeta (back) lo que no se pudo
clasificar.

---

# COMPONENTE 2 — Catálogo de endpoints backend multi-framework (EN EL INDEXADOR)

**Dónde:** `ast-indexer.cjs` — los patrones nuevos se agregan a los extractores
por lenguaje que YA existen, como tabla de datos (estilo `NATIVE_RULES`):

```js
const ENDPOINT_PATTERNS = {
  javascript: [ // y typescript
    { re: /\b(?:router|app|fastify)\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/g,
      method: m => m[1].toUpperCase(), path: m => m[2] },                    // Express/Fastify/Koa-router (ya existe, + fastify)
    { re: /@(Get|Post|Put|Delete|Patch)\s*\(\s*['"`]?([^'"`)]*)['"`]?\s*\)/g,
      method: m => m[1].toUpperCase(), path: m => m[2] || '/' },             // NestJS (prefijo @Controller se resuelve aparte)
  ],
  python: [
    { re: /@\w+\.route\s*\(\s*['"]([^'"]+)['"](?:.*?methods\s*=\s*\[([^\]]*)\])?/g, ... },  // Flask
    { re: /@\w+\.(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/g, ... },              // FastAPI
    { re: /\bpath\s*\(\s*['"]([^'"]+)['"]/g, ... },                                          // Django urls.py (método = ANY)
  ],
  ruby:   [ { re: /^\s*(get|post|put|patch|delete)\s+['"]([^'"]+)['"]/gm, ... } ],           // Rails routes.rb
  php:    [ { re: /Route::(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/g, ... } ],    // Laravel
  go:     [ { re: /\.\s*(GET|POST|PUT|DELETE|PATCH)\s*\(\s*"([^"]+)"/g, ... },               // gin/echo
            { re: /HandleFunc\s*\(\s*"([^"]+)"/g, ... } ],                                    // net/http (método ANY)
  java:   [ { re: /@(Get|Post|Put|Delete|Patch)Mapping\s*\(\s*(?:value\s*=\s*)?"([^"]+)"/g, ... } ], // Spring (y Kotlin)
};
```

**Regla de oro:** TODOS emiten el mismo símbolo normalizado que ya existe —
`kind: 'endpoint'`, `symbol_name: 'GET /ruta'` (métodos desconocidos:
`'ANY /ruta'`). **Por eso este componente alimenta gratis a todo lo demás:**
Regression Guard, la contención por líneas del Plan 1, el enricher, el
dashboard — todos consumen `kind='endpoint'` sin enterarse de qué framework
venía.

⚠️ Trampa del caché (idéntica a Planes 1-2): tras implementar, reindex forzado
(`clear` + `index`) o los archivos viejos no exhiben los endpoints nuevos.

---

# COMPONENTE 3 — endpoint≈ v2: leer del índice + catálogo de llamadas front

### 3a. El back de endpoint≈ deja de re-grepear — lee del índice

`getEndpointHeuristicEdges` (dashboard.cjs:662) reemplaza sus pasos 1-2 por:

```sql
SELECT file, symbol_name FROM ast_symbols WHERE kind='endpoint'
```

Con el Componente 2, eso ya trae Express en `.js` plano, Flask, Rails, etc. —
los hardcodes #2, #3 y #4 desaparecen de raíz.

**Prefijos de montaje, generalizados:** hoy solo entiende
`app.use('/p', create*Router(...))`. Generalizar a `\.use\(\s*['"]([^'"]+)['"]\s*,\s*(\w+)`
— cualquier identificador — y resolver de qué archivo viene ese identificador
con los edges `IMPORTS` que el grafo ya tiene; los endpoints de ese archivo
heredan el prefijo. `create*Router` queda como un caso más. Si no hay montaje
detectable → usar las rutas tal cual (muchos proyectos declaran el path
completo inline). NestJS: prefijo = `@Controller('x')` del mismo archivo.

### 3b. Catálogo de llamadas del front (además del wrapper `api()`)

```js
const FRONT_CALL_PATTERNS = [
  { re: /\bfetch\(\s*(`[^`]*`|'[^']*'|"[^"]*")/g },                    // fetch nativo (método: GET salvo {method:'X'} literal cercano)
  { re: /\baxios\.(get|post|put|patch|delete)\(\s*(`[^`]*`|'[^']*'|"[^"]*")/g },
  { re: /\baxios\(\s*\{[^}]*url\s*:\s*(['"`][^'"`]+['"`])/g },
  // + los wrappers del perfil: profile.api_wrappers.map(w => new RegExp(`\\b${w}\\(...`))
];
```

Los wrappers propios de cada cliente NO se programan: se declaran en
`api_wrappers` del perfil (Componente 1). Un cliente con `apiFetch()` agrega
una palabra a su config y listo.

**Front files** = `esFront(file, profile)` (Componente 1), no `public/`.

### 3c. Normalización de rutas (para que los dos lados calcen entre frameworks)

Canonicalizar AMBOS lados a segmentos con comodín `*` antes de comparar:
- Back: `:id` (Express) → `*` · `{id}` (FastAPI/Spring) → `*` ·
  `<int:id>` (Flask/Django) → `*`
- Front: `${...}` (template literal) → `*`
- El `segMatch` actual (dashboard.cjs:714) ya compara así con `' '` y `':'` —
  solo se generaliza el vocabulario de tokens.

### 3d. Escape hatch para lo irreconocible

`.agentic/endpoint-map.json` opcional: mapeo manual
`{ "src/views/x.vue": ["GET /api/negocios"] }` para el caso raro que ningún
patrón cubre. Se mezcla con lo detectado.

---

## El techo honesto (lo que NUNCA va a cubrir — decirlo antes que lo descubra un cliente)

1. **URLs armadas dinámicamente por partes** (`const u = base + '/' + entidad;
   fetch(u)`) — invisible para cualquier regex estático. Sin excepciones.
2. **GraphQL / tRPC / gRPC** — no hay rutas REST que calzar; es otro paradigma.
   Fuera de alcance (un catálogo de procedures tRPC es posible a futuro, no aquí).
3. **Monorepos con varios backends** al mismo path — se conecta generoso
   (es visualización); si molesta, el escape hatch lo pisa.

El diseño no persigue "cualquier convención" — persigue **los ~10 frameworks
que cubren la mayoría real de proyectos**, con perfil + escape hatch para el
resto. Eso es lo óptimo alcanzable con matching estático, y es suficiente.

---

## Dependencias con los otros planes

- **Desbloquea al Plan 2 en proyectos de clientes:** las Fases B/C necesitan
  saber qué archivos son vistas front — sin el perfil (Componente 1), en un
  proyecto con front en `client/` el Plan 2 clasificaría mal. **Orden
  recomendado: Plan 1 → Plan 4 → Plan 2 → (Plan 3 solo si el reporte lo pide).**
- **Suma al Plan 1 sin tocarlo:** más endpoints indexados (Componente 2) =
  más anclas disponibles para la contención por líneas. Mismos formatos.
- Extensión natural del Plan 2 Fase A para clientes: mapear `.vue`/`.svelte`
  al extractor HTML-ish (los `<form>`/`<select>`/clases del `<template>` salen
  con los mismos regex; los templates server-side `.blade.php`/`.erb`/`.twig`
  también son HTML-ish).

## Verificación (fixtures mínimas por convención — crear, probar, borrar)

1. **Express JS plano** (`server.js` + rutas inline, sin createXRouter, front
   con `fetch()` en `client/`): endpoint≈ debe conectar ≥1 par front↔back.
   Hoy conecta CERO (hardcodes #2, #3, #5, #6).
2. **Flask mínimo** (`app.py` con 2 `@app.route`): `ast-indexer symbols app.py`
   debe listar 2 `endpoint`.
3. **Front en `client/` con Vue:** la coraza/colores debe pintarlo de azul
   (perfil detectado) — hoy lo pinta de violeta.
4. **Proyecto Lumo real (regresión):** todo idéntico a hoy — mismo número o
   más de conexiones endpoint≈, misma clasificación front/back. La degradación
   sin perfil reproduce el comportamiento actual.
5. `akdd health` + dashboard sin errores.

## Qué NO hacer

- NO convertir nada de esto en bloqueo del pipeline — endpoint≈ y colores son
  informativos; siguen fallando SUAVE (cero conexiones ≠ error).
- NO renombrar `kind='endpoint'` ni el formato `"METHOD /ruta"` (9 consumidores
  + los JOINs de Planes 1-2).
- NO intentar parsear URLs dinámicas con regex cada vez más barrocos — para eso
  existe el escape hatch JSON.
- NO exigir el perfil: su ausencia = heurística actual (nadie queda peor).
- NO olvidar el reindex forzado tras el Componente 2.

## Al terminar (obligatorio, CLAUDE.md)

```bash
node .agentic/grafo/post-cycle.cjs grafo --tests=[N] --task="Portabilidad — perfil de proyecto + catálogo endpoints multi-framework + endpoint≈ v2"
```

---

## Pregunta abierta para el dueño (no bloquea el plan)

¿Qué stack usan los 2 clientes que hoy no calzan (framework de back + cómo
llama el front al API)? El catálogo de arriba probablemente ya los cubre — con
la respuesta se marcan sus entradas como prioridad de implementación y sus
fixtures de verificación se hacen con SU convención exacta.
