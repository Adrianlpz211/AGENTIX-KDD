# 📋 Pendientes DESPUÉS del Plan 5 — la tablita del dueño

> Todo lo que NO entra en el Plan 5 (potenciadores de memoria), juntado en un
> solo lugar para agendarlo después. Generado el 2026-07-15.
> Leyenda de "¿Construible por la IA?": ✅ = se construye completo en un sprint
> · 🔶 = se construye la maquinaria, pero su valor final depende de uso real o
> del modelo · ⏳ = no es código, es validación con tiempo/proyectos reales.

| # | Pendiente | Qué es en simple | ¿Construible por la IA? | Qué necesita | Tamaño |
|---|---|---|---|---|---|
| 1 | **Medidor de cobertura** (debilidad D2 = hueco L5-2) | Que Agentix te diga "veo el 91% de tu proyecto, y esto es lo que NO veo" — hoy calla sus puntos ciegos | ✅ Sí, completo | Un sprint chico: reusa el comparador del Plan 3 donde haya tree-sitter, y heurísticas (archivos con 0 símbolos, % de líneas cubiertas por rangos) donde no | CHICO |
| 2 | **Higiene Windows** (debilidad D6) | Cazar de una vez la clase de bugs de rutas `\` y fines de línea CRLF en todo el motor (hoy cazamos 2 en vivo — hay más escondidos) | ✅ Sí, completo | Mini-auditoría del motor + helpers de normalización + fixtures de prueba | CHICO |
| 3 | **Continuidad multi-día** (hueco L5-4) | Sprints que duran días y se reanudan solos ("aa: continúa sprint" y retoma exacto donde quedó) | ✅ Sí, casi todo ya medio existe | Formalizar lo que ya hay (PLAN.md de sprints + checkpoints cada 5 ciclos + recuperación de sesión) en un protocolo de auto-reanudación | MEDIANO |
| 4 | **Bucle de recuperación autónoma** (hueco L5-3) | Cuando un gate frena algo: proponer el arreglo, aplicarlo, reverificar, y solo escalar al humano si falla 2 veces | 🔶 La maquinaria sí (protocolo + reintentos + telemetría + respeto al deny-list); la CALIDAD del arreglo depende del modelo, no del framework — por eso el diseño es fail-closed: si no lo logra, escala | Los potenciadores 2 y 3 del Plan 5 como combustible (ya estarán) + un sprint de orquestación | MEDIANO |
| 5 | **Etiquetado de madurez** (debilidad D1, mitad "escribir") | Marcar en docs/README qué es Probado-en-batalla, qué Verificado-con-fixtures, qué Implementado-sin-confirmar | ✅ Sí — es escribir con la evidencia que ya tenemos | Va DENTRO de la alineación del README (fila 7) | CHICO |
| 6 | **Batallas de confirmación** (hueco L5-5 + mitad "probar" de D1) | Confirmar los "debería funcionar": Front/Back en paralelo con una tarea real que los separe de verdad; el STOP del browser-gate ganado con semanas de uso | ⏳ La IA puede EJECUTAR la batalla de Front/Back en lumoV2 (esa sí es agendable ya); la maduración del resto solo la da el uso real en proyectos reales — nadie puede construir tiempo | Una tarea real front+back para la batalla; el resto: semanas de uso con clientes |  BATALLA |
| 7 | **Alineación del README** (los 10 puntos, ES + EN) | Actualizar ambos READMEs a v3.13: precisión por líneas, Ojos UI, browser-gate, portabilidad, medición tree-sitter, niveles de madurez, CLI nuevo, tagline "falla cerrada" | ✅ Sí, completo | Un ciclo de escritura — EL DUEÑO PIDIÓ DEJARLO PARA EL FINAL, antes del push | CHICO |

## Orden sugerido cuando se retome

1→2 (chicos, limpian la casa) → 3 (continuidad) → 4 (recuperación, con el Plan 5 ya dando combustible) → 6 (la batalla Front/Back cuando haya tarea real) → 7 (README) → push.

## Lo que NINGÚN sprint puede fabricar (la línea de sinceridad)

- **Tiempo de uso real:** la promoción del browser-gate a STOP y la fe pública
  en los "should work" se ganan con semanas de proyectos reales, no con código.
- **Calidad garantizada de arreglos autónomos:** el framework puede orquestar
  el reintento y verificar el resultado — la inteligencia del arreglo la pone
  el modelo. Por eso todo el diseño escala al humano cuando duda.
