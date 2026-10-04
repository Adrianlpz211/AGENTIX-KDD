# Matriz de requisitos — Agentix 3.20.1

Matriz requisito → prueba. Cada 'titulo' es un fragmento del título de un test que EXISTE (test/matriz-requisitos.test.cjs lo comprueba). 'alcance' dice qué clase de evidencia es: proceso real (SQLite real, procesos node reales), fixture (datos de prueba etiquetados), simulado (receptor/constructor/director simulados), host real NO_EJECUTADO (no se probó dentro de Cursor/Claude Code). Implementado no es verificado, y verificado no es publicado.

**Último release check:** PASS · win32 · Node n/d · artefacto `agentic-kdd-3.20.1.tgz` sha256 `9c5499d2ad2457045223939102166e26346bcf3d52936755a175f52d12b22f6a` · 2026-10-03T21:41:49.306Z

El informe dice en qué plataforma y Node corrió: **no se infiere de otras**. Linux y Node 20/22 están en la matriz de CI y no se ejecutaron en esta máquina.

## C01 (14 requisitos)

| Id | Requisito | Prueba (archivo › título) | Alcance | Nota |
|---|---|---|---|---|
| C01-1 | Reenviar un mismo evento deja una actividad y un job | `memory-core` › C01-1: | proceso real |  |
| C01-2 | Dos eventos reales de payload igual conservan dos actividades | `memory-core` › C01-2: | proceso real |  |
| C01-3 | Crear una observación no valida un nodo ni cierra un gate | `memory-core` › C01-3:<br>`memory-core` › con evidencia ACTUAL | proceso real |  |
| C01-4 | La contradicción conserva ambos orígenes sin fusionar | `memory-core` › C01-4:<br>`memory-core` › conocimiento idéntico y mismo ámbito | proceso real |  |
| C01-5 | Un reinicio no pierde un evento confirmado | `memory-core` › C01-5: | proceso real |  |
| C01-6 | Secretos canario no aparecen en BD, cola, caché, paquete ni logs | `memory-core` › C01-6:<br>`memory-privacy` › cada formato de secreto canario<br>`evidence-store` › el secreto no existe en el original almacenado<br>`context-compressor` › un secreto canario NO existe<br>`memoria-dashboard` › evento REDACTADO o PRIVADO | proceso real | SSE y exportación del panel cubiertos por memoria-dashboard (fixture). |
| C01-7 | Referencia de otro proyecto, traversal y symlink externo se rechazan | `evidence-store` › aislamiento: traversal<br>`context-compressor` › colisión de ID, traversal, otro proyecto | proceso real | El symlink solo se prueba si el sistema operativo permite crearlo. |
| C01-8 | Evidencia modificada o ausente devuelve un estado explícito | `evidence-store` › hash o tamaño cambiado | proceso real |  |
| C01-9 | El upgrade de memorias 3.19/3.20 reales conserva todos los registros anteriores | `update-memoria-evidencia` › REAL: leer NO migra<br>`update-memoria-evidencia` › update INTERRUMPIDO | proceso real (bases creadas por los motores publicados) |  |
| C01-10 | La consulta histórica funciona con IDs INTEGER y TEXT | `memory-core` › C01-10:<br>`memory-layers` › IDs INTEGER y TEXT | proceso real |  |
| C01-priv | La redacción falla cerrada y existe política por proyecto | `memory-privacy` › FALLA CERRADO<br>`memory-privacy` › la política del proyecto | proceso real |  |
| C01-id | project_id estable; renombre y copia se resuelven de forma explícita | `memory-core` › project_id estable | proceso real |  |
| C01-cap | La captura es idempotente, ordenada y nunca bloquea al agente | `memory-core` › identidad durable con secuencia<br>`memory-core` › FUERA DE ORDEN<br>`memory-core` › la captura nunca lanza<br>`memory-core` › sin tablas la captura NO migra<br>`host-guard-captura` › la guardia del host registra shell<br>`host-guard-captura` › la captura jamás bloquea | proceso real |  |
| C01-legacy | Lo antiguo sin procedencia queda LEGACY_UNVERIFIED_PROVENANCE sin reescribirse | `memory-core` › C01-10:<br>`memory-layers` › estados de conocimiento | proceso real |  |

