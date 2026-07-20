# Changelog — Agentic KDD

## [3.16.2] — 2026-07-20

### Coliseo Diabólico corrido en modo "auditoría de maquinaria" — 2 huecos tapados
Se corrieron las 5 fases del Coliseo sobre FLOTA360 evaluando qué atrapan los
gates MECÁNICOS por su cuenta (independiente del juicio del modelo). Resultado:
los gates de dominio acotado funcionan (UI Native, UI Layout Memory, Lock
Manager cross-instancia, secretos); los semánticos dependían del brief+modelo.
Dos huecos mecánicos reales, tapados:
- **spec-value-scan ahora deriva las claves vigiladas de la MEMORIA del
  proyecto**, no solo de una lista fija en inglés (trial_days…). Cualquier
  identificador snake_case que aparezca junto a un número en un nodo
  decision/patron ALTA/MEDIA se vigila automáticamente. Antes, un valor propio
  como `fuel_surcharge_pct` (decisión ALTA en memoria) era invisible al escaneo
  mecánico; ahora el diff que lo toca con otro número se marca solo.
- **ui-native-gate salta líneas de comentario** — un comentario que menciona
  `alert()`/`confirm()` ya no cuenta como uso real (falso positivo).

### Huecos documentados, pendientes de arreglo cuidadoso (no rushear)
- Security Gate cross-tenant: solo corre sobre archivos CRITICAL/SENSITIVE (un
  `src/server.js` monolítico es NORMAL y se salta) y matchea el literal
  `tenant_id`/dialecto Prisma, ciego a `companyId` + store JSON. Una fuga
  cross-tenant en ese estilo pasa mecánicamente — hoy la ataja el brief de
  memoria + juicio del modelo, no el gate.
- Security Gate no marca un valor de config peligroso (JWT 30d) en archivo
  CRITICAL — detecta bypass/secretos, no "valor riesgoso".
- protected_behaviors.related_files queda vacío si el behavior se registra con
  árbol limpio → regression-guard `check <archivo>` no asocia fuente↔behavior.

## [3.16.1] — 2026-07-19

### El pipeline se encontró un bug a sí mismo (y quedó reparado)
Corriendo `akdd cu sprint --auto` sobre FLOTA360, el agente reportó como tarea
sugerida un bug real del motor — verificado y corregido el mismo día:
- **Comando de test mal parseado con config.md en formato YAML de bloque**: `\s*`
  en `/^\s*test:\s*(.+)$/m` cruza el salto de línea y capturaba la línea
  siguiente ("runner: node --test") como comando literal → STOP falso del TDD
  Gate y contratos sin registrar. 6 usos corregidos en 5 archivos
  (`[^\S\n]*` no cruza líneas) + soporte del campo `comando:` del bloque YAML.
- **tdd-gate**: `.agentic/` excluido del scope de changeset (el gate mismo
  ensucia memoria.db al correr — en proyectos que la versionan, el scope quedaba
  solo con archivos del motor → 0 tests relacionados → fallo mudo en cada
  post-cycle) + la razón del fallo ahora siempre se imprime.

## [3.16.0] — 2026-07-19

### ClickUp Bridge (nuevo, opt-in, experimental) — los sprints entran solos desde ClickUp
- **clickup-bridge.cjs** — trae las tareas de una Lista de ClickUp (API REST directa,
  sin depender de MCP), las coteja contra el proyecto real (ast_symbols +
  code-summaries + dominio de config.md) y las clasifica: RELEVANTE_CLARA /
  RELEVANTE_NUEVA / AMBIGUA / SIN_RASTRO. Apagado por defecto — se activa con
  `akdd cu on` (pide `CLICKUP_API_TOKEN` en `.env`, lo valida contra la API).
