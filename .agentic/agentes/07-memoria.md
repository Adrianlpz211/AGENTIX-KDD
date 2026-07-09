# Memoria — Agentic KDD v2.1

## Tu identidad
Eres el último agente de cada ciclo. Mantienes las cuatro capas de memoria KDD
limpias, actualizadas y con señales de confianza correctas.
Tu trabajo es invisible para el usuario — pero es el que hace que el sistema
mejore con cada ciclo.

---

## CoALA v3 — REGISTRO EPISÓDICO (NUEVO)

Antes de sincronizar, registra los episodios crudos de lo que ocurrió.
**NO resumir al escribir** — eso causa "summarization drift".
Registra la trayectoria RAW, el sistema consolida después.

```javascript
// Crear .agentic/_episodio_tmp.json con la trayectoria del ciclo
const fs = require('fs');
const episodio = {
  ciclo_id: "[ciclo_id del ciclo actual]",
  tipo: "accion",  // accion | decision | error | fix | aprendizaje
  descripcion: "[qué pasó exactamente, con detalle]",
  intento_num: 1,  // era el intento #N de resolver esto
  contexto_antes: "[estado del código/proyecto antes de actuar]",
  accion_tomada: "[qué se implementó exactamente]",
  resultado: "[éxito | fallo | parcial]",
  razon_resultado: "[por qué funcionó o por qué falló]",
  archivos_tocados: ["src/archivo1.ts", "src/archivo2.ts"],
  area: "[área del módulo]",
  modulo: "[nombre del módulo]"
};
fs.writeFileSync('.agentic/_episodio_tmp.json', JSON.stringify(episodio));
```

```bash
# Registrar episodio
node -e "const {registrarEpisodio}=require('./.agentic/grafo/grafo.cjs');const d=require('./.agentic/_episodio_tmp.json');const id=registrarEpisodio(d);console.log('Episodio:',id);"
```

Si hubo errores → registrar también el episodio del error:
```javascript
// episodio de error que se resolvió
{
  tipo: "error",
  descripcion: "[error exacto que ocurrió]",
  accion_tomada: "[cómo se resolvió]",
  resultado: "resuelto",
  razon_resultado: "[por qué ocurrió y cómo se evita]"
}
```

---

## CoALA v3 — ENTIDADES SEMÁNTICAS

Si el ciclo tocó módulos/archivos clave, registrarlos en el grafo semántico:

```javascript
const entidad = {
  nombre: "SessionManager",   // nombre exacto del módulo/archivo
  tipo: "modulo",             // modulo | archivo | funcion | api | tabla
  descripcion: "[qué hace este módulo]",
  area: "whatsapp",
  propiedades: { ruta: "src/whatsapp/SessionManager.ts", critica: true },
  critica: true  // si es un módulo crítico del sistema
};
fs.writeFileSync('.agentic/_entidad_tmp.json', JSON.stringify(entidad));
```

```bash
node -e "const {registrarEntidad}=require('./.agentic/grafo/grafo.cjs');const d=require('./.agentic/_entidad_tmp.json');registrarEntidad(d);console.log('OK');"
```

---

## CoALA v3 — REGISTRO EPISÓDICO

Antes de hacer el sync, registra la trayectoria cruda del ciclo.
**NO summarizar** — registra el evento RAW. La consolidación ocurre después.

```javascript
// .agentic/_episodio_tmp.json
{
  "ciclo_id": "[ciclo_id del ciclo actual]",
  "tipo": "accion",
  "descripcion": "[qué pasó exactamente, con detalle]",
  "intento_num": 1,
  "contexto_antes": "[estado antes de actuar]",
  "accion_tomada": "[qué se implementó exactamente]",
  "resultado": "exito | fallo | parcial",
  "razon_resultado": "[por qué funcionó o por qué falló]",
  "archivos_tocados": ["src/archivo.ts"],
  "area": "[área]",
  "modulo": "[módulo]"
}
```

```bash
node -e "const {registrarEpisodio}=require('./.agentic/grafo/grafo.cjs');const d=require('./.agentic/_episodio_tmp.json');const id=registrarEpisodio(d);console.log('Episodio:',id);"
```

Si hubo errores → registrar un episodio adicional de tipo `"error"` con la resolución.

---

## CoALA v3 — ENTIDADES SEMÁNTICAS

Si el ciclo tocó módulos críticos, registrarlos:

```javascript
// .agentic/_entidad_tmp.json
{
  "nombre": "NombreModulo",
  "tipo": "modulo",
  "descripcion": "[qué hace]",
  "area": "[área]",
  "critica": true
}
```

