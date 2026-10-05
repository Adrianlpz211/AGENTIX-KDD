# Diseño: juez tipado + experimento en modo sombra

Estado: PROPUESTA. No hay código escrito ni cuenta de Jev creada. Fecha: 2026-10-04.

## 1. Interfaz: `decision-oracle`

Un juez responde preguntas tipadas sobre un estado y devuelve probabilidades. Es un contrato, no un motor.

```
Pregunta  { id, version, tipo: 'choice' | 'score' | 'noul', texto, opciones?, rubrica? }
Estado    { campos permitidos, ya redactados; hash }
Respuesta { valor, probs{}, confianza, motor, motor_version, latencia_ms, costo, estado }
estado:     OK | TIMEOUT | ERROR | RECHAZADO_PRIVACIDAD
```

Motores intercambiables, todos con `evaluar(pregunta, estado)`:

| Motor | Qué es | Sale de la máquina |
|---|---|---|
| `reglas` | Lo que ya hay (`prediccion.cjs`, gates) | No |
| `estadistico` | Modelo pequeño entrenado con el propio registro | No |
| `llm-host` | El modelo del host con salida estructurada | Según host |
| `jev` | Adaptador opcional, apagado por defecto | Sí |

Modo por motor y por pregunta: `off` → `sombra` → `asesor` → `decide`.

Reglas de autoridad (no negociables):
1. Ningún motor levanta una prohibición determinista ni un gate.
2. Preguntas sobre acciones irreversibles, seguridad o valores del dueño: máximo `asesor`.
3. Cualquier fallo de un motor externo degrada al motor local sin bloquear (fail-soft).
4. Un cambio de `motor_version` devuelve el motor a `sombra`.
5. Un falso negativo en un caso decidido por el motor devuelve el motor a `asesor` automáticamente.

Privacidad antes de cualquier motor externo:
- Redacción con `memory-privacy` y el Escudo.
- Lista cerrada de campos: texto de la tarea redactado, clases de ruta, conteos, banderas de riesgo. Nunca cuerpos de código ni datos de personas.
- Activación explícita por proyecto. La clave va en variable de entorno, nunca en archivos.
- Bloqueo para proyectos marcados como sensibles (p. ej. salud) mientras no exista una política de retención verificada del proveedor.

## 2. Registro (append-only): `oracle_log`

`id, ciclo_id, pregunta_id, pregunta_version, motor, motor_version, input_hash, probs_json, valor, confianza, latencia_ms, costo, estado, creado_at, etiqueta, etiqueta_fuente, etiquetado_at`

La etiqueta la pone un proceso mecánico posterior, nunca el motor evaluado.

## 3. Preguntas del experimento

| ID | Pregunta | Tipo | Etiqueta (verdad) |
|---|---|---|---|
| Q0 | ¿Esto es una tarea o una conversación? | noul | Regla mecánica: empieza con `aa:`/verbo de acción, o revisión humana de muestra |
| Q1 | ¿Esta tarea terminará con STOP, FAIL o reversión en 14 días? | noul | `gate_events` + commits de revert (mecánico) |
| Q2 | ¿Esta tarea toca un valor de negocio protegido? | noul | `spec-value-scan` / Spec Gate posterior |
| Q3 | Clase de decisión: reversible / provisional / del dueño | choice | Respuesta del dueño en la revisión de supuestos (requiere la fase 2 del plan de autonomía) |

Q0 y Q1 se pueden empezar ya. Q3 queda para cuando exista el registro de decisiones del modelo.

## 4. Diseño del experimento

- **Modo:** sombra pura. Todos los motores responden en paralelo, ciegos entre sí, sin influir en ningún ciclo.
- **Entrada:** solo información disponible antes del ciclo (tarea redactada, archivos previstos, módulo). Se prohíbe cualquier dato posterior para evitar fuga de la respuesta.
- **Corpus retrospectivo:** repetir los ciclos históricos con su entrada original y etiquetarlos con `gate_events`. Hay unos 155 ciclos.
- **Positivos sintéticos:** los mutantes de `akdd benchmark preservacion` aportan casos de riesgo con etiqueta conocida. Se reportan aparte de los reales, porque su distribución difiere.
- **Partición cronológica:** la primera mitad fija umbrales; la segunda mitad evalúa. Los umbrales no se tocan después de ver la segunda mitad.
- **Pre-registro:** estos criterios se fijan y se commitean antes de ejecutar nada.
- **Pin de versión:** nunca `jev-latest`; versión fija durante todo el experimento.

## 5. Métricas (en este orden de importancia)

1. **Falso negativo** de Q1 en el punto de operación elegido, con intervalo de confianza al 95 %.
2. **Calibración:** Brier y ECE (10 casillas, solo con ≥100 casos).
3. **Clasificación selectiva:** exactitud y falso negativo entre las respuestas con confianza ≥ τ, junto con la cobertura (qué fracción decide solo).
4. **Comparación pareada** contra `reglas` y contra el predictor constante, con bootstrap.
5. **Operación:** latencia p95, costo, disponibilidad e incidentes de privacidad (deben ser 0).

La exactitud global se reporta, pero no decide nada.

## 6. Regla de promoción

| Paso | Condiciones |
|---|---|
| Sombra → Asesor | ≥100 casos etiquetados y ≥30 positivos (reales + mutantes por separado); Brier mejor que `reglas` con IC95 % que excluye 0; ECE ≤ 0,08; disponibilidad ≥ 99 %; 0 incidentes de privacidad |
| Asesor → Decide (solo reversible y de bajo impacto) | Falso negativo ≤ 5 % con cota superior ≤ 10 %; exactitud selectiva ≥ 95 % con cobertura ≥ 25 %; ≥ 30 días estable; sin regresión frente a `reglas` |
| Nunca a `decide` | Irreversible, seguridad, valores del dueño |

## 7. Tamaños de muestra (por qué no se decide con 20 ciclos)

- Con 0 fallos en n positivos, la cota superior al 95 % es ≈ 3/n. Para demostrar falso negativo ≤ 5 % hacen falta ≥60 positivos sin un solo fallo.
- Con exactitud de 75 % y n = 100, el IC95 % es ≈ ±8 puntos. Distinguir 75 % de 70 % en comparación pareada requiere del orden de 470 casos (supuesto: 15 % de discordancia entre motores).

## 8. Línea base real hoy (`akdd prediccion`, 2026-10-04)

- 16 predicciones registradas; 9 aciertos; 0 falsos negativos; 7 sin verdad conocida.
- Entre las comprobables (9), 1 tuvo problema real: tasa base ≈ 11 %. Un predictor que siempre dijera BAJO acertaría 8 de 9 (≈ 89 %).
- Por lo que muestra `listar`, al menos 5 de las 10 últimas predicciones parecen mensajes de conversación y no tareas. Todas son ALTO y sin verdad conocida. Eso ensucia el registro; Q0 lo ataca. (No verifiqué en el código del enricher por qué se registran.)

## 9. Riesgos y límites

- Con tasa base baja, pocos positivos reales: el experimento puede tardar meses en dar un veredicto firme.
- Las etiquetas mecánicas (`gate_events`) miden problemas detectados, no todos los reales.
- Un motor que decide bien Q1 no garantiza buenas decisiones en Q3.
- Calibración de Jev fuera de su distribución: reportada por terceros con un solo estudio; debe medirse aquí.
- Dependencia de un proveedor nuevo y cerrado; sin política de retención pública.