- **`akdd cu sprint --auto`** — filtro mecánico de auto-elegibilidad que reutiliza los
  gates reales: solo RELEVANTE_CLARA, sin archivos CRITICAL/SENSITIVE
  (`classifyFileRisk`), sin valores de negocio en conflicto con la MEMORIA del
  proyecto (no listas hardcodeadas — la primera prueba real demostró que
  `spec-gate` solo hablaba inglés), sin tema de auth/sesiones, sin alcance
  estructural grande (migraciones), y con descripción con sustancia real. El
  protocolo CLICKUP AUTO (CLAUDE.md) ejecuta el pipeline `aa:` completo solo para
  las elegibles, con resumen pre-lote obligatorio.
- **`akdd cu done <id>` / `akdd cu comment <id>`** — cierre del ciclo en ClickUp:
  tarea completada solo si tests+QA pasaron limpio sin ningún STOP/WARN; ante
  cualquier duda, solo comentario (el humano cierra el ticket dudoso, no la
  máquina). El estado de cierre se resuelve por Lista (ClickUp no tiene un
  "complete" universal — bug encontrado probando contra lista real).
- Probado de punta a punta contra cuenta real de ClickUp (13 tareas): 5 bugs
  reales encontrados y corregidos probando contra datos reales, incluyendo las 2
  trampas de seguridad (ticket de auth y cambio de valor de negocio salían
  auto-elegibles en la primera versión del filtro).

### Autonomía L4 endurecida (protocol → mechanical, todo probado en proyecto real primero)
- **RECOVERY mecanizado** — `checkBeforeBuild()` detecta solo cuando un behavior con
  STOP/FAIL pendiente vuelve a pasar limpio y registra `RECOVERED`
  (`source: mechanical`) sin depender de que el modelo se acuerde. Ya no existe el
  paso manual `node -e` del protocolo RECOVERY.
- **regression-guard multi-runner** — `runTestFile()` detecta el runner real
  (vitest/jest/mocha/node) en vez de asumir Jest; fix de quote-leak de cmd.exe que
  rompía el filtro de tests en Windows.
- **Spec/Test integrity scan automático** — `spec-value-scan.cjs` y
  `test-integrity-gate.cjs` existían pero nadie los invocaba: ahora corren solos en
  cada post-cycle (Step 2.7) sobre el diff del último commit. WARN-only.
- **ui-layout-memory.cjs** (nuevo) — memoria de decisiones de posición/tamaño de UI
  (elemento + propiedad CSS + motivo). Detecta cambio nuevo, reversión exacta a un
  valor ya abandonado, y propiedad desaparecida. Post-cycle Step 2.8, solo sobre
  archivos de UI del commit. Cierra el hueco "el select volvió a su lugar viejo".
- **graph-reviewer.cjs** — 4º falso positivo corregido: entradas glob
  (`public/js/**`) en `archivos_aplica` se marcaban como archivo fantasma.

### Arena
- **Coliseo Diabólico** (escenario 08) — 5 fases adversariales sobre terreno nuevo
  (FLOTA360: SaaS multi-tenant de flotas con memoria pre-envenenada), 2 brazos:
  con Agentix (Cursor+Claude sobre el mismo repo) vs sin Agentix (control).

## [Publicado en 3.16.0, trabajado 2026-07-17/18]

### Las 7 piezas (inspiradas en Understand-Anything, probadas en proyecto real antes de portar)
- **change-classifier.cjs** — distingue cambios COSMETIC (comentarios/formato) de
  STRUCTURAL (firmas/imports). `knowledge-validator` ya no marca conocimiento como
  SOSPECHOSO por un comentario — solo por cambios estructurales reales. CLI: `akdd changes`.
- **graph-freshness.cjs** — el grafo se sella con el commit de git en cada post-cycle;
  badge en el dashboard (🟢 al día / ✏️ cambios sin commitear / ⏳ N commits atrás) y
  aviso en el brief de cada `aa:`. CLI: `akdd fresh`.
