# AGENTIX KDD

**Memoria persistente, esfuerzo proporcional y preservación para desarrollar con IA.** Agentix organiza el trabajo de Cursor y Claude Code alrededor de conocimiento recuperable, contratos, pruebas y evidencia de ejecución. Puede trabajar con un solo agente o coordinar director y constructor mediante TEAMS.

[English](README.md) · [Sandbox adversarial](sandbox/README.md) · [Instrucciones canónicas](AGENTS.md)

## Lo más potente

| Capacidad | Qué aporta |
|---|---|
| Memoria KDD | Recuperación de conocimiento relevante, patrones, errores, decisiones y relaciones causales. |
| Esfuerzo proporcional | Política LOW/MEDIUM/HIGH según dificultad **y riesgo**; presupuestos de contexto, herramientas y reparaciones. |
| Preservación | Contratos backend, escenarios frontend, archivos protegidos y análisis de impacto para detectar regresiones. |
| TEAMS | Planes y sprints, dependencias, ACK, leases, fencing, canal entre sesiones y pendientes humanos. |
| Restauración | Puntos con alcance definido, vista previa, comprobación del estado actual y restricciones para rollback automático. |
| Dashboard | Grafos KDD, combinado y estructura de código; métricas, registros, explicaciones, tabla y visita guiada. |
| Evidencia | Estados PASS/FAIL/SKIP/UNVERIFIED/ERROR, artefactos de ejecución y telemetría para revisar el cierre. |

Agentix aporta controles; su eficacia depende de su configuración, cobertura y ejecución en el host. No garantiza ausencia de errores ni un porcentaje universal de ahorro de tokens. Implementado, conectado y verificado son estados distintos.

## Instalación

Requisitos: Git y Node.js. El paquete declara Node >=18; verificar la versión elegida antes de producción. Las pruebas de esta revisión se ejecutaron con Node 24. Las capacidades de navegador requieren navegador y transporte compatibles.

```powershell
npm install -g agentic-kdd
cd tu-proyecto
akdd init
```

`akdd init` es interactivo y configura archivos del framework y MCP. Revisar respaldos de instrucciones existentes y cambios propuestos. Abrir el proyecto en Cursor o Claude Code y escribir:

```text
aa: configurar
aa: corrige el error de validación del formulario
```

Para usar **este checkout local**, cuyos cambios pueden no estar publicados:

```powershell
npm install
node bin/akdd.js --version
node bin/akdd.js health
```

Los comandos `akdd` requieren la CLI instalada; su equivalente en este repo es `node bin/akdd.js`. `aa:`, `teams:`, `ag:`, `audit:` y `ws:` son instrucciones en el chat del agente, no comandos PowerShell.

## Trabajo individual

`aa:` activa análisis, construcción, pruebas, QA, preservación, revisión y memoria según el protocolo y la política de esfuerzo. El agente debe ejecutar los controles necesarios; leer una regla no demuestra que la ejecutó.

```text
aa: --dry-run refactoriza la validación del pago
aa: sprint corrige los errores del módulo
aa: aprende
ag: review src/pago.js
audit: seguridad
```

`--dry-run` solicita una propuesta sin escribir. Un cambio pequeño con riesgo alto debe conservar los controles de riesgo; reducir investigación no significa omitir protección.

```powershell
akdd effort decide "corrige un texto" --paths=src/textos.js --type=text --json
akdd health
akdd contracts
akdd contracts blast src/pago.js
akdd decide src/pago.js
akdd historial
akdd report
```

## TEAMS: Claude Code + Cursor

Abrir ambas sesiones sobre el mismo proyecto. Director por defecto: Claude Code; constructor: Cursor. Usar instrucciones de rol y el canal nativo. El registro de sesiones por sí solo no demuestra un intercambio exitoso.

```text
teams: activar
teams: plan
teams: ejecutar
teams: estado
teams: pendientes
teams: pausa
teams: continuar
teams: desactivar
```

La inicialización de tablas necesita autorización de migración en un proyecto existente. Ejemplo CLI:

```powershell
akdd teams init --aprobar-migracion
akdd teams plan plan.json
akdd teams status
akdd teams run
akdd teams pending
akdd teams goal
```

`plan.json` incluye objective y sprints con tasks; cada tarea tiene id, objective, acceptance, allowed_files, depends_on, risk y change_type. El constructor entrega resultados; el director/controlador verifica gates. `teams run` hace un pase del scheduler: no lanza por sí solo dos modelos ni acredita todos los gates. Un watcher no puede despertar cualquier sesión detenida. El modo goal debe registrar límites, progreso y pendientes; nunca confundir presupuesto agotado con trabajo terminado.

Un STOP de tarea o dependencia permite continuar trabajo independiente cuando sea seguro. Un STOP GLOBAL bloquea el plan. Las decisiones de negocio requieren una persona y deben aparecer en el reporte final.

## Puntos de restauración

```powershell
akdd restore list
akdd restore create --label="antes del cambio" --files=src/pago.js
akdd restore show <id>
akdd restore preview <id>
```