## C02 (14 requisitos)

| Id | Requisito | Prueba (archivo › título) | Alcance | Nota |
|---|---|---|---|---|
| C02-capas | Índice → lote de detalles → cronología → evidencia, en CLI y MCP | `memory-layers` › índice → lote de detalles<br>`mcp-contexto-tools` › stdio real | proceso real (CLI y stdio MCP) |  |
| C02-presupuesto | El presupuesto acumulado incluye los detalles, no solo el primer recall | `memory-layers` › presupuesto ACUMULADO | proceso real |  |
| C02-cache | Cambiar memoria o código invalida la caché | `memory-layers` › cambiar memoria, vigencia, código o permisos | proceso real |  |
| C02-contratos | Un contrato protegido aplicable no se omite en silencio | `memory-layers` › contrato PROTEGIDO aplicable | proceso real |  |
| C02-workers | Dos workers no confirman el mismo job (fencing) | `memory-queue` › dos workers NO confirman<br>`memory-queue` › FENCING<br>`memory-queue` › VARIOS PROCESOS | proceso real (varios procesos node) |  |
| C02-caida | Caída antes/después de claim o commit produce recuperación idempotente | `memory-queue` › caída DESPUÉS de procesar<br>`memory-queue` › caída ANTES del claim | proceso real |  |
| C02-resumidor | La falla del resumidor no bloquea edición ni terminal | `memory-queue` › el resumidor es opt-in | proceso real |  |
| C02-enorme | Un payload enorme entra en límites sin perder la referencia ni filtrar secretos | `memory-layers` › payload enorme<br>`memory-core` › payload enorme entra en límites | proceso real |  |
| C02-embeddings | Un proyecto sin embeddings mantiene la búsqueda | `memory-layers` › sin embeddings ni FTS | proceso real |  |
| C02-backpressure | Cola saturada: backpressure explícito sin perder eventos confirmados | `memory-core` › backpressure explícito | proceso real |  |
| C02-hostvacio | Un payload vacío o desconocido del host no ladrilla al agente | `memory-core` › la captura nunca lanza | proceso real |  |
| C02-cola | Backoff acotado, dead-letter visible, reintento manual limitado, lecturas agrupadas | `memory-queue` › reintentos con backoff<br>`memory-queue` › lecturas repetidas se AGRUPAN<br>`memory-queue` › reglas deterministas | proceso real |  |
| C02-estados | Sin resultados, sin BD, sin tablas y error son estados distintos | `memory-layers` › sin tablas = SCHEMA_MISSING | proceso real |  |
| C02-update | Actualizar mientras hay worker/captura exige coordinación con el update seguro | `memory-core` › con un update EN CURSO | proceso real |  |

## C03 (13 requisitos)