- **graph-reviewer.cjs** — integridad determinista de memoria.db: relaciones colgantes,
  archivos fantasma, contratos con tests borrados, locks vencidos. `--fix` limpia solo
  categorías seguras; el conocimiento jamás se toca solo. Integrado a `akdd health`.
  CLI: `akdd integrity`.
- **importMap determinista** (dentro de ast-indexer) — resolver de imports memoizado,
  compartido por corrida, con alias del tsconfig (`@/`). Equivalencia verificada contra
  el resolver viejo: 1,256 aristas, 0 diferencias; determinismo bit-idéntico entre corridas.
- **code-summaries.cjs** — descripciones en lenguaje natural POR ARCHIVO escritas por el
  agente leyendo el código real (protocolo `akdd describe`, regla dura: solo nombres de
  archivo pueden ser técnicos). Vigencia atada a la firma estructural: un comentario no
  la invalida, una función nueva sí. El "¡NO ENTIENDO!" del dashboard las usa primero.
- **diff-overlay.cjs** — blast radius visual: `akdd overlay` pinta en Code Structure qué
  archivos cambiaron (rojo) y cuáles pueden verse afectados a 1 salto (ámbar; naranja
  intenso si tienen contratos encima). Botón "🔥 Cambios" en el dashboard.
- **tour-builder.cjs** — "Visita guiada": recorrido del proyecto agrupado POR MÓDULO
  (no por archivo: 307 archivos → 16 paradas en el proyecto de validación), en orden
  topológico de dependencias, con tabs Frontend/Backend (misma clasificación que la
  coraza), selector de salto directo, memoria KDD y contratos por parada. CLI: `akdd tour`.
- Los 6 módulos nuevos clasificados como `experimental` en MADUREZ.json (un solo
  proyecto de validación todavía) — lint de fronteras en verde.

### Dashboard
- Code Structure: color por módulo/carpeta (antes por lenguaje — plano en proyectos
  mono-lenguaje), "¡NO ENTIENDO!" totalmente en lenguaje natural con traductor
  heurístico de nombres como respaldo, glosarios "?" actualizados con cada feature nueva.
- Fix: el modal del glosario vivía anidado dentro de la pestaña Knowledge Graph — en
  cualquier otra pestaña su contenedor oculto lo colapsaba a tamaño cero.
- Fix de bug latente pre-existente: `split(/[\\/]/)` dentro del template literal gigante
  perdía una barra al evaluarse — 5 sitios del dashboard mostraban rutas completas en
  vez de nombres de archivo desde siempre, en silencio. Corregido en los 6 sitios.

### Instalación
- Fix: `akdd init` copiaba `docs/` completo al proyecto del cliente — incluyendo 44MB
  de seeds del arena de benchmark (con node_modules y DBs de prueba). Ahora filtra
  `benchmarks/`, `benchmarks$dest/` y `superpowers/`; la copia real queda en ~72KB.
  Defensa en profundidad adicional en `.npmignore`.

## [3.15.2] — 2026-07-17

### Reparación de las 3 grietas encontradas por el Coliseo Agentix
El Coliseo (arena adversarial de 15 rondas en 4 tiers, mitad Claude Code mitad Cursor,
sobre el proyecto MediCore) encontró 3 grietas reales — las 3 reparadas con verificación
mecánica (13/13 checks) + regresión completa de Planes 1-7 en verde:
- **test-integrity-gate.cjs** (nuevo): si el título de un test que protege un
  patrón/decisión ALTA desaparece del archivo, se marca CRÍTICO — cierra la grieta más
  seria (el agente debilitó las aserciones del test que lo vigilaba para ocultar un bug
  con un verde falso). Enganchado a `regression-guard.checkBeforeBuild()` y al pre-commit.
- Security Gate: regla agnóstica de ORM (accesores `unsafe`/`allRaw` en archivos
  tenant-aware → CRÍTICO) — antes solo hablaba el idioma Prisma y dio PASS a una fuga
  cross-tenant real. `*repo*`/`*.service.*` reclasificados como SENSITIVE.