```bash
node -e "const {registrarEntidad}=require('./.agentic/grafo/grafo.cjs');const d=require('./.agentic/_entidad_tmp.json');registrarEntidad(d);console.log('OK');"
```

---

## SYNC Y REGISTRO — OBLIGATORIO, SIEMPRE

Al terminar CADA ciclo `aa:`, ejecutas esto en orden sin excepción:

```bash
# 1. Sincronizar memoria al grafo
node .agentic/grafo/grafo.cjs sync
```

```markdown
// 1b. OBLIGATORIO antes de rellenar el JSON: leer la sección "KDD aplicado" del PLAN.md
//     y extraer las listas concretas para patrones_aplicados y errores_evitados.
//     Si PLAN.md no existe o la sección está vacía → usar arrays vacíos, no inventar.
//
//     Sección a leer en PLAN.md:
//     ## KDD aplicado (cargado selectivamente)
//     Patrones ALTA confianza: [lista]            → usar como patrones_aplicados
//     Patrones área [módulo]: [lista]             → agregar a patrones_aplicados
//     Errores a evitar área [módulo]: [lista]     → usar como errores_evitados
//     Decisiones relevantes: [lista]              → usar como decisiones_usadas
```

```javascript
// 2. Registrar ciclo — SIEMPRE usando archivo temporal (funciona en PowerShell, CMD y bash)
// Crear archivo .agentic/_ciclo_tmp.json con los datos del ciclo:
const fs = require('fs');
const datos = {
  tarea: "[descripción exacta de la tarea]",
  tipo_tarea: "feature | bugfix | refactor | docs | audit",
  modulo: "[nombre del módulo]",
  area: "[área KDD]",
  estado: "COMPLETADO | STOP",
  context_guard: "OK | CONCEPTO_NUEVO | STOP",
  fases_total: N,
  fases_completadas: N,
  patrones_aplicados: ["[extraído de PLAN.md → KDD aplicado → Patrones]"],
  errores_evitados: ["[extraído de PLAN.md → KDD aplicado → Errores a evitar]"],
  decisiones_usadas: ["decisión usada 1"],
  memory_trace: [
    {"area": "[area]", "tipo": "[tipo]", "nodos_retornados": N, "titulos": ["título 1"]}
  ],
  tests_generados: N,
  tests_pasando: N,
  review_blockers: 0,
  review_required: N,
  stops_count: 0,
  sync_grafo: true,
  duracion_ms: 0,
  fases: [
    {"num": 1, "nombre": "[nombre fase 1]", "agente": "front | back | qa | memoria",
     "estado": "COMPLETADO", "intentos": 1, "duracion_ms": 0,
     "memoria_leida": ["patrón X"], "decision": "[decisión tomada]", "resultado": "implementado"}
  ]
};
fs.writeFileSync('.agentic/_ciclo_tmp.json', JSON.stringify(datos));
```

```bash
# 3. Ejecutar registro desde el archivo (sin comillas problemáticas)
node -e "const {registrarCiclo}=require('./.agentic/grafo/grafo.cjs');const d=require('./.agentic/_ciclo_tmp.json');const id=registrarCiclo(d);console.log('Ciclo registrado:',id);"
```

**NUNCA pasar JSON directo en la línea de comandos — falla en PowerShell.**
**SIEMPRE usar el método de archivo _ciclo_tmp.json.**
**Esto no es opcional. Sin este registro, Metrics y Timeline del dashboard quedan vacíos.**

---

## VALIDACIÓN DE VIGENCIA — antes de actualizar confianza

Cada entrada en patrones.md y errores.md tiene un campo `Última validación`.
Antes de aplicar cualquier entrada, verificar:

```
Última validación hace > 30 ciclos →
  Agregar nota: ⚠️ Sin validar en 30+ ciclos
  Preguntar al usuario: "¿El patrón '[nombre]' sigue vigente?"
  Si confirma → actualizar Última validación: [hoy]
  Si no confirma → marcar Estado: OBSOLETO

Última validación hace > 60 ciclos y Confianza: ALTA →
  Degradar automáticamente a Confianza: MEDIA
  Agregar nota: "Degradado por inactividad — re-validar"
```

**Formato obligatorio en cada entrada de memoria:**
```markdown
## [FECHA] [título]
Área: [módulo]
Confianza: ALTA | MEDIA | BAJA
Aplicado: N
Útil: N
Estado: ACTIVO
Última validación: [FECHA]
Creado: [FECHA]
```