Revisar la vista previa antes de apply; usar el hash actual requerido por el motor y confirmación explícita. No equivale a restaurar todo el equipo, base de datos o servicios externos. El rollback automático necesita elegibilidad, fallo reproducible y ausencia de efectos externos sin compensar.

## Dashboard y navegador

```powershell
akdd dashboard
akdd ast
```

Los grafos conservan su interfaz; las mejoras de verificación no requieren rediseñarlos. Consultar estado de preservación, evidencia, métricas y registros; en KDD, **☰ Tabla** ofrece la alternativa tabular. La visita guiada utiliza el servicio de tour del dashboard; no es necesario ejecutar un Node separado para cada recorrido. Si una capacidad no tiene evidencia real de navegador, mostrar pendiente en vez de presentarla como verificada.

## Hooks y WhatsApp opcional

```powershell
akdd host-hooks status --host=cursor
akdd host-hooks install --host=cursor
akdd host-hooks uninstall --host=cursor
```

Instalar hooks solo después de probar compatibilidad dentro del IDE; una salida incorrecta puede bloquear herramientas. Tras desinstalar, puede ser necesario cerrar completamente el proceso y abrir una sesión nueva. Los hooks de Git y los hooks del host son integraciones distintas.

```text
ws: activar
ws: desactivar
```

WhatsApp es opcional, para un agente con control de navegador compatible, principalmente Claude Code. Activar, indicar contacto y verificar la sesión de WhatsApp Web antes del mensaje de prueba. No asumir disponibilidad en Cursor ni enviar mensajes sin autorización. La ausencia de extensión, sesión o confirmación debe quedar visible.

## Actualizar de 3.19 a 3.20 conservando memoria

Instalar la CLI nueva y actualizar cada proyecto son pasos distintos. El paquete global no recorre ni modifica tus proyectos. Una vez publicada 3.20:

```powershell
npm install -g agentic-kdd@3.20.0
cd "ruta-del-proyecto"
akdd update
akdd health
```

Por defecto, init y update usan el motor incluido en el paquete instalado: no descargan automáticamente main. La base memoria.db, los Markdown de memoria, la configuración y el código de negocio quedan fuera del reemplazo. Update registra respaldos y un journal para recuperar una interrupción; conserva personalizaciones reconocidas por el registro de propiedad.

Para habilitar columnas nuevas en una base antigua, con los agentes detenidos y tras revisar el respaldo:

```powershell
akdd update --migrate
akdd mcp status
```

Esta opción autoriza una migración de esquema, no el borrado de conocimiento. Genera un respaldo SQLite coherente, incluyendo commits en WAL, aplica la migración en transacción y comprueba integridad. Si falla, informa error; no declara el proyecto totalmente actualizado. La primera actualización de un motor antiguo sin registro de propiedad requiere revisar las personalizaciones dentro de archivos del framework: no es posible distinguir automáticamente todas ellas de su versión original.

`akdd update --rollback` revierte archivos de la última actualización; no revierte una migración de base, mensajes ni servicios externos. Antes de volver a un motor viejo, revisar compatibilidad del esquema. `--ref=<tag-o-SHA>` y `--from=<archivo.tar.gz>` son orígenes explícitos alternativos; no hace falta utilizarlos para actualizar desde npm.

## Para qué sirve el MCP

El MCP es el puente de herramientas entre el modelo y Agentix. `akdd mcp` configura el servidor local del proyecto. Permite recuperar memoria con recall, guardar conocimiento con remember, consultar impacto y contratos, decidir esfuerzo y operar TEAMS o puntos de restauración mediante herramientas estructuradas.

Ejemplo: antes de tocar un módulo, el modelo consulta los errores conocidos y el impacto; después de comprobar el cambio, registra lo aprendido. No necesita reconstruir ese contexto en cada chat. El MCP comparte el mismo motor y la misma base del proyecto; no es otra IA ni una base en la nube. La recuperación acotada puede reducir contexto repetido, pero depende de que el modelo use las herramientas. Tampoco garantiza que una sesión del IDE siga activa indefinidamente.

Preferir configuración por proyecto para evitar consultar la memoria de otro repositorio. Recargar el IDE después de configurarlo. Un JSON MCP inválido se conserva y se reporta: no se sobrescribe silenciosamente.

## Verificación y publicación de 3.20

En el checkout del repositorio:

```powershell
npm ci
npm run release:check
```

La verificación ejecuta la suite completa, construye el paquete npm, rechaza datos privados en su contenido y prueba la actualización desde el paquete 3.19 publicado con SQLite real, reversión, migración y llamadas MCP por stdio. Deja resultados, logs y tarball en `_output/release-3.20.0/`. Un resultado positivo acredita ese alcance; no sustituye una sesión simultánea real de Claude Code y Cursor ni certifica WhatsApp.

Ver [guía de publicación](PUBLICACION-3.20.md). La configuración local prepara 3.20; su disponibilidad pública depende de publicar el paquete y actualizar GitHub.

MIT · [Repositorio](https://github.com/Adrianlpz211/AGENTIX-KDD)