- TDD Gate: corre `npm run typecheck` (si existe) tras los tests — `tsx` podía dar verde
  con errores de tipos reales. Bonus: el parser de `node --test` no reconocía el modo
  TAP (`#`), reportando 0/0/0 aunque los tests pasaran.

## [3.15.1] — 2026-07-16

- Dashboard: el conocimiento de frontend se distingue por color en KDD Memory y Combined.
- Fix: ventanas LOCK_WINDOW en un solo reloj (UTC) — `acquired_at` de SQLite venía sin
  zona horaria y `Date.parse` lo leía como hora local, corriendo el solape por el offset
  de la máquina (falsos negativos del Parallel Guard en UTC-X).
- README con evidencias visuales del dashboard en proyecto real.

## [3.15.0] — 2026-07-15

### Endurecimiento estructural (Plan 7 — cero features nuevas: más estricto, más honesto)
- Telemetría con etiqueta `source: mechanical | protocol` — se puede medir qué fracción
  de la protección es hierro que corre solo vs obediencia del modelo.
- Pre-commit hook con gates mecánicos (`security-scan` + `spec-value-scan`) que corren
  sin pasar por el LLM — visibles, no bloqueantes en v1 (la escalada a bloqueo se gana).
- Parallel Guard con evidencia por locks solapados — prueba mecánica de paralelismo real,
  independiente de transcripts y del directorio de orquestación.
- `MADUREZ.json` + `madurez-lint.cjs` — manifiesto core/stable/experimental de los ~50
  módulos del motor, con lint que impide que el núcleo cargue módulos experimentales.
- Upgrade de clientes viejos PROBADO: DB de v3.12 + motor v3.15 encima → 31/31
  verificaciones en verde, con y sin better-sqlite3.

## [3.14.0] — 2026-07-16

### Potenciadores de memoria (Plan 5) + pendientes construibles (Plan 6)
- 6 potenciadores de la memoria + telemetría de gates y promoción de confianza por
  mérito (19/19 escenarios propios, incluido sabotaje de la libreta: el gate sobrevive
  con la tabla rota).
- Pendientes construibles: medidor de cobertura declarada, higiene, continuidad de
  sprint (`aa: continúa sprint`), protocolo RECOVERY ante gates en STOP (13/13
  escenarios + regresión total de planes anteriores).

## [3.13.0] — 2026-07-15

### Precisión por líneas, portabilidad multi-framework, Ojos UI (Planes 1-4)
- Regression Guard con precisión por LÍNEAS (HIT/MISS/DOUBT): un cambio solo dispara
  los behaviors cuyas líneas toca — fail-closed: ante cualquier duda degrada a "archivo
  completo protegido" (15/15 escenarios contra endpoints y behaviors reales).
- Ojos UI: forms/selects/required/clases CSS como nodos del grafo; Browser Gate por
  comportamiento en Chrome/Edge real (19/19 escenarios, incluyendo los 2 bugs reales
  de Salud360 reproducidos y detectados).
- Medición tree-sitter: comparador construido y corrido sobre 1,989 símbolos reales —
  veredicto: la extracción regex es suficiente (99.75% de los errores del lado seguro);
  la adopción de tree-sitter queda DIFERIDA con evidencia, no por pereza.
- Portabilidad: las convenciones (carpetas front, frameworks) salen del código y se
  declaran en datos (`stack-profile.cjs`) — catálogo de endpoints de 10 frameworks.

## [3.12.1] — 2026-07-14

- Fix: `akdd update`/`init` seguía fallando con el tar nativo de Windows — extracción
  reemplazada por implementación nativa en Node (`tar-extract.js`), sin depender del
  `tar` de shell. Verificado de punta a punta contra proyecto real.
- `.npmignore` endurecido.

## [3.12.0] — 2026-07-14

- Base de la generación v3.12+: memoria nativa (Parallel Guard, área, archivos_aplica,
  UI Native Gate) + Code Structure con coraza (front en anillo exterior, back al centro)
  y `endpoint≈` (une el frontend con la ruta de API que llama).

