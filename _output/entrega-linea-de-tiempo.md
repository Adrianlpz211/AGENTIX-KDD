# Entrega — Línea de tiempo y tablero de tiempos

**Fecha:** 30/08/2026 · **Desarrollado y probado en:** el proyecto Salud360, donde
estaba el caso real que originó la característica · **Estado:** listo en el árbol de
trabajo, **sin commitear** — el commit y el push son de este chat.

---

## Lo que hay que subir

### Archivo nuevo — hay que añadirlo a git

```
.agentic/grafo/linea-tiempo.cjs
```

Es la herramienta principal. Sin `git add`, **no viaja** y el resto queda a medias:
el `CLAUDE.md` la invoca en el paso 0 de cada ciclo, y `post-cycle.cjs` lee la marca
que ella escribe.

### Archivos modificados

| Archivo | Qué cambió |
|---|---|
| `.agentic/grafo/grafo.cjs` | el `INSERT` de `ciclos` ahora acepta `fecha_inicio` |
| `.agentic/grafo/post-cycle.cjs` | lee la marca de tarea y calcula la duración real |
| `.agentic/grafo/regression-guard.cjs` | filtra por archivos fuente y quita ruido de formularios |
| `.agentic/agentes/09-sprint.md` | mide cada tarea del sprint y cierra el lote una sola vez |
| `CLAUDE.md` | protocolo de medición, 6 comandos nuevos y la regla del actor |
| `dashboard.cjs` | pestaña «⏱ Tiempos y avance» con métricas, exportación y calendario |
| `.gitattributes` | normalización de finales de línea (ver abajo) |
| `.gitignore` | ignora `.agentic/_tarea_en_curso.json` |

### Cambios de julio que ya estaban aquí sin commitear

No son de esta entrega, pero conviene saber qué son antes de meterlos en el mismo
commit. Los cuatro son **residuo de correr Agentix sobre sí mismo**, no funcionalidad:

- `.agentic/specs/general.md` y `.agentic/specs/init.js.md` — solo cambia la línea
  «Última actualización», de 2026-07-16 a 2026-07-20.
- `_output/log-2026-07.md` — entradas de log escritas solas por el post-commit.
- `.claude/launch.json` — una entrada nueva, `lumo-dashboard-readonly`, que apunta a
  `scripts/preview-lumo-dashboard.cjs`. **Ese script está sin seguimiento:** si sube
  el `launch.json` sin él, la entrada apunta a la nada. O van los dos, o ninguno.

---

## Qué hace la característica

### Medir cuánto tomó cada tarea

El defecto que lo habilitó: la tabla `ciclos` tenía `fecha_inicio`, `fecha_fin` y
`duracion_ms` desde siempre —el esquema estaba diseñado para medir— pero el `INSERT`
no nombraba `fecha_inicio`, así que su valor por defecto se disparaba **en el momento
del cierre**. Inicio y fin quedaban iguales y la duración salía **0 en todos los
ciclos, de todos los proyectos**.

El arreglo pasa el arranque como parámetro con `COALESCE(?, datetime('now'))`: sin
marca, el comportamiento es idéntico al de antes.

```
akdd tiempo inicio "<tarea>"      marca el arranque
akdd tiempo pausa                 pausa la sesión
akdd tiempo fin                   cierra y reporta
akdd tiempo resumen [n]           duración de los últimos ciclos
akdd tiempos                      compara todos los módulos entre sí
akdd tiempos <módulo|texto>       el detalle de un módulo o un proceso
akdd rebobina [desde] [hasta]     qué pasó en un rango y en qué orden
akdd orden                        cosas hechas en el orden equivocado
```

Se guardan **sesiones**, no un inicio y un fin: un dev trabaja en tandas a lo largo
de varios días. Por eso se reportan dos números que nunca se confunden — **trabajado**
(la suma de las sesiones, el esfuerzo) y **transcurrido** (que incluye noches y
pausas). Una tarea abierta el lunes y cerrada el jueves puede haber sido 4 h.

### Separación por actor — importante si hay más de un agente

`--actor=<nombre>` (o `$AKDD_ACTOR`) separa la medición de cada agente o dev.

**Es obligatorio si más de uno trabaja la misma carpeta.** Sin esto la marca es un
archivo compartido y el `inicio` de uno **cierra la tarea abierta del otro** y se la
lleva a su lote. No falla ruidosamente: produce un reporte que atribuye el trabajo de
alguien a otra persona. Pasó de verdad entre Cursor y Claude Code el 30/08.

