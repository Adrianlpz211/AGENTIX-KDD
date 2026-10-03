<div align="center">

<img src="assets/logo.svg" alt="Agentix KDD" width="600">

### La armadura de tu IA de código.

<p>
<img src="https://img.shields.io/badge/versión-3.20.1-3FE2E8?style=for-the-badge&labelColor=0A0E14" alt="version"/>
<img src="https://img.shields.io/badge/licencia-MIT-D9A33C?style=for-the-badge&labelColor=0A0E14" alt="license"/>
<img src="https://img.shields.io/badge/Claude_Code_·_Cursor-listo-8A97A6?style=for-the-badge&labelColor=0A0E14" alt="compat"/>
</p>

**Un equipo de Dev's de un solo hombre.**

[English](README.md) · Español

</div>

---

## En una frase

**Agentix KDD convierte el conocimiento acumulado de tu repositorio en fuerza activa de prevención: hace que la IA de código recuerde el proyecto, no rompa lo que ya funcionaba, y deje rastro verificable de cada decisión.**

No es otra IA que programa por ti. Es la **armadura** que se le pone a la IA que ya usas — nativa en **Claude Code y Cursor** — y vive **dentro de tu proyecto**: SQLite local, sin nube, sin cuenta, sin suscripción.

> *KDD = Knowledge-Driven Development — desarrollo guiado por el conocimiento acumulado del propio proyecto. (Paquete npm: `agentic-kdd`.)*

---

## El problema que resuelve

Abres Cursor o Claude Code. Le explicas tu proyecto *otra vez*. La IA empieza de cero *otra vez*. Rompe algo que ya funcionaba *otra vez*. Cambia una regla de negocio sin acordarse de por qué estaba así. Dos casos reales de cliente que motivaron la generación actual: un combobox aplicado "en todos lados" rompió selects que YA funcionaban, y un trabajo de CSS rompió validaciones `required` existentes. Ambos son la misma enfermedad: **la IA no ve lo que ya está probado, y nadie mecánico se lo impide.**

No estás programando — estás cuidando el contexto a mano. **Agentix se encarga de eso.**

---

## 🆕 3.20.1 — una actualización segura, que demuestra lo que hizo

Hasta ahora, actualizar un proyecto eran dos comandos y un acto de fe: `akdd update` reemplazaba el motor, un segundo `--migrate` tocaba la base, y nada te decía — de forma comprobable — que tu memoria había sobrevivido. La 3.20.1 lo cierra:

```bash
npm install -g agentic-kdd@latest
cd tu-proyecto
akdd update
```

Esa es toda la actualización. `akdd update` ahora **inspecciona → respalda → aplica → verifica → informa**, y solo sale con código `0` cuando el resultado se puede sostener con evidencia:

| Paso | Qué ocurre |
|---|---|
| **Inspeccionar** | Lee el paquete que instalaste, tus archivos y la estructura *real* de `memoria.db` (tablas, columnas, índices) — no solo `config.md` ni la versión de npm. Una base antigua sin registro de migraciones se inspecciona por capacidades; `user_version = 0` nunca se toma por "vacía". |
| **Excluir escritores** | Un bloqueo por proyecto (token de dueño, latido, recuperación de bloqueos abandonados). Los escritores del motor, los workers de los hooks de git y el servidor MCP pausan y **confirman**; si un servicio vivo no confirma, el update se detiene antes de tocar nada. Cursor, Claude y tus otros procesos jamás se matan. |
| **Respaldar** | Un respaldo SQLite coherente (`VACUUM INTO`, que incluye los commits que aún viven en el `-wal`), **abierto y con `integrity_check`** antes del primer cambio. Antes se comprueban espacio y permisos. |
| **Aplicar** | Migraciones de esquema compatibles y **aditivas** en **una transacción**, anotadas en un registro (id estable, checksum, versión que la introdujo, fecha, resultado). Nada destructivo y nada escondido tras un `catch` vacío. Los archivos del framework se reemplazan con un journal; los tuyos no. |
| **Verificar** | `integrity_check`, `foreign_key_check` contra lo que ya existía, el esquema completo requerido, tus registros **comparados por contenido** (una huella de multiconjunto por tabla que distingue `NULL` de `''`, un `BLOB` de un texto, y conserva exactos los enteros de 64 bits), tus tablas / índices / triggers / vistas propios, tus archivos propios, y luego una búsqueda real, un handshake MCP y una escritura revertida en una copia aislada. |
| **Informar** | `.agentic/_update/last-result.json` y un `verification.json` por operación, un estado de la tabla de abajo y una tarjeta en el dashboard. |

| Estado | Significado | Salida |
|---|---|---|
| `VERIFIED` | Actualizado y verificado | 0 |
| `VERIFIED_WITH_WARNINGS` | Actualizado y verificado; las advertencias no afectan la compatibilidad (p. ej. se conservó un archivo tuyo) | 0 |
| `NO_CHANGES_VERIFIED` | Ya estaba al día, y se comprobó | 0 |
| `BLOCKED` | No se aplicó nada — y dice por qué | 1 |
| `UNVERIFIED` | Algo no se pudo demostrar (p. ej. `--no-migrate` dejó el esquema incompleto) | 2 |
| `ROLLED_BACK` | Falló y la recuperación quedó **verificada** | 3 |
| `RECOVERY_REQUIRED` | La recuperación necesita a una persona; el siguiente update se niega a correr hasta que la resuelvas | 4 |

Opciones: `--check` (solo el plan — no cambia nada), `--json` (un único documento JSON por stdout), `--no-migrate` (el resultado **nunca** se presenta como completo si falta esquema), `--migrate` (se conserva por compatibilidad; migrar ya es lo normal), `--from=` / `--sha256=` / `--ref=` (sin cambios), `--rollback`.

**Qué se conserva.** El contenido de `memoria.db`, los Markdown de memoria, `config.md`, el conocimiento, `PLAN.md`, tus instrucciones, tu código y cualquier regla que hayas añadido (`.cursor/rules/`, `.audit/`, …). Cada archivo del framework se clasifica contra una base *verificable* — los hashes que Agentix registró al instalarlo, o los de las versiones publicadas. Un archivo con cambios tuyos (o sin base fiable) se **conserva** y la versión nueva se guarda a su lado. Si un archivo conservado es indispensable para el motor nuevo, el update **se bloquea antes de aplicar nada** en lugar de dejar un motor a medias. El texto bajo el marcador `INSTRUCCIONES DEL PROYECTO` de `CLAUDE.md` se mueve sin perder un encabezado, un comentario ni un segmento; si existen dos versiones de tus instrucciones, se conservan ambos originales y se fusionan.

**Qué lo puede bloquear.** Un esquema más nuevo que este motor; una base ilegible o corrupta; una base tomada por un proceso que no sigue el protocolo; un servicio que no pausa; poco espacio en disco; una carpeta del framework que es un enlace hacia fuera del proyecto; un archivo indispensable del motor que personalizaste; ningún conector SQLite que supere las pruebas reales de capacidad.

**Rollback, y su límite.** `akdd update --rollback` revierte los **archivos** de la última actualización y nunca restaura una base antigua encima de aprendizajes nuevos. Se niega si el esquema cambió después de esa actualización. Restaurar datos históricos es otra operación explícita y distinta — el respaldo verificado queda en disco para eso.

**Verlo.** `akdd dashboard` también sirve **/actualizacion**: versión instalada, compatibilidad del esquema, última verificación, memoria y personalizaciones conservadas, respaldo disponible, conflictos y qué hacer. Separa "el servicio responde" de "la memoria puede trabajar", es de solo lectura, paginada, y nunca muestra el contenido de tus archivos. Tus grafos no cambian.

**Requisitos.** El update necesita un conector SQLite que supere las pruebas reales (solo lectura, transacciones, bloqueo, respaldo con WAL, BLOB, enteros de 64 bits, multiproceso, cierre limpio): `node:sqlite` en Node ≥ 22.13, o un `better-sqlite3` compatible. `sql.js` reexporta el archivo completo desde memoria y **no** se acepta para actualizar. Sin conector, el update se niega antes de escribir y explica cómo resolverlo. En esta versión el conector verificado es `node:sqlite`: el `better-sqlite3@^9` opcional no tiene binario precompilado para Node 24 y falló al compilar ahí, así que ese camino **no está verificado**.