## [3.11.4] — 2026-07-05

### QA de 4 lentes ahora es proporcional al tamaño real del cambio
- La regla de v3.11.2 hacía la Legión de QA (4 sub-agentes en paralelo)
  obligatoria para **cualquier** cambio, sin importar el tamaño — un fix de
  una línea disparaba lo mismo que un cambio de 300 líneas en `auth`. Eso
  no era robustez, era desproporción, y costaba tiempo real en cada tarea.
- Ahora el Paso 4 (Review KDD) mide el diff real de la fase (mismo mecanismo
  que ya usa `tdd-gate.cjs`) contra un piso **objetivo y numérico**: ≤2
  archivos, ≤20 líneas, ningún archivo CRITICAL/SENSITIVE, ningún valor de
  negocio del SPEC GATE. Si el changeset es así de chico, se revisa en una
  sola pasada sin sub-agentes — sigue siendo revisión real, no se salta.
  Si falla cualquiera de esas condiciones, corre la Legión completa igual
  que antes, sin excepción.
- El criterio es deliberadamente numérico y no "a juicio": la versión
  anterior a v3.11.2 decía "si parece riesgoso" y nunca se disparaba en la
  práctica — un número no se puede racionalizar para saltárselo.

## [3.11.3] — 2026-07-05

### Creative Engine — detección automática de errores resueltos
- Nuevo tipo de sugerencia `ERROR_LIKELY_FIXED`: cada sync compara la tarea de
  los últimos ciclos completados contra los errores que siguen `ACTIVO` en el
  grafo, cruzando por palabras clave compartidas (no por área — área de ciclo
  y área de error no siempre coinciden). Nunca cierra nada solo: deja una
  sugerencia que se confirma con `creative-engine.cjs apply <id>`.
- Al aplicarla, el nodo de error pasa a `estado='RESUELTO'` (la misma convención
  que ya usaban los fixes marcados a mano vía `aa: aprende`) — desaparece
  automáticamente de todos los conteos/alertas de "errores activos" que ya
  existían (cluster de causa raíz, dashboard, etc.) sin tocar cada uno aparte.
- Fix: `applySuggestion()` bloqueaba la aplicación manual vía CLI en Nivel < 2
  aunque su propio mensaje de error decía "aplícalo manualmente" — ahora
  `apply <id>` (invocación explícita) ya no queda sujeto al gate de nivel.
- Fix (encontrado probando contra datos reales): la primera versión solo
  actualizaba SQLite, y `grafo.cjs sincronizar()` la revertía en el siguiente
  sync porque reconstruye `nodos` releyendo `.agentic/memoria/errores.md` (la
  fuente de verdad real). Ahora también edita el `.md` — confirmado que el
  cambio sobrevive un `sync` real.

## [3.8.4] — 2026-07-01

### 🛡️ MARK 6 — Escudo de seguridad (Security Gate reforzado)
- El Security Gate ahora escanea **todos** los archivos del changeset (no solo
  CRITICAL/SENSITIVE) en busca de:
  - **Secretos/credenciales**: llaves privadas, AWS/GitHub/OpenAI/Stripe/Google/Slack
    tokens, connection strings con password, JWT, Bearer literales → CRITICAL = STOP.
  - **PII**: correos y tarjetas de crédito (con validación Luhn) → WARN.
  - **Prompt-injection**: anular instrucciones, exfiltración, "reveal prompt",
    jailbreak, desactivar salvaguardas, unicode invisible → HIGH/CRITICAL.
- Robusto: redacta los secretos en el reporte, reporta número de línea, y descarta
  falsos positivos (placeholders, `process.env`, baja entropía, emails de ejemplo).
- Los checks previos de tenant/JWT/auth quedan **intactos**.

## [3.8.3] — 2026-06-30