El `_instance_id` del lock-manager **no sirve** para esto: es un archivo por carpeta,
así que dos agentes en el mismo proyecto leen el mismo identificador.

### El tablero del dashboard

Pestaña «⏱ Tiempos y avance», bajo *Project Docs*. Métricas por módulo: ciclos,
**retrabajo** (qué parte fueron arreglos en vez de construcción), **frenos** (gates que
pararon o avisaron), días activos, tiempo trabajado y **última vez** que se tocó.

Ordenada por lo último tocado, no por tamaño: en un proyecto de semanas la noticia es
quién lleva 21 días sin cerrar nada, no quién tiene más ciclos.

Debajo, **dónde se atascó el trabajo** (por archivo concreto) y un **calendario de
actividad** que dice cuántos días se trabajó de verdad, cuál fue el día más cargado y
cuál la parada más larga.

**Exportación** — un select con reporte HTML autocontenido (se abre sin servidor ni
conexión, para mandarlo por correo) y PDF vía el diálogo del navegador.

---

## Decisiones que conviene respetar

**Nada hardcodeado.** Se revisó a propósito: cero rutas absolutas, cero nombres de
módulo de ningún cliente, cero menciones al proyecto donde se desarrolló.

**Lo que NO subió, y por qué.** El proyecto de origen tiene dos parches más en
`contract-guard.cjs` y `tdd-gate.cjs` que **no** se promovieron:

- `contract-guard.cjs` tiene 71 líneas de patrones de módulo atados a ese cliente. Su
  motor por módulo sí es genérico y valdría la pena, pero generalizarlo bien pide leer
  esos patrones de la configuración del proyecto — un diseño que afecta a todos los
  clientes y que no correspondía decidir de oficio.
- El cambio de `tdd-gate.cjs` solo servía para alimentar al anterior: main ignora ese
  parámetro. Subirlo solo habría sido **medio arreglo**.

**Un dato ausente no se rellena con un cero.** Un ciclo sin duración no es un ciclo de
0 minutos. Las tablas muestran un guion y dicen cuántos ciclos tienen medición real.
La razón es práctica: estos números los ven los jefes, y uno inventado es peor que no
tener ninguno.

**Mediciones rescatadas a mano.** `backfill` permite meter una medición tomada fuera de
la herramienta, pero exige `--motivo`, deja rastro en `gate_events` y sale **marcada con
asterisco** en las tablas. Un número que puso una persona no puede presentarse igual que
uno que midió la máquina.

---

## Sobre `.gitattributes`

Se añadió normalización de finales de línea. El motivo es medible: al cotejar main con
la instalación de un proyecto, **21 de 69 herramientas aparecían como distintas — y 18
solo diferían en CRLF vs LF**. Solo 3 tenían cambios reales.

Incluye `.ps1`/`.bat`/`.cmd` como CRLF (el problema simétrico: LF los rompe en Windows)
y marca `.db`/`.sqlite` como binarios, que la normalización corrompería.

**Ojo al primer commit con esto:** git renormalizará y el diff puede salir enorme. Es
esperado y ocurre una sola vez.

---

## Verificación hecha

- Sintaxis de los 4 archivos tocados, y **arranque real** del dashboard en este repo —
  no solo `--check`, que da por buenos errores que solo aparecen al ejecutar.
- El tablero, revisado en un navegador real: sin errores de consola.
- El reporte exportado, generado e inspeccionado: autocontenido, sin recursos externos.
- Alineación completa: **70 herramientas en ambos lados, ninguna falta**. Las 3 que
  difieren son las decisiones explicadas arriba, más una línea de comentario en
  `linea-tiempo.cjs` de la que se quitó el nombre del cliente.

---

## Lo que queda pendiente

**Capturar el entregable.** Hoy la base sabe de ciclos y módulos, pero no tiene ningún
concepto de entregable ni de sprint. Para responder *«el entregable 3 lleva 5 días,
debía llevar 2»* haría falta capturarlo al arrancar la tarea. Es dato nuevo: **no se
puede reconstruir hacia atrás**.

**Los ciclos históricos no se recuperan.** Su hora de arranque real no se guardó en
ninguna parte. La medición empieza a existir desde que se instala, no antes.

**`fases.duracion_ms` sigue en cero** en todas las filas — el mismo defecto que tenía
`ciclos`, sin arreglar todavía. Por eso no hay desglose por fase.

**Un botón que aparenta más de lo que hace:** «Copy as Markdown», en la sección Project
del dashboard, copia solo el nombre del proyecto y una frase. No se tocó porque queda
fuera de esta entrega, pero conviene arreglarlo o quitarlo.