| Id | Requisito | Prueba (archivo › título) | Alcance | Nota |
|---|---|---|---|---|
| C03-salud | Servicio vivo + esquema roto → degradado, no verde | `memoria-dashboard` › servicio vivo + esquema roto | proceso real (servidor HTTP local) |  |
| C03-mirar | Mirar no escribe; la escritura se verifica con un comando explícito y caduca | `memoria-dashboard` › salud: mirar NO escribe | proceso real |  |
| C03-readonly | BD de solo lectura: la búsqueda funciona y la escritura muestra su limitación | `memoria-dashboard` › BD de solo lectura | proceso real |  |
| C03-cola | Cola atascada: estado visible y reintento seguro | `memoria-dashboard` › cola atascada | proceso real |  |
| C03-aislamiento | Dos proyectos con el mismo nombre: aislamiento completo | `memoria-dashboard` › dos proyectos con el MISMO nombre | proceso real |  |
| C03-xss | XSS en título o contenido llega como texto escapado | `memoria-dashboard` › XSS: | proceso real (API); la página usa solo textContent | Revisado en el navegador del panel de Claude; no en un navegador de usuario. |
| C03-enorme | BD enorme: paginación y uso acotado de RAM | `memoria-dashboard` › BD enorme | proceso real (30 000 filas; heapUsed, no RSS) |  |
| C03-upgrade | Upgrade con tablas nuevas conserva los datos anteriores | `memoria-dashboard` › actualización con tablas nuevas<br>`update-memoria-evidencia` › REAL: leer NO migra | proceso real + fixture |  |
| C03-grafos | Los grafos KDD/combinado/code structure quedan intactos (dashboard-preservacion) | `memoria-dashboard` › páginas /memoria y /contexto<br>`dashboard-preservacion` › dashboard | proceso real |  |
| C03-tabla | Falta una tabla nueva: diagnóstico, nunca migración escondida | `memoria-dashboard` › salud: falta una tabla nueva | proceso real |  |
| C03-sse | SSE con reconexión por cursor, eventos idempotentes y reconsulta tras un hueco | `memoria-dashboard` › SSE existente | proceso real |  |
| C03-trazar | Cada conocimiento nuevo se rastrea hasta su actividad/evidencia; los huecos se muestran | `memoria-dashboard` › conocimiento: se rastrea<br>`memoria-dashboard` › huecos de captura | proceso real |  |
| C03-smoke | Smoke integrado: tarball instalado, captura, procesamiento, evidencia, índice/detalle y estados | `release-integration` › funcionesNuevas | proceso real (tarball instalado en limpio) | Es un script de release (scripts/), no un test; lo ejecuta npm run release:check. |

## H01 (14 requisitos)

| Id | Requisito | Prueba (archivo › título) | Alcance | Nota |
|---|---|---|---|---|
| H01-log | Un error único en 20.000 líneas sigue visible | `context-compressor` › un error único en medio de 20.000 líneas | proceso real |  |
| H01-fallos | Múltiples fallos se conservan, se cuentan y se paginan | `context-compressor` › múltiples fallos se conservan<br>`context-compressor` › salida REAL de node --test | proceso real |  |
| H01-json | JSON muestra la etiqueta de selección; las cantidades completas no cambian | `context-compressor` › JSON muestra la etiqueta | proceso real |  |
| H01-unicode | Unicode y límites por bytes no generan JSON inválido | `context-compressor` › Unicode y límites por bytes | proceso real |  |
| H01-reinicio | Un caché reiniciado recupera el original con el mismo hash | `context-compressor` › un caché/proceso reiniciado | proceso real (proceso hijo nuevo) |  |
| H01-retencion | La caducidad no elimina pins activos ni evidencia durable | `context-compressor` › la caducidad no elimina pins<br>`evidence-store` › retención: la caducidad | proceso real |  |
| H01-aislamiento | Colisión de ID, traversal y otro proyecto se rechazan | `context-compressor` › colisión de ID, traversal<br>`evidence-store` › colisión de id | proceso real |  |
| H01-fallo | Compresor fallido, malformado o inflacionario entrega el original | `context-compressor` › compresor fallido, malformado o inflacionario<br>`context-compressor` › sin espacio, sin esquema | proceso real |  |
| H01-gate | Un gate no pasa con un resumen fabricado sin artefacto | `context-compressor` › un gate no pasa con un resumen fabricado | proceso real |  |
| H01-enorme | Un payload enorme usa límites y lectura acotada | `context-compressor` › un payload enorme usa límites<br>`evidence-store` › payload enorme | proceso real |  |
| H01-neto | La recuperación repetida se contabiliza en el ahorro neto | `context-compressor` › la recuperación repetida se contabiliza | proceso real |  |
| H01-obligatoria | Recuperación obligatoria: gate, ausencia, totalidad, código a modificar, hash cambiado | `context-compressor` › reglas de debeRecuperar<br>`context-compressor` › código para editar/auditar/depurar/verificar | proceso real |  |
| H01-inyeccion | El texto de una salida es dato: la inyección no se obedece | `context-compressor` › el texto de una salida es DATO | proceso real |  |
| H01-envelope | El sobre trae todos los campos del contrato sin credenciales ni rutas | `context-compressor` › H01 sobre | proceso real |  |