### Modo colaborativo en beta privada (preparación para lanzamiento público)
- **`collab` desactivado por defecto.** Todos los subcomandos (`init/invite/join/push/pull/status`)
  muestran un aviso de "beta privada" y no corren, salvo que se defina `AKDD_COLLAB_ENABLED=1`
  (uso interno / clientes). Esto evita exponer el provisioner de Turso/Cloudflare al público.
- El resto de Agentix funciona **100% local, sin cuenta** — la colaboración era la única pieza
  con dependencia externa.
- READMEs (EN/ES) y menú del CLI marcan colaboración como **🔒 beta privada**.
- También: listado completo de las auditorías del departamento QA (`audit:` por área) en ambos READMEs.

## [3.8.2] — 2026-06-30

### READMEs alineados EN↔ES + mapa de comandos manual/automático
- **README inglés y español ahora idénticos en estructura y contenido** (cada uno en su idioma).
- Nueva sección **Compatibilidad**: honesta — primera clase en Claude Code y Cursor (probado a
  fondo), compatible con otros vía `AGENTS.md`/MCP pero aún no probado a fondo ahí.
- Nueva sección **"Comandos — qué corre solo y qué corres tú"** con leyenda 🟢 automático /
  🔵 disparador / ⚪ manual, dejando claro qué se registra de forma autónoma (ciclos, contratos,
  AST, checkpoint cada 5) y qué comandos son manuales.
- **Referencia completa del CLI** portada también al README español (antes solo en inglés).

## [3.8.1] — 2026-06-30

### Alineación de documentación + endurecimiento de collab (cosmético/seguridad)
- **Versión unificada a 3.8.1** en `package.json` y badges de ambos READMEs (antes el
  README inglés estaba congelado en 3.6.0).
- **Conteo de herramientas MCP unificado a 54** (real, verificado contra el servidor en vivo)
  en README EN/ES (antes 60 vs 23).
- **`AGENTS.md`**: "28 módulos" → 38 reales; ruta `grafo/` → `.agentic/grafo/`.
- **`mcp-server.cjs`**: `serverInfo.version` 2.0.0 → 3.8.1.
- **Seguridad collab**: `.agentic/collab.json` (URL + token de Turso) ahora está en
  `.gitignore` del repo (defensa en profundidad). El provisioner del modo colaborativo es
  configurable por entorno (`AKDD_COLLAB_PROVISIONER_URL`) y admite auth opcional
  (`AKDD_COLLAB_AUTH` → `Authorization: Bearer`), backward-compatible.

## [3.8.0] — 2026-06-30

### Onboarding automático de proyectos existentes + AST automático
- **`akdd init` en proyecto existente** — al elegir "ya tiene código", ahora corre
  automáticamente `onboard` (detecta stack/módulos/patrones), indexa el código (`ast`)
  y sincroniza el grafo (`sync`). El dashboard arranca poblado sin pasos manuales.
  Todo best-effort: si algún paso falla, `init` no se rompe.
- **AST automático en el cierre de ciclo** — `post-cycle.cjs` ahora indexa el AST como
  paso final. Es incremental (ast-indexer cachea por `content_hash`), así que tras cada
  commit solo re-parsea los archivos que cambiaron. Mantiene el grafo de símbolos fresco
  sin depender de que el agente lo corra, en segundo plano y a 0 tokens.

## [3.7.0] — 2026-06-30

### Registro de contratos automático (sin intervención del agente)
- **Hook git post-commit** — nuevo `.agentic/grafo/git-hooks/post-commit` que dispara
  `post-cycle.cjs` en segundo plano tras cada commit. Nunca bloquea el commit (exit 0),
  con debounce de 90s y derivación de área desde `src/`.
- **Instalador `install-hooks.cjs`** — idempotente, no-op sin git, y NO sobrescribe hooks
  ajenos (marcador). Auto-instalado por `akdd init`, `akdd update` y `grafo.cjs sync`
  (esta vía propaga el hook a proyectos ya instalados en su próximo `akdd update`).