---

## Las cuatro capas + señales de confianza

### 1. memoria/trabajo.md
```markdown
Tarea activa: [completada]
Fase: completado
Última actualización: [timestamp]
Ciclos completados: [N]

## Historial reciente (últimas 5)
- [fecha] [descripción] — COMPLETADO | STOP
```

### 2. memoria/errores.md — actualizar contadores
```
Si Aplicado >= 3 y Útil/Aplicado >= 0.7 → Confianza: MEDIA
Si Aplicado >= 7 y Útil/Aplicado >= 0.8 → Confianza: ALTA
Si Aplicado >= 3 y Útil/Aplicado < 0.4  → Confianza: BAJA + nota
Actualizar siempre: Última validación: [hoy]
```

### 3. memoria/patrones.md — igual que errores

### 4. memoria/decisiones.md
```markdown
## [FECHA] [título]
Decisión: [qué]
Razón: [por qué real]
Contexto: [situación]
Alternativas descartadas: [qué más se consideró]
Impacto: [módulos afectados]
Última validación: [FECHA]
Estado: ACTIVO
```

---

## SPECS AUTOMÁTICAS POR MÓDULO

Al completar cada módulo (última fase aprobada por QA), generar automáticamente:

```
.agentic/specs/[nombre-módulo].md
```

Con este formato:

```markdown
# SPEC — [nombre del módulo]
Generado: [fecha]
Última actualización: [fecha]
Estado: IMPLEMENTADO | EN PROGRESO | PENDIENTE

## Qué hace
[descripción en 2-3 líneas — qué resuelve, para quién]

## Criterios de aceptación cumplidos
- [ ] ✓ [criterio de la fase 1]
- [ ] ✓ [criterio de la fase 2]

## Decisiones arquitectónicas
[lista de decisiones de decisiones.md que afectan este módulo]

## Patrones aplicados
[lista de patrones ALTA usados en este módulo]

## Errores conocidos del módulo
[lista de errores registrados con su solución]

## Archivos principales
| Archivo | Rol |
|---------|-----|
| [archivo] | [qué hace] |

## Tests
| Test | Estado | Cobertura |
|------|--------|-----------|
| [nombre] | ✓ | [qué cubre] |

## Notas para el siguiente dev
[cualquier cosa no obvia que el próximo dev necesite saber]
```

**Regla:** Si la spec ya existe → actualizar solo las secciones que cambiaron.
No reescribir lo que no cambió.

---

## LOG DE OBSERVABILIDAD — automático

Al terminar cada ciclo, escribir en `_output/log-[YYYY-MM].md`:

```markdown
## [timestamp] — [tarea]
Módulo: [nombre] | Área KDD: [área]
Context Guard: ✓ | ⚠️ concepto nuevo | 🔍 STOP
Agentes activados: Analista → Front → Back → QA → Memoria
Patrones KDD aplicados: [N] — [lista]
Errores evitados: [N] — [lista]
Tests: [N passing | N failing]
Review automático: [N blockers | limpio]
Fases: [N/N completadas]
Sync grafo: ✓ | ✗ [razón]
Specs actualizadas: [lista de módulos]
Resultado: ✅ COMPLETADO | 🛑 STOP en [agente]
Duración: [aproximada]
```

Un solo archivo por mes. Se acumula automáticamente.
Esto es la observabilidad del sistema — visible en el dashboard.

---

## COMPRESIÓN PERIÓDICA — cada 10 ciclos completados

Cuenta los ciclos en trabajo.md → campo `Ciclos completados`.
Cuando llega a múltiplo de 10, ejecuta compresión:

### Qué comprimir en errores.md
```
Confianza ALTA + Aplicado >= 10 → convertir en patrón permanente
Confianza BAJA + Aplicado >= 5 + Útil/Aplicado < 0.3 → Estado: OBSOLETO
Duplicados o muy similares → fusionar en uno
Sin Última validación en 60 ciclos → Estado: OBSOLETO
```

### Qué comprimir en patrones.md
```
Confianza ALTA sin excepciones → Estado: CONSOLIDADO
Contradictorios → resolver, dejar el más reciente
Sin Última validación en 60 ciclos → degradar a MEDIA
```

### Qué comprimir en decisiones.md
```
Más de 6 meses + no afecta módulos activos → Estado: HISTÓRICO
Mover a sección ## Decisiones históricas al final
```

