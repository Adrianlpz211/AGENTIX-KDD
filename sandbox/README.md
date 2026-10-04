# AGENTIX Sandbox — campaña adversarial

Perfil **Cursor individual**, 64 ataques reproducibles por defecto. El objetivo es encontrar falsos positivos, regresiones y protocolos que existen pero no están conectados. (El perfil TEAMS se retiró mientras el modo TEAMS se reconstruye.)

## Ejecutar mecanismos

Desde el checkout de Agentix, con dependencias instaladas:

```powershell
node scripts/sandbox.cjs run --mode=individual --seed=211
```

Los reportes HTML, MD y JSON y logs TAP quedan en la ruta temporal impresa. Código de salida 1 significa hallazgos; 2 fallo del corredor. ERROR, SKIP, TODO, cero tests y UNVERIFIED nunca cuentan como aprobación completa. Cada grupo ejecuta archivos concretos; no confundir suma de suites con número de pruebas únicas. El informe registra hashes del checkout y detecta modificaciones concurrentes. Si Cursor modifica el origen durante la campaña, repetir sobre una versión estable.

## Ejecutar modelos reales

```powershell
node scripts/sandbox.cjs prepare --mode=individual
```

Opcional: `--output="C:/ruta/nueva/vacia"`. No usar el proyecto original ni una carpeta con contenido. Abrir **workspace** del directorio impreso. El directorio contiene CURSOR.md; pegar una vez ese prompt en la sesión. El control y el oráculo se encuentran fuera del workspace.

El modo individual entrega una tarea por vez; el agente implementa y envía con `node .lab/agent.cjs submit <id>`. 

El oráculo funcional no reemplaza todos los gates de Agentix. Los gates que este controlador no puede acreditar quedan UNVERIFIED; el reporte debe mostrarlo. No fabricarlos para obtener 100%. El agente debe aplicar los protocolos reales de memoria, pruebas, preservación y restauración y aportar evidencia. La campaña de mecanismos prueba fallos más amplios que las doce funciones del proyecto.

## Ataques y medida

- Control sano más pruebas negativas: evidencia inventada, ejecución ausente, sujeto/ciclo distinto, status UNVERIFIED disfrazado, NO_APLICA con fallo y timeout.
- Suite real: preservación frontend/backend, mutantes visuales, contratos, protección, blast radius, restauración selectiva, efectos, esfuerzo, presupuestos, memoria, distribución y dashboard.
- Estado funcional y nativo por separado. Una función PASS no certifica autonomía del host.
- No medir ahorro de tokens con duración. Tokens UNKNOWN hasta tener contadores reales del proveedor.
- Autonomía acotada: 120 acciones/90 minutos y tres reparaciones individuales; reportar checkpoint y pendientes, nunca DONE por presupuesto.
- Repetir con varias semillas. 512 ataques no representan 512 vulnerabilidades distintas ni demuestran ausencia universal de fallos.

## Límites y seguridad

Es aislamiento de **fixtures**, no una VM ni una barrera de permisos del sistema operativo. Ejecutar agentes con acceso limitado al workspace; para probar agentes deliberadamente hostiles usar una VM desechable sin carpetas compartidas ni credenciales. Node vm tampoco es una barrera de seguridad frente a código malicioso. No se copian la memoria real, .git del origen, credenciales, node_modules ni configuración global. Los procesos mecánicos resuelven dependencias del checkout mediante NODE_PATH.

Se crea un commit sintético únicamente en cada repositorio nuevo para probar restore; no se hace commit, push, migración ni instalación de hooks en el proyecto original. No se instalan tareas Windows ni se envía WhatsApp. Hosts reales, watcher instalado, navegador offline/390px, recuperación después de cerrar procesos, migraciones de un consumidor real y WhatsApp requieren pruebas independientes. No declarar 100% hasta reunir esa evidencia.

Conservar los reportes y llevar los FAIL a correcciones del motor. Tras reparar, repetir misma semilla (regresión) y otra semilla (generalización). El sandbox no autoarregla Agentix ni envía cambios a GitHub.