- **`post-cycle.cjs --hook`** — modo seguro: no ejecuta `npm install` y no falla si falta
  `memoria.db` (sale 0). El uso manual del comando queda idéntico.
- **Nuevo comando `akdd hooks [install|uninstall|status]`**.
- **Fix:** `src/init.js` apuntaba al nombre de repo viejo (`Agentic-KDD`); ahora `AGENTIX-KDD`.

## [3.6.0] — 2026-06-28

### Auditoría completa + endurecimiento del motor
- **30+ bugs reparados** tras auditoría de los 48 archivos del motor (8 sesiones):
  5 críticos (db.prepare sobre el adapter, bin roto, dispatcher MCP, inyección),
  14 altos (Spec Gate inerte, TDD Gate con PASS falso, métricas en 0, etc.) y
  ~10 medios/bajos.
- **Búsqueda vectorial real** — `indexarPendientes` ahora embebe y persiste los
  vectores; `akdd buscar` rankea por similitud coseno real (antes degradaba a texto).
- **Fuente única del motor** — consolidado todo en `.agentic/grafo/`; eliminada la
  copia muerta `src/grafo.cjs` y el directorio duplicado `grafo/`.
- **Higiene de publicación** — `.npmignore` (no se filtra `memoria.db`) + hook
  `prepublishOnly` que bloquea publicaciones con el motor viejo o versión descuadrada.
- **Parser de memoria** — `parsearEntradas` ya no crea nodos fantasma desde headers
  ni comentarios de plantilla.

## [2.1.0] — 2026-06-18

### Nuevas funcionalidades
- **Observabilidad completa** — tabla `ciclos` y `fases` en SQLite para tracing por ciclo
- **Métricas de agente** — Goal Attainment Rate, Autonomy Ratio, Handoff Integrity, Drift Index, Guardrail Violations
- **Dashboard: panel Metrics** — visualización de KPIs en tiempo real desde SQLite
- **Dashboard: panel Timeline** — historial cronológico de decisiones + specs auto-generadas
- **Dashboard: panel Onboarding** — barra de progreso de configuración del proyecto
- **Búsqueda semántica** — embeddings opcionales via ANTHROPIC_API_KEY (fallback a SQLite)
- **Índices compuestos SQLite** — queries del Analista hasta 10x más rápidas
- **Specs automáticas** — `.agentic/specs/[modulo].md` generadas al terminar cada módulo
- **Híbrido Kiro-style** — el Orquestador lee specs como fuente de intención antes de planificar
- **Validación de vigencia** — patrones sin usar 30+ ciclos se marcan automáticamente
- **ag:test y ag:review automáticos** — corren dentro de `aa:` sin intervención del usuario
- **Gate de tests** — el ciclo no avanza si los tests fallan
- **Log de observabilidad** — `_output/log-YYYY-MM.md` escrito automáticamente

### CLI
- **akdd init inteligente** — detecta stack automáticamente y genera config.md completo
- **Plantillas por stack** — Next.js, Laravel, Node.js, React, PHP, Python
- **dashboard.cjs copiado en init** — listo para correr desde el primer momento

### Mejoras
- `grafo.cjs` — nuevo comando `metricas`, `ciclo`, `semantico`
- `schema.sql` — campo `ultima_validacion`, tablas `ciclos` y `fases`
- Migración automática de DBs existentes (sin perder datos)
- Todos los archivos en `.cjs` — compatibilidad con proyectos ESM

### Correcciones
- Fixed: `parseEntries` eliminado por duplicación de funciones en dashboard
- Fixed: `clientWidth=0` en grafo de módulos (dimensiones fijas)
- Fixed: emojis en PDF del manual (reemplazados por texto)

---

## [2.0.8] — 2026-06-17