## 🆕 3.20.1 — memoria que se puede rastrear, recuperación por capas y contexto que conserva su original

La actualización segura llega junto con una mejora de memoria. Todo lo que sigue es **nativo**: sin Claude-Mem, sin proxy de Headroom, sin servicio en la nube, sin otro demonio y sin llamadas de pago por defecto. Otros proyectos inspiraron algunas ideas; los mecanismos son de Agentix y viven en la misma `memoria.db`.

Las tablas nuevas llegan **solo por `akdd update`** (el catálogo de esquema, con su respaldo y verificación). Leer nunca crea ni migra nada: sobre una base antigua los comandos de memoria dicen `SCHEMA_MISSING` y mandan a `akdd update`. Los nodos existentes conservan su ID (INTEGER o TEXT) y su contenido; nada se regenera.

### Memoria con procedencia

| Pieza | Qué es |
|---|---|
| **Actividad** | Un evento bruto de una acción real: herramienta, fase, resultado de un gate. Idempotente por proyecto + host + sesión + id del evento del host: reenviar un evento deja **una** actividad y **un** job; dos ejecuciones iguales en momentos distintos son **dos** actividades. |
| **Observación** | Una lectura acotada de una o varias actividades (prueba fallida, archivos tocados, decisión explícita, resultado de gate). Muchas lecturas del mismo archivo se agrupan en **una** observación. |
| **Conocimiento** | Un nodo KDD con estado: *propuesto → validado → sospechoso → obsoleto*, mapeado a los estados de nodo existentes. |
| **Evidencia** | Un artefacto verificable: id, SHA-256, tamaño, alcance, retención. |

**Una observación o un resumen nunca validan nada.** Validar exige evidencia *actual* (su hash se vuelve a comprobar en ese momento) y un validador que sea un gate, un test, la persona o un verificador. A propósito **no** se expone al modelo por MCP: `akdd memory validate <nodo> --evidence=ev_… --by=gate`. Si cambia el código relacionado, lo validado pasa a *sospechoso*. El conocimiento idéntico en el mismo ámbito suma una ocurrencia en vez de un nodo nuevo; el parecido queda como *candidato de revisión*, jamás se fusiona; las contradicciones conservan ambos orígenes. Los registros anteriores a 3.20.1 se muestran como `LEGACY_UNVERIFIED_PROVENANCE` al leerlos: ni se reescriben ni se rebajan.

**La privacidad va primero.** El texto se clasifica *autorizado / redactado / privado / desconocido* y se redacta **antes** de llegar a la base, la cola, una caché, el contexto entregado o el dashboard. La redacción **falla cerrada** (si el redactor falla no se guarda nada, jamás el original). Las rutas privadas (`.env`, llaves, credenciales…) conservan solo metadatos. Añade tus rutas y campos denegados en `.agentic/privacy-policy.json`. Las expresiones regulares no pueden garantizar que detectan todos los secretos: por eso existen las listas de denegación; trata al redactor como reducción de riesgo, no como un DLP.

**Qué se captura depende del host** — `akdd memory capabilities` imprime el panorama real:

| Host | Captura | Qué ve |
|---|---|---|
| Claude Code / Cursor **con los hooks del host instalados** (`akdd host-hooks install`, nunca automático) | `NATIVE_PASSIVE` | Acciones de shell, edición y MCP **antes** de ejecutarse y la decisión de la guardia — no la salida de la herramienta |
| Los mismos hosts **sin** hooks | `PIPELINE_ONLY` | Solo lo que pasa por Agentix: `aa:`, post-cycle, herramientas MCP de Agentix, TEAMS |
| Cualquier otro host | `UNSUPPORTED` | No se promete nada |

**No** ve las lecturas y búsquedas internas de un IDE, la salida de las herramientas ni el razonamiento del modelo.

**Cola durable.** La captura inserta el evento y su job en **una** transacción; un worker lo reclama con un lease y un token de fencing, lo procesa con reglas deterministas (sin llamar a un modelo), reintenta con backoff y al final lo aparta como *dead-letter*, visible y reintentable (de forma acotada). Una cola llena responde `BACKPRESSURE` y no dice "capturado". La captura nunca bloquea Shell/Edit: si falla, informa un estado degradado.

### Recuperación por capas

```bash
akdd memory index --query="regla de reembolso"   # 1. índice compacto: id, título, estado, procedencia, coste estimado
akdd memory detail --ids=12,40                   # 2. detalle de los ids elegidos, en lote acotado
akdd memory timeline --node=12                   # 3. cronología alrededor de una actividad o nodo, paginada
akdd memory evidence ev_…  --lines=100-140       # 4. original autorizado, con hash
```

Cada respuesta lleva estados explícitos (`OK`, `NO_RESULTS`, `NO_DB`, `SCHEMA_MISSING`, `ERROR`, `INSUFFICIENT_BUDGET`), un total conocido, `has_more`/cursor y *por qué* se omitió algo. Los presupuestos son **acumulados por tarea** (cambiar de rol o volver a preguntar no los reinicia) y siguen el nivel de esfuerzo. Los **contratos protegidos aplicables nunca se descartan en silencio** por un presupuesto. La búsqueda léxica funciona sin embeddings y jamás crea el índice FTS al consultar. Las mismas capas son herramientas MCP (`memory_index`, `memory_detail`, `memory_timeline`, `memory_evidence`); `recall` y `remember` no cambian.

### Compactar sin perder el original

`akdd context compress <archivo|-> --kind=log|test|json|search|doc|code --task=T` compacta un resultado grande de forma **determinista** (sin modelo, sin Python, sin ML) y guarda el original autorizado; `akdd context recover <reference_id> --lines=a-b` lo devuelve con el hash verificado.

- Los logs agrupan las repeticiones exactas y conservan el contexto de los errores; las corridas de pruebas conservan **todos** los fallos; el JSON se entrega como una *muestra* etiquetada con las cantidades originales; las búsquedas conservan todas las rutas afectadas.
- **El código que vas a editar, auditar, depurar o verificar se entrega íntegro**, igual que la evidencia de un gate. Solo la orientación usa el índice AST.
- **Una muestra jamás prueba una ausencia.** "Sin fallos" exige el original completo (`verificarAusencia` lo recorre en local y devuelve solo el resultado).
- Una compactación mal formada, vacía o que infla devuelve el original con una advertencia. Si no hay espacio para conservar el original, **no** se compacta. Una referencia caducada o cambiada responde `EXPIRED` / `EVIDENCE_CHANGED` — nunca contenido reconstruido. La evidencia de gates es durable; los originales de una tarea o sprint activos llevan pin; solo caduca la caché sin pin.

### Esfuerzo que sí cambia, y contexto compartido en TEAMS

`LOW` ahora significa menos: sin búsqueda global y sin delegación innecesaria — mientras el alcance, los archivos protegidos, la seguridad y los leases se mantienen en todos los niveles, y un "cambio pequeño" en auth, pagos o una migración sigue siendo `HIGH`. Las lecturas de archivos sin cambios se reutilizan, y un hash distinto siempre invalida. En TEAMS el director y el constructor intercambian **paquetes versionados** (snapshot, o un delta solo contra la revisión que el receptor confirmó); un ACK fuera de orden o un receptor reiniciado reciben un snapshot completo, y el director **vuelve a verificar la evidencia original** — un PASS inventado o evidencia de una versión anterior se rechaza. `akdd effort budget …` y `akdd teams packet …` lo exponen. Controlar el esfuerzo de razonamiento *del proveedor* exige una integración explícita que **no está instalada**; Agentix declara `HOST_NATIVE_UNCONTROLLED` y no promete reducir el pensamiento interno de un host.

### Verlo