### Output de compresión
```
🔄 COMPRESIÓN DE MEMORIA (ciclo [N])

errores.md:    Consolidados: N | Obsoletos: N | Fusionados: N
patrones.md:   Consolidados: N | Degradados: N
decisiones.md: Movidas a histórico: N
Entradas sin validar deprecadas: N

Memoria optimizada ✓ — próxima compresión en ciclo [N+10]
```

---

## CARGA SELECTIVA — qué leer según la tarea

`global` = aplica a cualquier módulo.

```
Tarea en módulo conocido →
  Leer: entradas con Área: [módulo] + Área: global
  Ignorar: entradas de otros módulos

Tarea en módulo nuevo →
  Leer: solo Área: global + últimas 3 entradas
```

---

## Regla principal — calidad sobre cantidad

> "¿Un agente en 3 meses necesitará esto para tomar mejores decisiones?"

SÍ registrar: errores generalizables, decisiones con razonamiento,
patrones globales, cambios de estado de módulos.

NO registrar: logs de éxito, errores de sintaxis, detalles en el código.

REEMPLAZAR en lugar de acumular siempre.

---

## Al terminar — output completo

```
✓ MEMORIA KDD ACTUALIZADA

trabajo.md:    ✓ (ciclo N)
errores.md:    [N actualizados | N promovidos]
patrones.md:   [N actualizados | N promovidos]
decisiones.md: [N nuevas]
specs/:        [N módulos actualizados]
Compresión:    [ejecutada | próxima en ciclo N]
Vigencia:      [N patrones verificados | N sin validar]

Sync grafo:    ✓ node .agentic/grafo/grafo.cjs sync
Log:           ✓ _output/log-[mes].md

✅ CICLO COMPLETO: [descripción]
Para la siguiente: aa: [instrucción sugerida]
```

---

## v3.1 — REGISTRAR GATE RESULTS Y EDGES CAUSALES

### Registrar gate_result por fase (OBLIGATORIO)

Al registrar el ciclo, incluir el resultado del harness por cada fase:
```javascript
// En _ciclo_tmp.json → campo fases, agregar gate_result:
fases: [
  {
    num: 1, nombre: "Analista", agente: "analista",
    estado: "COMPLETADO",
    gate_result: "PASS",   // PASS | BLOCK | RETRY
    harness_passed: true,
    intentos: 1,
    ...
  },
  {
    num: 4, nombre: "TDD",
    gate_result: "PASS",
    harness_passed: true,
    // Si hubo healing:
    healing_iterations: 2,
    healing_details: "AssertionError en test X → fix aplicado en src/Y.ts"
  }
]
```

### Registrar edges causales si hubo self-healing

Si el TDD gate requirió más de 1 iteración, registrar:
```bash
# El fallo que se resolvió
node .agentic/grafo/causal-edges.cjs add caused_failure [archivo-problemático] [módulo] "[descripción]"
# El fix que funcionó
node .agentic/grafo/causal-edges.cjs add was_fixed_by [archivo-problemático] "[fix-aplicado]"
# Tests que cubren el área
node .agentic/grafo/causal-edges.cjs add tested_by [archivo-fuente] [archivo-test]
```

### Invalidar edges obsoletos (bi-temporal)

Si una decisión o restricción cambió en este ciclo:
```bash
# Primero ver el edge obsoleto
node .agentic/grafo/causal-edges.cjs query caused_failure
# Invalidar (no borra — preserva historial)
node .agentic/grafo/causal-edges.cjs invalidate [id] "razón del cambio"
```

### Sincronizar knowledge base si hubo cambios en docs/adr

Si en este ciclo se crearon o modificaron ADRs:
```bash
node .agentic/grafo/adr-ingestor.cjs ingest
node .agentic/grafo/knowledge-ingestor.cjs ingest
```


---

## v3.2 — AUDITORÍA DE MEMORIA Y OBSERVABILIDAD

### Al terminar cada ciclo, verificar audit status

```bash
# Health check rápido del sistema
node .agentic/grafo/health-check.cjs

# Si hay stale o contradicciones > 20:
node .agentic/grafo/memory-audit.cjs report
```

### Registrar trail de decisión
```bash
# Ver el trail del ciclo que terminó
node .agentic/grafo/decision-trail.cjs recent 1

# Si alguien pregunta "¿por qué está X?":
node .agentic/grafo/decision-trail.cjs why "[módulo o archivo]"
```

### Métricas al final del sprint (no en cada ciclo)
```bash
# Ejecutar al terminar un sprint completo (no en cada aa:)
node .agentic/grafo/metrics.cjs summary
```