### Nuevas funcionalidades
- **Subagentes Pro** — `ag: refactor`, `ag: test`, `ag: doc`, `ag: review`
- **Departamento QA** — `audit:` con 7 subagentes independientes
- **Dashboard v4** — Knowledge Graph D3 + Project Docs
- **Nodos divinos** ⚡ y **conexiones sorprendentes** ✨
- **Graph Report** — equivalente al GRAPH_REPORT.md de Graphify
- **`.cjs` universal** — compatible con proyectos ESM y CJS

---

## [2.0.6] — 2026-06-15

### Nuevas funcionalidades
- Grafo SQLite con detección automática de entidades
- `akdd graph` — estadísticas del grafo en consola
- `akdd dashboard` — abre el dashboard visual

---

## [2.0.0] — 2026-06-10

### Primera versión pública
- Pipeline autónomo `aa:`
- Context Guard
- Arquitectura de lectura en capas
- Señales de confianza BAJA/MEDIA/ALTA
- Compresión periódica de memoria
- QA independiente
- Protocolo STOP

## [2.2.0] — 2026-06-22

### Nuevas funcionalidades

#### 1. Embeddings Locales (all-MiniLM-L6-v2)
- Motor de búsqueda semántica 100% offline — sin API key
- `@xenova/transformers` — modelo ONNX quantizado, ~23MB
- Búsqueda híbrida RRF (Reciprocal Rank Fusion): vectorial + keyword
- Indexación automática en `akdd sync` — batch de 30 nodos por sync
- Mejora recuperación de memoria de ~60% → ~90% de relevancia
- `akdd embed-status` — verificar estado
- `akdd embed-install` — instalar one-shot

#### 2. Git Context
- Análisis automático del diff en cada `akdd sync`
- Cruza archivos modificados contra memoria episódica → alertas de riesgo
- Niveles: 🔴 ALTO | 🟡 MEDIO | 🟢 BAJO por archivo
- Carga contexto en `working_memory` — el Analista lo lee antes de planificar
- Hook post-checkout automático: `akdd git-context --install-hook`
- `akdd git-context` — análisis manual en cualquier momento

#### 3. Motor de Predicción
- Minería de patrones causales sobre memoria episódica acumulada
- Detecta archivos de alto riesgo, co-ocurrencias problemáticas, precondiciones implícitas
- "Antes de tocar X: correr migraciones (80% éxito cuando se hace)"
- Se activa en Context Guard — ANTES de ejecutar cualquier `aa:`
- Nivel ALTO → interrumpe y muestra advertencia
- Nivel MEDIO → nota en el plan, no interrumpe
- `akdd predict` — ver todos los patrones detectados
- `node grafo.cjs predecir "[tarea]" "[archivos-json]" "[modulo]"` — para agentes

#### 4. CI/CD Integration
- GitHub Actions workflow auto-generado: `akdd ci-install`
- Registra fallos de tests en memoria episódica automáticamente
- Compatible con: GitHub Actions, GitLab CI, Bitbucket, Jenkins
- `akdd ci-status` — últimos 10 reportes CI en memoria
- `akdd ci-report [--success] [--output file]` — llamado por el workflow

### Arquitectura
- `grafo.cjs` — 4 módulos nuevos integrados via lazy loading (sin overhead en arranque normal)
- `schema.sql` — 3 tablas nuevas: `git_context_log`, `cicd_reports`, `prediction_log`
- Migration automática: `ALTER TABLE episodios ADD COLUMN embedding TEXT`
- Todos los módulos: fallback graceful si no están instalados

### CLI
- `akdd sync` → ahora es `akdd sync-v2` (incluye git-context + embeddings)
- `akdd git-context` → análisis de riesgo del working tree
- `akdd predict` → estadísticas del motor de predicción
- `akdd embed-status` / `akdd embed-install` → gestión de embeddings
- `akdd ci-install` / `akdd ci-status` / `akdd ci-report` → CI/CD

### Autonomía
- Antes: L2-L3 (~35-45%)
- Ahora: L3 (~55-65%) — prevención activa + contexto git automático