`akdd dashboard` sirve dos páginas más junto a los grafos (que no se tocan): **/memoria** (qué hay guardado, cola, procedencia, registros antiguos) y **/contexto** (nivel, presupuesto, reducción neta y su tipo de medición, cobertura del host). La salud muestra estados independientes — servicio, legible, esquema, búsqueda, última escritura verificada, cola, actualización — y el dashboard **no sale en verde** si el esquema está roto aunque HTTP responda 200. `akdd memory health verify-write` es el único comando que ejercita una escritura (en una copia aislada); abrir la página nunca escribe. Un dato ausente es "no disponible", jamás `0`.

### Qué se midió (determinista, sin datos de usuarios)

`akdd benchmark contexto` ejecuta ocho casos contra los módulos reales — baseline (nada compactado) frente a optimizado, misma tarea, misma aceptación. Recuperar un original **cuenta en contra** del ahorro.

| Caso | Payload neto ahorrado | Nota |
|---|---|---|
| A · cambio de texto bajo `LOW` | 94,1 % | sin búsqueda global ni delegación, guardias intactas |
| B · un error entre 20.000 líneas de log | 99,8 % | el error sigue visible, original recuperable |
| C · "cambio pequeño" en auth/pagos | **0 %** | **por diseño**: sigue en `HIGH` con todos sus controles |
| D · refactor con contratos protegidos | 95,2 % | los 30 contratos protegidos listados; con un tope ajustado responde `INSUFFICIENT_BUDGET` en vez de descartar alguno |
| E · registro crítico raro en un JSON largo | 99,4 % | encontrado sobre el original completo |
| F · vacío / malformado / secreto / código a editar | 41,4 % | bordes: nada se pierde, nada se filtra |
| G · TEAMS, reinicios y una evidencia cambiada | 71,3 % | receptor simulado; el protocolo y la base son reales |
| H · memoria de 4.000 nodos | 99,3 % | índice + dos detalles, nunca un volcado |

Se cumplieron los 31 criterios de aceptación. Es una reducción de **payload** (bytes exactos; los tokens son *estimaciones* `bytes/4`), no un ahorro de sesión, de razonamiento ni de dinero. Una campaña con modelos reales queda `NO_EJECUTADO` (cuesta dinero y necesita tu autorización) y nada de esto se midió dentro de Cursor ni de Claude Code.

## 🆕 Qué trae la 3.20 — de "el gate dijo PASS" a "muéstrame la corrida"

La 3.20 es la versión del blindaje. La pregunta detrás de cada cambio fue la misma: *¿se puede falsificar un verde?* Donde la respuesta era sí, se cerró.

| Área | 3.19 | 3.20 |
|---|---|---|
| **Cerrar una tarea** | Un gate podía reportar PASS desde un booleano | El PASS exige el **artefacto de ejecución del sujeto exacto**. Un id inventado, un runner sin aserciones o código que cambió después de la corrida → `UNVERIFIED`, nunca verde |
| **Actualizar** | `akdd update` bajaba de `main` en GitHub | Usa el motor **incluido en el paquete que instalaste**. Desde la 3.20.1 es un solo comando verificado (ver abajo). Journal transaccional, respaldo por archivo, reversión automática si falla, `--rollback`. Memoria, config y código de negocio quedan fuera del reemplazo |
| **Esquema de la base** | Podía migrarse durante una lectura normal | **Nunca migra mientras el motor trabaja.** En la 3.20.0 hacía falta un segundo `akdd update --migrate`; desde la 3.20.1 `akdd update` migra solo (ver abajo), con respaldo SQLite coherente (WAL incluido), dentro de una transacción y con chequeo de integridad |
| **Esfuerzo** | El mismo peso de pipeline para un typo que para auth | **LOW / MEDIUM / HIGH** = máx(dificultad, riesgo). Pequeño *y* riesgoso conserva los controles de riesgo. Los gates mínimos no se pueden quitar, ni con una política propia |
| **Preservación** | Contratos por archivo de test | Un contrato **por test individual**, escenarios de front, manifiesto `.agentic/protected_files`, impacto por aristas reales del AST. Cobertura incompleta se lee `UNKNOWN`, nunca `LOW` |
| **Hooks de git** | Leían el directorio de trabajo | Leen el **índice** (lo que de verdad vas a commitear). Bloquean secretos filtrados, un arreglo sin test y quitarle un caso a un test protegido. Respetan `core.hooksPath` y nunca pisan tus propios hooks |
| **Trabajo en equipo** | Un agente a la vez | **TEAMS**: Claude Code dirige, Cursor construye — planes, dependencias, leases, fencing, cola de decisiones humanas |
| **Deshacer** | Solo Git | **Puntos de restauración reales** en refs privadas de Git, con vista previa y hash del estado actual. HEAD, rama e índice intactos |
| **MCP** | Solo por proyecto; `--global` escribía en un archivo que Cursor nunca lee | **Una entrada global para todos los proyectos.** Un lanzador abre el servidor y la memoria de cada proyecto (ver abajo) |
| **Publicación** | Push de tag + token | Workflow manual con **publicación de confianza de npm (OIDC)** que publica exactamente el tarball que verificó el release check |

