# AGENTIX Sandbox — campaña adversarial

Dos perfiles: **Cursor individual** y **TEAMS (Claude Code director + Cursor constructor)**. TEAMS agrega pruebas de coordinación y 512 ataques reproducibles por defecto; individual 64. El objetivo es encontrar falsos positivos, regresiones y protocolos que existen pero no están conectados.

## Ejecutar mecanismos

Desde el checkout de Agentix, con dependencias instaladas:

```powershell
node scripts/sandbox.cjs run --mode=individual --seed=211
node scripts/sandbox.cjs run --mode=teams --seed=211 --rounds=512
```

Los reportes HTML, MD y JSON y logs TAP quedan en la ruta temporal impresa. Código de salida 1 significa hallazgos; 2 fallo del corredor. ERROR, SKIP, TODO, cero tests y UNVERIFIED nunca cuentan como aprobación completa. Cada grupo ejecuta archivos concretos; no confundir suma de suites con número de pruebas únicas. El informe registra hashes del checkout y detecta modificaciones concurrentes. Si Cursor modifica el origen durante la campaña, repetir sobre una versión estable.

## Ejecutar modelos reales

```powershell
node scripts/sandbox.cjs prepare --mode=individual
node scripts/sandbox.cjs prepare --mode=teams
```

Opcional: `--output="C:/ruta/nueva/vacia"`. No usar el proyecto original ni una carpeta con contenido. Abrir **workspace** del directorio impreso. El primer directorio contiene CURSOR.md; el segundo CLAUDE-DIRECTOR.md y CURSOR-BUILDER.md. Pegar una vez el prompt correspondiente en cada sesión. El control y el oráculo se encuentran fuera del workspace.

El modo individual entrega una tarea por vez; el agente implementa y envía con `node .lab/agent.cjs submit <id>`. El modo TEAMS usa el administrador y el canal MD **nativos**, ACK, fencing, resultado y verificación. No usar AdapterPrueba para declarar una sesión real disponible. Hay doce objetivos en tres sprints, dificultad variable, fronteras backend, escape frontend, idempotencia, decisiones humanas, esfuerzo, dashboard y seguridad de restauración. El descuento comercial queda pendiente por diseño; los trabajos independientes continúan.

El oráculo funcional no reemplaza todos los gates de Agentix. Los gates que este controlador no puede acreditar quedan UNVERIFIED; el reporte debe mostrarlo. No fabricarlos para obtener 100%. El agente debe aplicar los protocolos reales de memoria, pruebas, preservación y restauración y aportar evidencia. La campaña de mecanismos prueba fallos más amplios que las doce funciones del proyecto.

## Ataques y medida

- Control sano más pruebas negativas: evidencia inventada, ejecución ausente, sujeto/ciclo distinto, status UNVERIFIED disfrazado, NO_APLICA con fallo y timeout.
- Suite real: preservación frontend/backend, mutantes visuales, contratos, protección, blast radius, restauración selectiva, efectos, esfuerzo, presupuestos, memoria, distribución y dashboard.
- TEAMS: colas, ACK, repetición, locks, leases, sesiones, baseline previo a escritura, rollback, supervisión de planes y vigilancia mediante los tests correspondientes.
- Estado funcional y nativo por separado. Una función PASS no certifica autonomía del host.
- No medir ahorro de tokens con duración. Tokens UNKNOWN hasta tener contadores reales del proveedor.
- Autonomía acotada: 120 acciones/90 minutos y tres reparaciones individuales; reportar checkpoint y pendientes, nunca DONE por presupuesto.
- Repetir con varias semillas. 512 ataques no representan 512 vulnerabilidades distintas ni demuestran ausencia universal de fallos.

## Límites y seguridad

Es aislamiento de **fixtures**, no una VM ni una barrera de permisos del sistema operativo. Ejecutar agentes con acceso limitado al workspace; para probar agentes deliberadamente hostiles usar una VM desechable sin carpetas compartidas ni credenciales. Node vm tampoco es una barrera de seguridad frente a código malicioso. No se copian la memoria real, .git del origen, credenciales, node_modules ni configuración global. Los procesos mecánicos resuelven dependencias del checkout mediante NODE_PATH.

Se crea un commit sintético únicamente en cada repositorio nuevo para probar restore; no se hace commit, push, migración ni instalación de hooks en el proyecto original. No se instalan tareas Windows ni se envía WhatsApp. Hosts reales, watcher instalado, navegador offline/390px, recuperación después de cerrar procesos, migraciones de un consumidor real y WhatsApp requieren pruebas independientes. No declarar 100% hasta reunir esa evidencia.

Conservar los reportes y llevar los FAIL a correcciones del motor. Tras reparar, repetir misma semilla (regresión) y otra semilla (generalización). El sandbox no autoarregla Agentix ni envía cambios a GitHub.