## H02 (6 requisitos)

| Id | Requisito | Prueba (archivo › título) | Alcance | Nota |
|---|---|---|---|---|
| H02-1 | Un cambio de texto local usa LOW sin investigación global ni delegación innecesaria | `effort-budget` › [prueba 1] | proceso real (decisión del router real) |  |
| H02-2 | Dos líneas en auth o migración mantienen HIGH por riesgo | `effort-budget` › [prueba 2] | proceso real |  |
| H02-3 | Recuperar detalles afecta el presupuesto acumulado | `effort-budget` › [prueba 3] | proceso real |  |
| H02-4 | Cambiar de rol no reinicia los límites | `effort-budget` › [prueba 4] | proceso real |  |
| H02-5 | Relectura intacta reutiliza; un hash distinto invalida | `context-reuse` › [prueba 5] | proceso real |  |
| H02-proveedor | Control del proveedor solo declarativo; sin ahorro de pensamiento interno prometido | `effort-budget` › capacidad del proveedor | proceso real |  |

## H03 (8 requisitos)

| Id | Requisito | Prueba (archivo › título) | Alcance | Nota |
|---|---|---|---|---|
| H03-neto | El ahorro es neto y recuperar el original resta | `benchmark-contexto` › el ahorro es NETO | proceso real |  |
| H03-medicion | bytes/4 es estimación, no se mezcla con uso exacto ni se convierte en dinero | `benchmark-contexto` › bytes/4 es ESTIMACIÓN | proceso real |  |
| H03-ausente | Dato ausente = no disponible, no 0; lo no observado se dice | `benchmark-contexto` › dato ausente es null | proceso real |  |
| H03-benchmark | Benchmark propio determinista (siete casos), sin datos de usuarios; campañas con modelos reales NO_EJECUTADO | `benchmark-contexto` › siete casos (A–F y H)<br>`benchmark-contexto` › es reproducible con la misma semilla | proceso real (determinista) | No sustituye una campaña con modelos reales ni se midió en un host real. |
| H03-panel | Panel Contexto y esfuerzo: tier, presupuesto, reducción neta, tipo de medición, cobertura | `memoria-dashboard` › contexto: tier y motivo<br>`memoria-dashboard` › contexto: sin datos | proceso real |  |
| H03-release | Release conjunto: suite completa, tarball limpio con opcionales presentes/ausentes, upgrade real 3.19.0 y 3.20.0, MCP stdio, sin datos privados | `release-integration` › optional-install<br>`release-integration` › read_does_not_migrate<br>`update-memoria-evidencia` › REAL: leer NO migra | proceso real (Windows, Node 24; ver informe) | La matriz Linux/Node 20/22 está en el workflow de CI y NO se ejecutó en esta máquina. |
| H03-rollback | El rollback conserva los aprendizajes posteriores; un update interrumpido con tablas nuevas se recupera | `update-memoria-evidencia` › REAL: leer NO migra<br>`update-memoria-evidencia` › update INTERRUMPIDO | proceso real |  |
| H03-docs | README y ayuda solo mencionan comandos que existen | `readme-comandos` › comandos documentados | proceso real |  |

## Lo que NO está verificado

- **Hosts reales (Cursor, Claude Code):** TEAMS-v4-hosts quedan `NO_EJECUTADO`. Los hosts reales no se ejecutaron en las pruebas.
- **Campañas con modelos reales:** `NO_EJECUTADO` (cuestan dinero y requieren autorización). El benchmark es determinista y mide payload.
- **Publicación:** esta matriz no afirma que 3.20.1 esté publicada: `npm view agentic-kdd version` y `npm run release:verify` lo dicen.