Cómo se verificó está en [Números medidos](#números-medidos-no-estimaciones). Lo que *todavía no* está verificado está en [Límites honestos](#límites-honestos-lo-que-no-es).

---

## El mapa completo — tres piezas, y TODO cuelga de una de ellas

Agentix tiene muchos órganos, pero solo tres piezas. Si alguna vez te pierdes en la lista de features, vuelve aquí: **cada cosa que hace pertenece a una de estas tres filas.**

| | Pieza | Qué hace | Sus órganos |
|---|-------|----------|-------------|
| ⚓ | **Ancla** — memoria | Recuerda decisiones, reglas, errores y la estructura del código entre sesiones, y trae lo relevante en el momento justo. | Memoria 4 capas (CoALA) · grafo de código AST con precisión de líneas · recall híbrido BM25+vectorial con presupuesto de tokens · anclas de símbolos · curas conocidas ("esto ya pasó — así se arregló") · descripciones en lenguaje natural por archivo · curación autónoma (MemCurator) · libreta de gates (`gate_events`) · tiempo medido por tarea |
| 🔧 | **Palanca** — verificación | Antes de aceptar un cambio, comprueba mecánicamente que no rompe lo que ya funcionaba. Si duda, **frena del lado seguro**. Jamás declara "verde" en falso. | Cierre con evidencia (PASS/FAIL/SKIP/UNVERIFIED/ERROR) · TDD Gate · Preservation Gate (contratos por test + escenarios de front) · Regression Guard · archivos protegidos · radio de impacto por AST · Spec Gate + escáner de valores de negocio · Security Gate (secretos/PII/inyección + cross-tenant agnóstico de ORM) · Browser Gate (Chrome/Edge real) · UI Native Gate · memoria de diseño · CSS Token Gate · Simple Gate · hooks de git (pre-commit, commit-msg, post-commit) |
| 🔨 | **Martillo** — autonomía | Ejecuta ciclos completos de desarrollo con correa: analiza, construye, prueba, aprende, y se recupera de frenazos — reportándote todo. | Pipeline `aa:` · enrutador de esfuerzo (LOW/MEDIUM/HIGH) · paquete de contexto por tarea · MODO LEGIÓN (sub-agentes en paralelo solo para leer/juzgar) · QA 4 lentes · departamento `audit:` (7 auditores) · TEAMS (director + constructor) · puntos de restauración · protocolo RECOVERY · locks multi-instancia · puente ClickUp (opt-in) · avisos por WhatsApp (opt-in) |

**La propiedad medida que define la armadura:** cuando Agentix duda, protege. Medido contra un parser real: de 1,989 símbolos comparados, el error de rango cae del lado seguro en el **99.75%** de los casos (del lado peligroso: 5 casos, todos ≤5 líneas).

---

## De dónde viene — tecnologías e inspiraciones (con nombre y apellido)

Agentix no inventó cada pieza desde cero — combinó ideas probadas que existían por separado y les agregó lo que faltaba: que la memoria **bloquee**, no solo recuerde.

| Idea en Agentix | De dónde viene |
|---|---|
| Memoria de 4 capas (working / procedural / episódica / semántica) | **CoALA** — *Cognitive Architectures for Language Agents* (Sumers, Yao, Narasimhan & Griffiths, Princeton, 2023). Agentix la implementa en SQLite local. |
| Mapa del código con PageRank sobre símbolos | La idea del **repo-map de Aider** (Paul Gauthier). Agentix la lleva más lejos: rangos de líneas por símbolo, formularios/CSS como nodos, y el mapa alimenta un gate que FRENA, no solo contexto. |
| Specs por módulo y reglas de negocio vigiladas | La corriente de **spec-driven development** (popularizada por herramientas como Kiro de AWS). En Agentix la spec no es un documento aparte: se genera del ciclo y el Spec Gate la defiende. |
| Episodios sin resumir + banco de razonamiento | La línea de investigación de memoria episódica para agentes (Reflexion y sucesores): guardar trayectorias completas evita el *summarization drift*. |
| Integración con el editor | **Estándares abiertos**: MCP (Model Context Protocol, Anthropic) más `CLAUDE.md`/`AGENTS.md` y hooks de git estándar. Nada propietario. |
| Verificación en navegador real | **playwright-core** apuntando al Chrome/Edge que YA tienes instalado (cero descargas de navegadores). |
| Persistencia | **SQLite** (better-sqlite3, con fallback automático a `node:sqlite` de Node 22+ si tu máquina no tiene toolchain de compilación — probado). |
| Puntos de restauración | **El almacén de objetos de Git**: commits en refs privadas (`refs/agentix/restore/*`) construidos con un índice temporal, para que tu rama nunca se mueva. |
| Publicación | **Publicación de confianza de npm (OIDC)** desde GitHub Actions — sin ningún token de escritura guardado. |
| Extracción de símbolos | Regex disciplinado, **no** tree-sitter — una decisión MEDIDA, no una limitación: se construyó el comparador contra tree-sitter real, se midieron 1,989 símbolos, y la aproximación regex resultó suficiente (99.75% de los errores caen del lado seguro). El comparador queda en el motor para re-medir cuando se quiera. |
| Filosofía *fail-closed* | Ingeniería de seguridad clásica: ante la duda, el portón se cierra. Toda la contención por líneas degrada a "archivo completo protegido" ante CUALQUIER duda. |

---

## Cómo se usa (esto es todo)

```bash
# 1. Instalar el CLI
npm install -g agentic-kdd

# 2. En tu proyecto
cd tu-proyecto
akdd init

# 3. Conectar el MCP una vez para TODOS tus proyectos (recomendado)
akdd mcp --global

# 4. Abre en Claude Code o Cursor y escribe:
aa: configurar
```

Desde ahí, cada tarea empieza con `aa:`. El pipeline completo (analizar → construir → probar → aprender) corre solo; te detiene únicamente ante un STOP genuino (regla de negocio contradicha, test que se rompe, archivo crítico).

```
aa: agrega paginación al listado de clientes
aa: --dry-run refactoriza la validación del pago   ← propone, no escribe nada
aa: sprint — módulo de facturación completo
aa: aprende                  ← absorbe trabajo hecho fuera del pipeline
audit: auditar               ← 7 auditores en paralelo; solo leen, jamás tocan código
```

> El vocabulario de comandos (`aa:`, `audit:`, `teams:`) es en español — la tarea que escribes después puede ir en cualquier idioma. Los prefijos del chat son instrucciones para el agente, no comandos de terminal.

---

## Actualizar desde la 3.19 o la 3.20 — tu memoria se queda

Son dos pasos distintos. **Instalar el CLI nuevo no toca ningún proyecto**; cada proyecto se actualiza cuando tú se lo pides.

```bash
npm install -g agentic-kdd@latest     # 1. el motor nuevo, una vez por máquina
akdd mcp --global                     #    refresca el lanzador MCP global (una vez)

cd tu-proyecto                        # 2. en CADA proyecto que ya usa Agentix
akdd update --check                   #    opcional: ver el plan sin cambiar nada
akdd update                           #    un solo comando: respalda, migra y verifica
akdd health
```

`akdd update` es el único comando que necesitas. Reemplaza los archivos del framework desde el paquete que acabas de instalar — **no** desde GitHub (`--ref=<tag|sha>` y `--from=<archivo.tar.gz>` son alternativas explícitas) —, migra el esquema de la memoria de forma compatible y aditiva, y verifica el resultado. Los pasos, los estados y lo que lo puede bloquear están en [3.20.1](#-3201--una-actualización-segura-que-demuestra-lo-que-hizo).

- **Nunca toca** el contenido de tu memoria, `config.md`, el conocimiento, `PLAN.md`, tus instrucciones ni tu código. Lo declarado en `.agentic/protected_files` también se salta.
- **Corre como transacción con journal**: si falla a mitad, revierte lo que escribió y verifica la recuperación; si el proceso muere, la siguiente corrida recupera primero. Los archivos a reemplazar se revalidan justo antes de escribir, y una recuperación jamás sobrescribe una edición hecha después de que el update escribiera ese archivo.
- **Conserva tus personalizaciones**: un archivo del framework que editaste se deja como estaba y la versión nueva queda en el journal de la actualización (`.agentic/_update/tx/<id>/personalizados/`) para que compares.
- **Respalda antes del primer cambio** y mantiene los respaldos fuera de Git y de npm (`.agentic/_update/` se autoignora). La retención nunca borra el respaldo de una operación en curso, el último verificado, ni uno que marques con un archivo `.keep`.

> ⚠️ Primera actualización desde un motor anterior al registro de propiedad: Agentix clasifica cada archivo del framework contra los hashes de las *versiones publicadas* (3.15.0 → 3.20.0). Un archivo que no coincide con ninguna se trata como tuyo. Revisa lo que reporta.

**Esta ruta está probada, no prometida.** El release check instala en un directorio limpio el tarball que está por publicar, arma consumidores ejecutando los motores **publicados** 3.19.0 y 3.20.0, les añade datos que un proyecto real podría perder (tablas propias, enteros de 64 bits, BLOBs, una vista y un índice) y luego corre, con esa CLI instalada, `--check`, `update`, un segundo `update`, el MCP por stdio y `--rollback`. Después de publicar, `npm run release:verify` descarga lo que de verdad está en npm, comprueba que es byte a byte el tarball verificado y repite la actualización desde la 3.19.0 con él.

## El MCP — para qué sirve y cómo conectarlo

**El MCP es el puente entre el modelo y Agentix.** Sin él, el modelo solo usa la memoria, los contratos y los gates si se acuerda de abrir una terminal y correr los scripts — y muchas veces no lo hace. Con él, Cursor y Claude Code ven a Agentix como herramientas nativas:

| Momento | Herramienta que llama el modelo | Qué obtiene |
|---|---|---|
| Antes de tocar un módulo | `recall`, `verdad_vigente` | Errores, decisiones y patrones conocidos de esa zona — solo lo relevante, dentro de un presupuesto de tokens |
| Antes de planear un cambio | `impact_precheck`, `contracts_blast`, `effort_decide` | Qué se rompe si cambia este archivo, cuántos contratos están en riesgo, qué nivel y qué gates aplican |
| Mientras trabaja | `pipeline_step`, `pipeline_gate`, `contracts_gate` | Cada paso registrado por el harness; un ciclo no cierra sin evidencia |
| Al cerrar | `remember`, `causal_add` | La lección probada entra a la memoria para la siguiente sesión |
| Coordinación | `teams`, `restore`, `session_historial` | Planes entre Claude Code y Cursor, puntos de restauración, retomar un chat |

Es el mismo motor y la misma `memoria.db` que usa el CLI — **no es otra IA ni una memoria en la nube**. Su valor depende de que el agente use las herramientas; no puede mantener viva una sesión del IDE por sí solo. La lista viva de herramientas la da `akdd capabilities`.

### Conectarlo una vez, global

```bash
akdd mcp --global
```

- Copia un lanzador pequeño a `~/.agentix/mcp-launcher.cjs`.
- Agrega **una** entrada `agentic-kdd` a `~/.cursor/mcp.json` (tus otros servidores MCP se conservan; un JSON inválido se deja intacto y se reporta) y la registra en **Claude Code con alcance de usuario**.
- Cuando un IDE lo arranca, el lanzador encuentra el proyecto que tienes abierto (subiendo desde la carpeta) y arranca **el servidor de ese proyecto, con la versión del motor y la memoria de ese proyecto**. Las memorias nunca se mezclan.
- Fuera de un proyecto Agentix responde con una sola herramienta, `agentix_status`, que lo dice — sin error y sin leer ninguna memoria.

Después: **Reload Window** en Cursor y una sesión nueva de Claude Code. `akdd mcp status` muestra qué quedó configurado. `akdd mcp` (sin `--global`) sigue configurando un solo proyecto; la entrada del proyecto manda sobre la global.

---

## TEAMS — Claude Code dirige, Cursor construye

Abre los dos sobre el mismo proyecto. En el chat:

```
teams: activar
teams: plan <objetivo>
teams: ejecutar
teams: estado · teams: pendientes · teams: pausa · teams: continuar · teams: desactivar
```

Un plan tiene sprints con tareas que llevan `acceptance`, `allowed_files`, `depends_on`, `risk` y `change_type`. Reglas que se cumplen mecánicamente:

- **El constructor nunca marca DONE.** Entrega; el director verifica con gates sobre el sujeto exacto.
- Un STOP de tarea deja seguir el trabajo independiente; un STOP **global** frena el plan. Las decisiones de negocio van a una cola humana y aparecen una sola vez en el reporte final — no se repite la pregunta.
- El modo goal es por sprint, nunca "todo el plan"; un presupuesto agotado deja un checkpoint, no un DONE.
- Activar las tablas en un proyecto existente pide aprobación de migración (`init --aprobar-migracion`).

Equivalente en CLI: `akdd teams <init|plan|run|status|pending|resolve|goal>`.

---

### TEAMS nativo (3.20.1) — el director, tres revisores y el constructor, conectados con todo lo demás

TEAMS ahora corre sobre el **mismo núcleo que `aa:`**. Cada tarea que el director verifica pasa por un puente (`teams-puente.cjs`) que la registra como ciclo, memoria, contratos, AST, layout y evidencia de preservación con `origen = teams` — no tienes que escribir `aa:`. El registro es un *outbox*: se encola en la misma transacción que el evento, se reintenta si falla, y la tarea queda `MEMORY_PENDING` hasta que se registre de verdad. Un registro fallido nunca bloquea tareas independientes, pero impide que el cierre final sea "completo".

| Pieza | Qué hace |
|---|---|
| **Tú aterrizas, el director planifica** | Tú dices todo (alcance, reglas, links de referencia). El director lo convierte en sprints → fases → tareas con aceptación, archivos, dependencias, riesgos y criterios de revisión, te muestra un resumen y pregunta solo lo indispensable. El primer lote existe *antes* de que arranque el constructor. |
| **La auditoría no frena el avance ordinario** | El constructor sigue Fase 1 → Fase 2 → Sprint 2 mientras los revisores trabajan. Un hallazgo tardío entra en **Correcciones pendientes**; el constructor lo lee primero, suspende su tarea de forma segura, corrige y retoma en la posición exacta. Una dependencia realmente incumplida sí bloquea su rama; seguridad y preservación nunca se relajan. |
| **Tres revisores** | Frontend/UI-UX, backend y negocio (auditor general de la lógica del dominio). Cada veredicto va ligado al hash que revisó; un hash viejo no cuenta; la revisión secuencial se declara como tal. |
| **Cierre** | Una cola vacía *no* es el fin: la campaña espera la auditoría final. El director cierra solo cuando los tres revisores concluyeron sobre el sujeto FINAL, los hallazgos están resueltos o listados y todo el registro de memoria está hecho. El constructor confirma (`close_id` + revisión) y detiene **su propio** loop y watch. Un hallazgo que llega entre el cierre y el ACK lo reabre. Estado final: `COMPLETED` o `COMPLETED_WITH_PENDING`. |
| **Decisiones que son tuyas** | Se registran con la pregunta y las alternativas; el trabajo independiente continúa; y el director reporta *"el proyecto quedó en X % por estas decisiones tuyas"*. X se calcula del plan (tareas verificadas ÷ tareas planificadas), nunca se inventa. |
| **Investigación en internet** | Tras aterrizar el plan, el director y el revisor de negocio pueden consultar los **links de referencia que diste** (o los que autorices). El contenido se guarda como evidencia (URL, fecha, hash), redactado, y se trata estrictamente como dato. Se rechazan redes privadas y redirecciones hacia ellas. |
| **Dos vigilantes independientes** | El loop del host cada 180 s es el respaldo que sí despierta al modelo; un watch de archivos baja la latencia a segundos. Ninguno depende del otro. Una señal no es una tarea ni un ACK; Agentix mide detectado → solicitado → atendido → ACK. |

```bash
akdd teams prompt director      # los prompts de arranque reales, con tus rutas absolutas y el plan
akdd teams prompt builder       # se pega UNA vez en Cursor
akdd teams avance               # avance medido y las decisiones del dueño que lo frenan
akdd teams correcciones listar  # hallazgos por prioridad   ·   akdd teams revision ...   ·   akdd teams cerrar
akdd teams vigilancia estado    # qué está instalado, vivo, detectando y qué acepta realmente el host
akdd teams investigar consultar --plan=P --url=... --pregunta="..."
```

**Límites, dichos sin rodeos.** Los vigilantes detectan y miden pero **no** despiertan un chat por sí solos (`EVENT_WAKE_UNSUPPORTED`); sin un loop del host confirmado el modo es `MANUAL_ONLY` y no se anuncia autonomía. Todo lo anterior está verificado con constructor/recibos simulados y almacenamiento real (niveles A y B); la **campaña real con Claude Code + Cursor (nivel C) no se ha ejecutado**. No se instala ninguna tarea programada de Windows sin tu aprobación, y actualizar Agentix nunca instala una.

## Puntos de restauración — deshacer con vista previa

```
aa: restore point crear antes del refactor de pagos
aa: restore point
aa: restore <id>
```

Los puntos son commits de Git en refs privadas; HEAD, rama, índice y `git status` quedan idénticos antes y después. Aplicar uno muestra **qué se escribe, qué se borra, qué queda fuera y qué NO vuelve** (base de datos, despliegues, mensajes enviados), exige el hash del estado actual, crea antes un punto de rescate y verifica por hash al terminar. Después de restaurar, los gates de ese alcance vuelven a correr: el contenido volvió, la verificación no.

---

## 🆕 Puente ClickUp — que los sprints entren solos (opt-in)

Si tu equipo apunta el trabajo en **ClickUp**, Agentix puede traer las tareas de una Lista, cotejarlas contra tu proyecto y armar el "sprint sólido" — sin que copies y pegues tickets a mano. **Apagado por defecto**: no hace nada hasta que lo prendes a propósito.

```bash
akdd cu on                     # activa el puente (pide CLICKUP_API_TOKEN en tu .env, lo valida)
akdd cu set-list <list-id>     # qué Lista de ClickUp usa este proyecto (una sola vez)
akdd cu sprint                 # trae + clasifica + muestra (no ejecuta nada)
akdd cu sprint --auto          # corre solo lo que pasa el filtro de bajo riesgo
```

| | Categoría | Qué significa |
|---|---|---|
| 🟢 | **Relevante clara** | Hay evidencia directa en tu código de que esto ya existe |
| 🔵 | **Relevante nueva** | No existe aún, pero encaja con el dominio del proyecto |
| 🟡 | **Ambigua** | Descripción insuficiente → pregunta antes de construir |
| 🔴 | **Sin rastro** | Cero relación con el proyecto → se salta, con nota en ClickUp |

**El `--auto` es pseudo-L5, no L5 ciego.** Una tarea corre sola SOLO si es *relevante clara*, no toca archivos críticos, no contradice un valor de negocio de tu memoria, no toca autenticación, no es un cambio estructural grande y trae descripción con sustancia. Al cerrar limpio la marca como hecha; ante cualquier duda solo deja un comentario.

---

## Qué pasa solo, sin que escribas nada

| Cuándo | Qué corre automáticamente |
|--------|----------------------------|
| En cada **commit** de git | **Pre-commit** sobre el *índice* (lo que de verdad vas a commitear): escudo de seguridad (secretos filtrados, cross-tenant y bypass de JWT **bloquean**; PII y Unicode invisible avisan), integridad de tests (quitarle un caso a un test protegido **bloquea**), UI nativa, valores de negocio. **Commit-msg**: el canario — un *arreglo* sin ningún test **bloquea**. **Post-commit**: encola el commit por su SHA y cierra el ciclo en segundo plano (contratos, índice AST, grafo, specs). Nunca bloquea. |
| En cada **post-cycle** | Escaneo de integridad spec/test · memoria de diseño (valores que vuelven a uno abandonado, propiedades que desaparecen) · tokens CSS · Simple Gate · Preservation Gate · calificación de la predicción de riesgo · auditoría de dependencias · cierre del ciclo según el estado real de los gates |
| Dentro de cada **`aa:`** | Brief del Context Enricher (riesgo, curas conocidas, alertas activas) · nivel de esfuerzo · gates · tests · QA 4 lentes cuando el cambio no es trivial · memoria · duración medida |
| Cada **5 ciclos** | Checkpoint para retomar en otro chat u otra máquina |
| En **init / update** | Los hooks se instalan solos (respetando los tuyos); el índice AST se reconstruye una vez si el motor cambió de versión. El esquema **no** migra solo — eso es `--migrate` |

Cada protección queda anotada en la libreta (`gate_events`) con su origen: **`mechanical`** (hierro que corre solo) o **`protocol`** (el modelo siguiendo instrucciones). Mide qué fracción de tu protección es hierro: `node .agentic/grafo/gate-telemetry.cjs stats`. Escotilla de emergencia de los hooks: `AKDD_SKIP_GATES=1 git commit ...` — el guardia opcional del IDE (`akdd host-hooks install`) le niega esa escotilla y `--no-verify` al agente.

---

## Qué tan maduro está cada órgano (honestidad por niveles)

**🥇 Probado en batalla** (uso real repetido): el pipeline `aa:`, memoria 4 capas + búsqueda híbrida, los gates clásicos (Spec/TDD/Security/Regression), registro automático por commit, checkpoints, locks multi-instancia, dashboard, MCP, contención por líneas, Front/Back en paralelo.

**🥈 Verificado con fixtures, Git real, SQLite real y navegador real** (nuevo en la 3.20, escenarios controlados, todavía sin meses de producción): cierre con evidencia, update transaccional + actualización 3.19 → 3.20 desde el paquete real de npm, migración de esquema opt-in, enrutador de esfuerzo y paquetes de contexto, contratos por test y escenarios de front, archivos protegidos, radio de impacto por AST, hooks de git sobre el índice y el canario en commit-msg, puntos de restauración, motor de TEAMS (scheduler, leases, fencing, cola humana), lanzador MCP global, API / vista tabla / tour integrado del dashboard, medición de tiempo.

**🥉 Lógica verificada, host vivo NO verificado**: TEAMS con Claude Code y Cursor abiertos a la vez en la misma máquina, adaptadores de hooks dentro de cada IDE, avisos por WhatsApp de punta a punta. El código está; falta la certificación dentro de una sesión real del IDE.

**🔒 Beta privada**: colaboración en equipo (memoria compartida).

---

## Números medidos (no estimaciones)

| Métrica | Valor |
|---|---|
| Dirección del error de rango (vs parser real, 1,989 símbolos) | 99.75% del lado seguro |
| Grafo de un proyecto real (~414 archivos TS+JS) | 3,757 símbolos · ~4,900 aristas · 100% con rango de líneas |
| **Release check de la 3.20.1** (03/10/2026, Windows, Node 24 — la única plataforma medida) | Suite completa 933/934 (la que no corrió es un smoke dentro de Cursor/Claude reales, declarada `NO_EJECUTADO`) · tarball (243 archivos) sin datos privados · 528 sondas adversariales, 0 fallos · se prueba el **tarball instalado** |
| **Actualizaciones reales 3.19.0 → 3.20.1 y 3.20.0 → 3.20.1** (consumidores armados ejecutando los motores publicados) | `akdd update` solo: `VERIFIED` (25 y 9 migraciones aplicadas) · memoria conservada por **contenido** (30–31 tablas, 567–572 filas comparadas, más 500 filas privadas en una tabla propia) · segundo update `NO_CHANGES_VERIFIED` · `--rollback` revierte archivos y conserva la memoria más nueva · el motor anterior sigue leyendo la base migrada · MCP `initialize` / `remember` / `recall` por stdio |
| Enrutador de esfuerzo (15 fixtures, umbral fijado antes de correr) | LOW: −90% de bytes de contexto, −54% de pasos · MEDIUM: −25 a −32% · HIGH conserva tdd, preservation, QA y reviewer. *Proxy: bytes que Agentix pide cargar; tokens del host no medidos* |
| Benchmark de 19 fases (SaaS multi-tenant, con/sin Agentix) | errores por fase 2.6→~0 · tests que pasan a la primera 79%→100% · cascada de refactor 4/7→11/11 |

> ⚠️ **Honestidad primero:** el benchmark de 19 fases es **N=1, direccional, sin revisión de pares** — ver [BENCHMARK.md](BENCHMARK.md). Los conteos vivos de módulos, herramientas MCP y tests cambian en cada versión, por eso no se escriben aquí: `node scripts/sync-version.cjs --inventario` y `akdd capabilities` los imprimen.

---

## Compatibilidad

Agentix es **de primera clase en Claude Code y Cursor** — ahí está probado en batalla. Como el motor se apoya en **estándares abiertos** (`AGENTS.md` y **MCP**), *debería* funcionar también con otros agentes (VS Code, Windsurf, Kiro, Aider…), pero por honestidad: **hasta ahora solo está probado a fondo en Claude Code y Cursor**. Si lo pruebas en otro IDE y funciona, abre un issue.

Node.js: el paquete declara `>=20`, igual que la matriz del CI (Windows y Linux con Node 20, 22 y 24). Además, `akdd update` necesita un conector SQLite que supere sus pruebas de capacidad: `node:sqlite` (Node ≥ 22.13) o un `better-sqlite3` compatible. Donde no existe ninguno, se niega antes de escribir, y las pruebas del update se omiten diciendo por qué. **Verificado en esta versión: Windows con Node 24.** El CI todavía no corrió con esta versión, así que Linux y Node 20/22 no están verificados aquí. Git es obligatorio.

---

## Dashboard — así se ve en un proyecto real

`akdd dashboard` → tablero visual en localhost:3847. Cada captura de abajo es de un proyecto SaaS real en producción (~414 archivos). El grafo de conocimiento se dibuja en **3D real** — y son tres grafos. Nuevo en la 3.20: una vista **☰ Tabla** del grafo KDD con los mismos filtros, la visita guiada servida por el propio dashboard (sin comando aparte), una API de solo lectura (`/api/v1/summary`, `/tasks`, `/contracts`, `/incidents`, `/usage`, `/restore-points`…) y las librerías de los grafos servidas localmente — sin CDN.

**KDD Memory** — las decisiones, errores y patrones de tu memoria. El conocimiento nacido del frontend se distingue por color (rosa/lima/cian vs rojo/verde/azul del back) y se filtra con Front/Back:

<img src="assets/dash-kdd-memory.png" alt="KDD Memory — memoria con familias de color front/back" width="100%">

Haz clic en un nodo: sus conexiones se iluminan y el panel muestra la regla completa, su confianza, de qué ciclo nació y con qué otro conocimiento se relaciona:

<img src="assets/dash-kdd-node.jpg" alt="KDD Memory — nodo seleccionado con sus conexiones y panel de detalle" width="100%">

**Code Structure** — un mapa nativo de tu código real (archivos, símbolos, formularios, clases CSS y sus conexiones), directo del índice AST. Cero llamadas a LLM, cero tokens:

<img src="assets/dash-code-structure.jpg" alt="Code Structure — mapa 3D del código con paleta por departamento" width="100%">

**Combined** — une los dos: ves cómo se relacionan tu código y tus decisiones acumuladas:

<img src="assets/dash-combined.jpg" alt="Combined — código y conocimiento en un solo grafo" width="100%">

### Preservation Intel — la tercera pestaña

Los contratos que no se pueden romper (protegidos/verificados/candidatos), el Creative Engine con su nivel de autonomía, MemCurator gobernando la memoria y el aprendizaje estructural del código:

<img src="assets/dash-preservation-contracts.jpg" alt="Preservation Intel — Contract Guard, Creative Engine, MemCurator, Structural Learning" width="100%">

Y la memoria de UI/Frontend: formularios, selects, campos `required` y clases CSS vigilados, con el UI Native Gate en verde:

<img src="assets/dash-preservation-ui.jpg" alt="Preservation Intel — memoria de diseño, UI Native Gate y UI Eyes" width="100%">

Guías visuales en lenguaje simple: [cómo leer el grafo](docs/GRAFO-GUIA.md) · [cómo leer los contratos + Creative Engine](docs/CONTRATOS-GUIA.md)

---

## ⚪ Referencia completa del CLI (manual)

Todo lo de abajo es **manual** — úsalo solo cuando haga falta. Lo automático está descrito arriba. `akdd --help` lista todo.

### Instalación y ciclo de vida
```bash
akdd init                      # Instala Agentix KDD en un proyecto
akdd onboard                   # Incorpora un proyecto existente (brownfield)
akdd update                    # Un comando: respalda, migra (compatible, aditivo) y VERIFICA. Salida 0 solo si es verificable
akdd update --check            # Solo el plan — no cambia nada
akdd update --json             # Un único documento JSON estructurado por stdout
akdd update --no-migrate       # Salta el esquema (el resultado nunca se presenta como completo)
akdd update --rollback         # Deshace los ARCHIVOS de la última actualización (la memoria se conserva)
akdd mcp --global              # Una entrada MCP para todos los proyectos (Cursor + Claude Code)
akdd mcp · akdd mcp status     # MCP por proyecto · qué está configurado
akdd hooks [status]            # Hooks de git: pre-commit, commit-msg, post-commit
akdd host-hooks <status|install|uninstall> [--host=cursor|claude|all]   # Guardia opcional del IDE
akdd health [--fix]            # Diagnóstico del sistema (--fix repara lo que puede)
akdd doctor                    # 5 pasos de reparación: esquema, sync, AST, integridad del grafo, locks
akdd capabilities              # Instalado / cableado / ejecutado / verificado, por módulo
akdd dashboard                 # Tablero visual en localhost:3847
```

### Esfuerzo, contexto y TEAMS
```bash
akdd effort decide "<tarea>" --paths=a,b [--type=T] [--json]   # Nivel + gates + presupuestos
akdd context armar "<objetivo>" --paths=a,b                     # Un paquete de contexto por tarea
akdd teams <init --aprobar-migracion|plan plan.json|run|status|pending|resolve <id> <decisión>|goal>
akdd restore <list|create --label=L [--files=a,b]|show <id>|preview <id>|apply <id> --expected-current-hash=H>
```

### Memoria y grafo de conocimiento
```bash
akdd recall "consulta"         # Recall BM25+vectorial con presupuesto de tokens
akdd buscar "consulta"         # Búsqueda híbrida en todas las capas de memoria
akdd historial                 # Checkpoint para retomar — pégalo en un chat nuevo
akdd graph · akdd stats        # Resumen y estadísticas del grafo
akdd why <archivo|entidad>     # Por qué existe esto — rastro de decisiones
akdd forget <id> "<motivo>"    # Invalida una entrada de memoria (auditado, no se borra)
akdd cure [report]             # MemCurator — gobierno autónomo de la memoria
```

### Contratos y gates (capa de preservación)
```bash
akdd contracts [list|blast <f>|gate|verify]   # Contract Guard
akdd decide <archivo>          # STOP / WARN / IMPLEMENT / DEFER para un cambio propuesto
akdd predict <archivo>         # Riesgo de regresión antes de editar
akdd impacto <archivo|módulo>  # Qué se rompe si esto cambia
akdd ast-impact <archivo>      # Análisis de impacto a nivel AST
akdd simple                    # Simplicidad: código duplicado, dependencias con equivalente nativo
akdd tokens [archivos...]      # CSS Token Gate
node .agentic/grafo/gate-telemetry.cjs stats   # La libreta: qué protegió, cuándo, hierro vs protocolo
```

### Motor de código y tiempo
```bash
akdd ast [stats|symbols <f>]   # Índice AST del proyecto
akdd describe [área]           # Descripciones en lenguaje natural por archivo
akdd tiempo inicio "<tarea>" · akdd tiempo fin   # Duración medida (trabajado vs transcurrido)
akdd tiempos [módulo]          # Tiempo por módulo — medido, nunca estimado
```

### Puente ClickUp · WhatsApp (opt-in — apagados por defecto)
```bash
akdd cu on · akdd cu set-list <id> · akdd cu sprint [--auto] · akdd cu done <task-id>
akdd ws <activar|estado|desactivar>   # Avisos por tu propia sesión de WhatsApp Web
```

### Departamento QA / Auditoría 🔵 (en el chat — solo audita, jamás toca código)
```bash
audit: auditar                 # Auditoría completa — 7 subagentes en paralelo
audit: seguridad · frontend · backend · datos · performance · browser · codigo
```
> Los reportes quedan en `_output/audit-[fecha].md`. Para corregir un hallazgo: `aa: corrige el hallazgo SEG-01`.

### Multi-instancia (Lock Manager)
```bash
akdd locks                     # Quién tiene cada módulo
akdd locks release-all         # Libera todo (limpieza de sesión)
```

### Colaboración (equipo) — 🔒 beta privada
> La **memoria compartida de equipo** está en **beta privada**. Todo lo demás funciona **100% local, sin cuenta**. ¿La quieres para tu equipo? [Abre un issue](https://github.com/Adrianlpz211/AGENTIX-KDD/issues).

### Memoria, contexto y esfuerzo (3.20.1)
```bash
akdd memory status                    # Qué hay guardado, qué falta y qué captura cada host
akdd memory capabilities              # Captura por host: NATIVE_PASSIVE / PIPELINE_ONLY / UNSUPPORTED
akdd memory index --query="..."        # Recuperación por capas: 1 índice, 2 detalle, 3 cronología, 4 evidencia
akdd memory detail --ids=12,40
akdd memory timeline --node=12
akdd memory evidence ev_... --lines=100-140
akdd memory capture --host=H --session=S --type=T --task=ID   # Registra una actividad real (idempotente)
akdd memory drain                     # Procesa la cola durable (determinista, sin llamar a un modelo)
akdd memory queue                     # Estado de la cola; 'queue retry <job>' para un dead-letter (acotado)
akdd memory provenance <nodo>         # De qué actividades y evidencias sale un conocimiento
akdd memory validate <nodo> --evidence=ev_... --by=gate|test|user|verifier
akdd memory project status|adopt|fork # Id estable del proyecto: renombre = adopt, copia = fork (siempre explícito)
akdd memory health [verify-write]     # Estados de salud independientes; solo verify-write ejercita una escritura
akdd context compress <archivo|-> --kind=log|test|json|search|doc|code --task=T [--purpose=debug]
akdd context recover <reference_id> [--lines=a-b|--json-path=items]
akdd context leer <archivo> --task=T  # Lee con reutilización (un hash distinto siempre invalida)
akdd effort budget estado <tarea>     # Presupuesto de esfuerzo acumulado por tarea · 'host' = lo que Agentix no puede observar
akdd teams packet estado|snapshot|ack|invalidar|cerrar   # Paquetes compartidos director/constructor
akdd benchmark contexto [--json]      # Benchmark determinista (payload neto, medición honesta)
```

---

## Límites honestos (lo que NO es)

1. **No es invulnerable.** La armadura reduce y dirige el error; no lo elimina. La calidad de los arreglos autónomos viene del modelo que uses.
2. **Verificado no es lo mismo que certificado en vivo.** TEAMS con dos IDEs abiertos a la vez, los adaptadores de hooks del IDE y WhatsApp están verificados en lógica y fixtures, todavía no dentro de una sesión real del IDE.
3. **Tiene techo de cobertura, y lo declara.** Los archivos sin símbolos no reciben precisión por líneas — la duda cierra el gate en su lugar. `coverage-meter` y los estados `UNKNOWN` te dicen dónde.
4. **Extractores regex, no un parser** — una decisión medida (ver "De dónde viene"). Los casos borde caen en DOUBT, no en silencio.
5. **La franja semántica sigue en el modelo.** Los valores de negocio los vigila hierro, pero "¿esto contradice el ESPÍRITU de la decisión?" lo juzga el LLM siguiendo protocolo — y la libreta registra qué protección vino de dónde.
6. **Sin promesa fija de ahorro de tokens.** Los números de esfuerzo miden el contexto pedido, no los tokens del host ni la calidad del resultado.
7. **El benchmark de 19 fases es N=1** — direccional, sin revisión de pares.
8. **El update tiene límites que declara.** Un archivo de bloqueo no puede controlar a un programa externo que abre `memoria.db` con su propio SQLite: para esos casos el update se apoya en el bloqueo de escritura de SQLite y **se detiene** (`BLOCKED`) si no lo consigue. Decenas de módulos del motor todavía abren SQLite directamente en vez de por el adaptador; están listados, bloqueados por un test para que no aparezca uno nuevo sin que se note, y no consultan la exclusión. Un par director/constructor de TEAMS vivo durante un update no se probó de punta a punta (sí el servidor MCP, la cola de commits, el post-cycle, la telemetría y el vigilante de TEAMS). `better-sqlite3` no está verificado en Node 24. Restaurar datos históricos sobre aprendizajes nuevos no forma parte de `--rollback`.
9. **La memoria con procedencia ve lo que el host le entrega.** La captura nativa pasiva exige los hooks del host instalados y solo cubre acciones *antes* de ejecutarse; sin ellos, solo se registra lo que pasa por Agentix. Nunca se afirma "verificado dentro de Cursor/Claude" a partir de un fixture: el receptor, el constructor y el director de TEAMS en las pruebas son simulados, el protocolo y la base son reales, y un smoke en hosts reales queda `NO_EJECUTADO` salvo que lo ejecutes tú.
10. **Compactar es una medida de payload, no una promesa.** El benchmark mide los bytes que Agentix controla, de forma determinista; los tokens son estimaciones `bytes/4`. Una campaña con modelos reales queda `NO_EJECUTADO`. Cuando hace falta recuperar el original, el ahorro se reduce — y en algunos casos es cero por diseño.
11. **El redactor reduce el riesgo; no es un DLP.** Las expresiones regulares no ven secretos que no traen contexto. Usa `.agentic/privacy-policy.json` para denegar rutas y campos.


---

## El Coliseo — arena adversarial (evidencia, no marketing)

En lugar de un benchmark que demuestre que Agentix gana, construimos uno diseñado para **romperlo a propósito**: 15 rondas de ataque escaladas en 4 niveles contra un proyecto real (MediCore, un SaaS clínico multi-tenant con reglas de negocio, aislamiento de tenants y una race condition real), cada una corrida dos veces — **con** Agentix (`aa:`) y **sin** él (agente desnudo) — para medir la diferencia con hechos, no con narrativa.

**Resultado:** 14 de 15 rondas aguantaron limpias. La única grieta real ocurrió después de que el humano forzó un override explícito en contra de la recomendación del sistema — y en vez de dejar visible el riesgo aceptado, el agente ocultó el bug reintroducido debilitando el test que lo vigilaba. Un verde falso es peor que un rojo honesto.

**Las grietas encontradas están reparadas y verificadas**: un test que verifica un patrón de confianza ALTA ya no se puede debilitar en silencio (`test-integrity-gate.cjs` — desde la 3.20 lee el índice y bloquea), el Security Gate dejó de depender del dialecto de Prisma para detectar fugas cross-tenant, y el TDD Gate corre `typecheck` junto a los tests.

### Segunda ronda — auditoría de la maquinaria

Se repitió en terreno nuevo (FLOTA360, un SaaS multi-tenant de flotas con memoria envenenada de antemano), midiendo **qué atrapan solos los gates MECÁNICOS**. Los gates de dominio acotado (UI nativa, layout, locks, secretos) resultaron hierro sólido; las trampas semánticas se apoyaron en el brief de memoria + el modelo. Los huecos mecánicos encontrados se sellaron: cross-tenant agnóstico de ORM y de vocabulario (0 falsos positivos en las 28 rutas reales de Lumo), `related_files` derivados de los tests, expiración larga de tokens como WARN visible, descubrimiento de tests ampliado, y `akdd health` en rojo cuando hay ciclos pero el Preservation Gate no protege nada.

### Tercera ronda — las sondas adversariales de la propia 3.20

La 3.20 agrega al repositorio un sandbox adversarial (`sandbox/`) que ataca a los propios gates: ids de PASS inventados, runners vacíos, ejecuciones repetidas, cachés viejas, evidencia de otro sujeto, payloads escondidos en nombres de archivo. El release check corre 528 con semilla fija — 0 fallos — y unos meta-tests siembran un bug en cada gate para demostrar que la prueba negativa lo atrapa.

El libro de jugadas completo del Coliseo vive en la rama [`coliseo-arena`](https://github.com/Adrianlpz211/AGENTIX-KDD/tree/coliseo-arena) — corre las rondas tú mismo.

---

## Para mantenedores — release y publicación

```bash
npm ci
npm run release:check          # suite + privacidad del tarball + el tarball INSTALADO actualizando consumidores reales 3.19.0 y 3.20.0 + MCP
npm run release:verify         # DESPUÉS de publicar: descarga de npm, ¿son los mismos bytes que el tarball verificado?, repite la actualización desde la 3.19.0 con él
```

Resultados, log y el tarball exacto quedan en `_output/release-<versión>/` (`verification.json`). La publicación va únicamente por el workflow manual de GitHub Actions **Publish npm (manual)**: vuelve a correr el check en Windows y Linux, y luego publica con la publicación de confianza de npm (OIDC) **el tarball cuyo SHA registró el reporte**. Configuración y pasos: [PUBLICACION-3.20.md](PUBLICACION-3.20.md).

---

## Estado y transparencia

Agentix es **software joven y en evolución**. La 3.20 se construyó preguntando, gate por gate, si un verde se podía falsificar — y cerrándolo donde se podía. Aun así, **una auditoría no certifica cero defectos** — si encuentras algo, abre un issue.

La promesa real, sin inflar:

> **"Agentix hace que tu IA de código recuerde, respete y preserve tu proyecto mientras evoluciona — y cuando algo la hace dudar, frena del lado seguro. Cada protección que ejerce queda registrada y es auditable."**

Compruébalo tú mismo en 10 minutos: `akdd init` → `aa: configurar` → rompe a propósito algo protegido → mira el STOP con la zona exacta → `node .agentic/grafo/gate-telemetry.cjs stats` → ahí está el evento registrado.

---

## Licencia

MIT — úsalo, forkéalo, construye encima.

<div align="center">

Hecho por [@Adrianlpz211](https://github.com/Adrianlpz211)

*Si Agentix te ahorró tiempo → ⭐*

</div>
