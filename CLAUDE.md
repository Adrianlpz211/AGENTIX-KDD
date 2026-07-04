# ============================================================
# AGENTIC KDD v2 — CONTROL TOTAL
# ============================================================
# Este archivo reemplaza cualquier CLAUDE.md previo.
# Si tenías instrucciones propias, pégalas al final
# en la sección "INSTRUCCIONES DEL PROYECTO".
# ============================================================

## PRIORIDAD ABSOLUTA

`aa:` y `audit:` anulan TODO lo demás.
No importa qué otros archivos de contexto existan en el proyecto.
No importa qué instrucciones previas había en este CLAUDE.md.
Cuando aparecen esos comandos — solo existe Agentic KDD.

## CUANDO VES aa: sprint

Lee `.agentic/agentes/09-sprint.md` y ejecuta su protocolo completo.
Coordina múltiples tareas encadenadas donde el output de cada una alimenta la siguiente.
La memoria KDD fluye entre todas las tareas del sprint.

Variantes:
- `aa: sprint — [objetivo]` con lista de tareas explícitas
- `aa: sprint — [objetivo]` sin lista → inferir tareas y proponer antes de ejecutar
- `aa: sprint skip` → saltar tarea actual y continuar
- `aa: sprint abort` → cancelar sprint, mantener lo completado

---

## CUANDO VES aa: aprende

Lee `.agentic/agentes/08-aprende.md` y ejecuta su protocolo completo.
Analiza el código del proyecto, detecta patrones/errores/decisiones implícitas
y propone qué registrar en memoria KDD — siempre pregunta antes de escribir.

Variantes: `aa: aprende`, `aa: aprende — módulo [x]`, `aa: aprende [archivo]`,
`aa: aprende — error: [x]`, `aa: aprende — decisión: [x]`, `aa: aprende — patrón: [x]`

---

## CUANDO VES aa: help

Mostrar exactamente esto:

```
╔══════════════════════════════════════════════════╗
║  AGENTIC KDD v2 — Comandos disponibles          ║
╚══════════════════════════════════════════════════╝

Pipeline de desarrollo:
  aa: configurar          → configuración inicial del proyecto
  aa: [tu tarea]          → pipeline completo autónomo
  aa: continúa — [resp]   → retomar después de un STOP
  aa: aprende             → absorber conocimiento de trabajo hecho fuera del pipeline
  aa: help                → muestra este menú

Departamento QA:
  audit: help             → muestra comandos de auditoría
  audit: auditar          → auditoría completa
  audit: [área]           → auditoría específica

Consulta del grafo (en terminal):
  akdd graph              → estado del grafo de conocimiento
  akdd update             → actualizar Agentic KDD
```

## CUANDO VES aa:

```
0. Correr: node .agentic/grafo/context-enricher.cjs "[tarea tal cual la escribió el usuario]"
   → leer el brief que imprime (riesgo estimado, avisos, contratos, alertas activas)
   → nunca bloquea: si falla, no encuentra nada, o da error — seguir igual, es un plus
1. Leer .agentic/config.md
2. Leer .agentic/memoria/trabajo.md
3. Si CONFIGURADO: NO → Setup primero
4. Ejecutar pipeline completo sin pausar entre agentes
   → En la fase de construcción: si la tarea es Front + Back a la vez Y sus archivos NO
     se cruzan, invocar 03-front.md y 04-back.md EN PARALELO (ver MODO LEGIÓN abajo,
     Fase 2 del Sistema de Agentes Lite). Si hay cualquier duda de cruce, o es solo un
     lado → secuencial, un solo autor, como siempre.
5. No pedir confirmación al usuario entre fases
6. Detener SOLO ante STOP genuino
```

Flujo completo:
Context Enricher → Orquestador (.agentic/agentes/01-orquestador.md) → Analista → Front/Back (paralelo si aplica, ver MODO LEGIÓN) → QA → Memoria

## CUANDO VES audit:

```
1. Leer .audit/AUDIT.md
2. Activar Director + subagentes indicados
3. Generar reporte en _output/audit-[fecha].md
4. NO tocar código — solo auditar
```


## CUANDO VES akdd <comando>

Si el usuario escribe `akdd <comando>` en el chat, llamar el MCP tool correspondiente.
El usuario NO necesita abrir terminal — funciona igual desde aquí.

| Usuario escribe | MCP tool a llamar |
|---|---|
| `akdd health` | `system_health` |
| `akdd health --fix` | `system_health` con `{fix: true}` |
| `akdd update` | `update_project` |
| `akdd collab init` | `collab_init` |
| `akdd collab invite` | `collab_invite` |
| `akdd collab status` | `collab_status` |
| `akdd metrics` | `metrics_summary` |
| `akdd benchmarks` | `report_benchmarks` |
| `akdd trail` | `recent_ciclos` |
| `akdd cure` | `mem_curate` |
| `akdd cure report` | `mem_curate` con `{mode: "report"}` |
| `akdd llms` | `generate_llms_txt` |
| `akdd ast` | `ast_index` |
| `akdd ast-impact <f>` | `ast_impact` con `{target: "<f>"}` |
| `akdd why <f>` | `decision_why` con `{target: "<f>"}` |
| `akdd audit` | `memory_audit` |
| `akdd causal-prune` | `causal_prune` |
| `akdd hooks` | correr `node .agentic/grafo/install-hooks.cjs` |
| `akdd reason status` | correr `node .agentic/grafo/reasoning-bank.cjs status` |
| `akdd reason recall <query>` | correr `node .agentic/grafo/reasoning-bank.cjs recall "<query>"` |

Los comandos que SÍ requieren terminal (solo estos dos):
- `npm install -g agentic-kdd` → instalar el CLI por primera vez
- `akdd init` → primera instalación en un proyecto nuevo

Todo lo demás corre desde el chat.

## SIN aa: O audit:

Responder normalmente usando el contexto del proyecto.

## ARCHIVOS CLAVE

- `.agentic/config.md`     → cerebro del proyecto
- `.agentic/PLAN.md`       → tarea activa
- `.agentic/memoria/`      → memoria KDD persistente
- `.agentic/agentes/`      → instrucciones de cada agente
- `.agentic/conocimiento/` → docs del proyecto
- `.audit/`                → Departamento QA



## RECUPERACIÓN DE SESIÓN

Si el usuario pega un bloque que empieza con `# Checkpoint Agentic KDD`:
1. Leer el checkpoint completo
2. Cargar el contexto de la última tarea y las anteriores
3. Responder: "✅ Contexto recuperado — continuando desde: [última tarea]"
4. Estar listo para ejecutar la siguiente instrucción con ese contexto

Si el usuario escribe `akdd historial`:
→ Llamar MCP tool `session_historial`
→ Mostrar el resultado formateado


## DRY-RUN MODE — aa: --dry-run

Si el usuario escribe `aa: --dry-run <tarea>`:

1. Correr Orquestador → Analista → Dev (SOLO planificación)
2. El Dev describe los cambios que HARÍA sin ejecutarlos:
   - Lista de archivos que modificaría
   - Diff propuesto por archivo (pseudocódigo o diff real si es posible)
   - Contratos que verificaría
   - Blast radius estimado
3. Presentar como:
   ```
   📋 DRY-RUN: [tarea]
   
   Archivos que modificaría:
     - src/auth.ts (líneas 45-67: cambio de lógica de refresh token)
     - src/session.ts (línea 12: actualizar TTL)
   
   Contratos en riesgo: AUTH-001 (PROTECTED), AUTH-004 (VERIFIED)
   Blast radius: HIGH (8 contratos)
   
   ¿Proceder con implementación real? (aa: implement [tarea])
   ```
4. NO escribir ningún archivo. NO correr tests. NO modificar memoria.
5. El dev decide si proceder con `aa: implement <tarea>`


## DENY LIST — Operaciones que requieren confirmación explícita

NUNCA ejecutar estas operaciones sin confirmación explícita en el chat:

```
REQUIEREN CONFIRMACIÓN EXPLÍCITA DEL DEV:
  - rm -rf / rmdir /s  → eliminar directorios completos
  - DROP TABLE / DROP DATABASE → operaciones SQL destructivas
  - DELETE FROM [tabla] sin WHERE → borrado masivo
  - git push --force → force push a ramas protegidas
  - npm publish → publicar paquetes npm
  - docker rm / docker rmi → eliminar contenedores/imágenes
  - Modificar .env, .env.production, secrets.* → archivos de secretos
  - Migraciones SQL irreversibles → ALTER TABLE DROP COLUMN
  - Deploy a producción → cualquier comando que afecte prod
```

Si el pipeline genera una de estas operaciones:
1. STOP el pipeline
2. Mostrar exactamente qué operación intentaría correr
3. Preguntar confirmación explícita: "¿Confirmas ejecutar: [comando]?"
4. Solo proceder si el dev responde SÍ explícitamente




## REGRESSION GUARD — Steps 4 y 9 del pipeline aa:

### Step 4 — ANTES del build (Regression Check)

Para TODA tarea aa: que modifique archivos existentes:

1. Identificar archivos del changeset
2. Consultar protected_behaviors relacionados con esos archivos
3. Si hay behaviors HIGH confidence:
   - Correr los test_patterns de ese behavior
   - Si alguno falla → STOP:
     "🛑 REGRESSION GUARD: El cambio que vas a hacer rompería [módulo] que
      estaba funcionando correctamente. Test [pattern] falla actualmente.
      Arregla eso primero o usa --override-regression si el cambio es intencional."
4. Si hay behaviors MEDIA confidence → WARN y continúa
5. Si no hay behaviors → continúa normalmente

### Step 9 — DESPUÉS del ciclo exitoso (Regression Register)

Después de TDD Gate PASS + QA PASS + Preservation Gate PASS:

1. El TDD Gate ya llama registerBehavior() automáticamente
2. Verificar que behaviors relacionados no fueron silenciosamente rotos
3. Si verifyAfterTDD() encuentra violations → WARN en el reporte final:
   "⚠️  REGRESSION: [módulo] muestra signos de regresión. Revisar."
4. Actualizar last_verified_at de todos los behaviors verificados

### Escalado de confianza
  pass_count 1-4  → MEDIA  (emerging — warn but don't block)
  pass_count 5+   → HIGH   (protected — block if broken)

### Comandos disponibles
  node .agentic/grafo/regression-guard.cjs status
  node .agentic/grafo/regression-guard.cjs check <file1> <file2>
  node .agentic/grafo/regression-guard.cjs deprecate <id>
  node .agentic/grafo/regression-guard.cjs fix <id>

## SPEC GATE — Step 2 del pipeline aa:

Antes del Build step, para TODA tarea aa: que incluya cambios de valores:

1. Extraer valores numéricos y strings del prompt
2. Verificar contra memoria: ¿existe alguno como regla HIGH/MEDIA confidence?
3. Si hay contradicción:
   - HIGH confidence → STOP con mensaje exacto:
     "⛔ SPEC GATE: '[campo]' en memoria = [valor_memoria] pero el prompt
      pide [valor_nuevo]. Esto contradice la regla: '[titulo_nodo]'
      ¿Confirmas que quieres cambiar esta regla de negocio?"
   - MEDIA confidence → WARN y continúa:
     "⚠️ SPEC GATE: '[campo]' puede contradecir una regla en memoria.
      Verificando antes de implementar."
4. Si no hay contradicción → continúa normalmente

Valores que SIEMPRE se verifican contra memoria:
  trial_days, trial_period, yearly_discount, password_min,
  invoice_prefix, max_users, max_api_calls, rate_limit, timeout

## SECURITY GATE — Step 3 del pipeline aa:

Cuando el changeset incluye archivos CRITICAL o SENSITIVE:

CRITICAL: auth.ts, middleware/, .env, secrets, jwt, token
SENSITIVE: routes/, lib/prisma, collab-manager, harness

Antes del Build step:
1. Clasificar archivos del changeset por riesgo
2. Para archivos CRITICAL/SENSITIVE, verificar:
   a. ¿Hay queries sin filtro tenant_id? → STOP si sí
   b. ¿Hay cross-tenant access protegido solo con 'admin'? → STOP
      (admin = tenant-level, superadmin = platform-level)
   c. ¿Hay JWT bypass o debug flags? → STOP
   d. ¿Hay reply.status().send() sin return? → WARN
3. Si hay findings CRITICAL → STOP con reporte completo
4. Si hay findings HIGH → WARN + continúa con advertencia visible
5. Si no hay findings → PASS, continúa normalmente

### Escudo (v3.8.4) — corre sobre TODOS los archivos del changeset
Además de los checks de tenant/JWT/auth (que solo aplican a CRITICAL/SENSITIVE),
el gate ahora escanea **todos** los archivos en busca de:
  - **Secretos/credenciales** (llaves privadas, tokens de proveedor, connection
    strings con password, JWT, Bearer literales) → CRITICAL = STOP.
  - **PII** (correos, tarjetas con validación Luhn) → WARN.
  - **Prompt-injection** (instrucciones maliciosas escondidas, exfiltración,
    "reveal prompt") → HIGH/CRITICAL según el caso.
  - **Unicode invisible** (inyección oculta) → WARN.
Robusto: redacta los secretos en el reporte, da número de línea, y descarta
falsos positivos (placeholders, `process.env`, emails de ejemplo).

El Security Gate NO reemplaza el audit: seguridad completo.
Es una verificación rápida antes del Build para los patrones más comunes.

## MODO LEGIÓN — sub-agentes en paralelo (v3.9)

La "Iron Legion" de Agentix: en los pasos de **OJOS** (leer/analizar/revisar) el
pipeline puede desplegar sub-agentes EN PARALELO, y el orquestador **fusiona sus
resultados de forma determinista**. En los pasos de **MANOS** (escribir código,
guardar memoria) se trabaja con un solo autor coherente — NUNCA en paralelo.

### Dónde SÍ (ojos)
- **Analista** → exploración en paralelo (ver `.agentic/agentes/02-analista.md`, MODO LEGIÓN).
- **QA / Review** → lentes en paralelo (ver `.agentic/agentes/05-qa.md`, MODO LEGIÓN).
- **audit:** → ya es Legión (7 subagentes en paralelo).

### Dónde NO (manos) — con una excepción condicional (Fase 2, v3.11.1)
- **Build / Front / Back** → un solo autor por defecto (paralelizar rompe: se pisan los archivos).
  **Excepción — IMPERATIVO, NO OPCIONAL SI SE CUMPLE LA CONDICIÓN:**
  Si la tarea requiere Front Y Back a la vez, Y ya verificaste que los archivos que cada
  uno va a tocar NO se cruzan (ningún archivo en común) → **NO implementes front y back
  tú mismo, uno después del otro.** Tienes que invocar tu herramienta de sub-agentes
  (Task/Agent) **DOS VECES, en el mismo mensaje** — una pasándole el contenido de
  `.agentic/agentes/03-front.md` + el brief de la fase, otra pasándole
  `.agentic/agentes/04-back.md` + el mismo brief — exactamente el mismo mecanismo
  mecánico que ya usas para lanzar los 7 subagentes de `audit: auditar`. Si tu entorno
  no tiene herramienta de sub-agentes disponible, cae a la regla de degradación de abajo
  (secuencial, un solo autor) — pero si SÍ la tienes disponible (como ahora mismo, en
  esta sesión), úsala, no la ignores y sigas trabajando tú mismo de corrido.
  Espera los dos resultados antes de seguir a TDD/QA — ninguno dispara al otro como en
  el flujo secuencial. Si hay CUALQUIER duda de que los archivos se crucen, o la tarea es
  solo front o solo back → un solo autor, secuencial, como siempre. Ante la duda,
  secuencial — nunca arriesgar un archivo pisado por ganar velocidad.
- **Memoria / post-cycle** → escritura única coherente.

### Regla de degradación (OBLIGATORIA — no rompe nada)
La Legión es una **optimización, no un requisito**:
- Si el entorno soporta sub-agentes en paralelo (Claude Code, Cursor — confirmado en
  producción con benchmarks 100% Cursor desde el origen de Agentix) → desplegar la Legión.
- Si NO los soporta o es más limitado (algún entorno específico sin esa capacidad) → correr
  esos pasos **SECUENCIALMENTE** como siempre. El resultado debe ser **idéntico**, solo un
  poco más lento. **Jamás bloquear, fallar ni cambiar el veredicto por no poder paralelizar.**

### Control (no es swarm)
- Solo lectura/análisis/juicio en paralelo — nunca escritura.
- Máximo 4 sub-agentes por paso, cada uno con encargo autónomo y resumen compacto.
- El orquestador (no los sub-agentes) fusiona y decide. Determinista.

## ENCADENAMIENTO DE COMANDOS

Si el mensaje tiene esta forma:
```
aa: <tarea> audit: <tipo>
```
O cualquier combinación de `aa:` seguido de `audit:`, `ag:` u otro comando al final:

1. Ejecuta el pipeline `aa:` completo para la tarea
2. Al terminar, ejecuta automáticamente el comando encadenado
3. Reporta ambos resultados juntos al final

Ejemplos válidos:
```
aa: implementa el módulo de pagos audit: frontend
aa: refactoriza auth.ts audit: seguridad
aa: agrega las invitaciones ag: review src/routes/invitations.ts
```

El encadenamiento solo aplica cuando el segundo comando está AL FINAL del mensaje,
separado por espacio. No interrumpir el pipeline principal para ejecutarlo antes.


## QA MEJORADO — VALIDACIÓN CONTRA HISTORIAL

En la fase QA de cada ciclo `aa:`, además de verificar los criterios de aceptación
de la tarea actual, verificar lo siguiente contra la memoria del proyecto:

1. **Spec compliance** — ¿El comportamiento nuevo contradice alguna decisión
   documentada en memoria con confianza HIGH o MEDIA?
   Si sí → STOP con reporte exacto de la contradicción.

2. **Error pattern check** — ¿Alguno de los cambios toca un área donde hay
   errores HIGH confidence en memoria?
   Si sí → ejecutar los tests específicos de esa área antes de declarar PASS.

3. **Contract preservation** — El Preservation Gate ya cubre esto, pero en QA
   también verificar que los contratos VERIFIED del módulo afectado siguen verdes.

4. **Behavioral consistency** — Si hay specs en `.agentic/specs/` para el módulo
   tocado, verificar que el comportamiento nuevo es consistente con el spec.

Si alguno de estos checks falla → QA FAIL con razón específica, no solo
"tests failing". El dev necesita saber exactamente qué spec, qué error histórico
o qué contrato se está violando.


## DETECCIÓN Y CORRECCIÓN AUTÓNOMA DE PATRONES

Cuando durante un ciclo `aa:` encuentres el mismo patrón de error/bug en otros
módulos del proyecto, aplica esta lógica automáticamente:

### Paso 1 — Prerequisite check
Antes de aplicar los hallazgos, verificar si alguno bloquea la validación
del fix principal:
- ¿Algún módulo con el patrón es una dependencia del fix actual?
- Si SÍ → corrígelo PRIMERO, luego el fix pedido

### Paso 2 — Clasificar por riesgo (tabla de criticidad)
Para cada hallazgo, determinar el nivel de riesgo del archivo:

| Nivel     | Acción autónoma                                    |
|-----------|---------------------------------------------------|
| CRITICAL  | NUNCA tocar solo — siempre avisar primero          |
| SENSITIVE | Solo tocar si hay contrato verificado que respalde |
| NORMAL    | Actuar solo si el patrón ya está en memoria        |
| FREE      | Actuar siempre autónomamente                       |

### Paso 3 — Aplicar
- Archivos AUTO_FIX → corregir en el mismo ciclo sin preguntar
- Archivos WARN → incluir en el reporte final como pendientes

### Paso 4 — Reporte al final del ciclo
Al terminar, incluir en el reporte:
```
✅ Tarea completada: [descripción]

🔍 Patrones detectados y corregidos autónomamente:
   - [módulo]: [qué se corrigió] (riesgo: NORMAL, historial: 3x)
   
⚠️  Patrones detectados — requieren confirmación:
   - [módulo]: [qué encontré] (riesgo: CRITICAL — revisar manualmente)
```

NO preguntar en medio del ciclo. NO interrumpir. Actuar y reportar al final.

## DETECCIÓN AUTOMÁTICA DE TAREAS SIN aa:

Esta regla actúa como red de seguridad para cuando el dev olvida escribir `aa:`.

Si el mensaje NO tiene `aa:` pero cumple los criterios de abajo,
trátalo exactamente como si tuviera `aa:` — ejecuta el pipeline completo.

### TRATAR COMO aa: si el mensaje:
- Empieza con verbo de acción técnica:
  "implementa", "crea", "crea un", "fix", "arregla", "agrega", "añade",
  "modifica", "refactoriza", "conecta", "integra", "genera", "construye",
  "desarrolla", "corrige", "actualiza", "migra", "convierte", "extrae",
  "aplica", "añade soporte", "haz que", "necesito que"
- Menciona un archivo o módulo específico: "en auth.ts", "en el módulo de pagos", "en src/"
- Tiene contexto técnico claro con intención de cambio: "el bug de X", "la feature de Y", "el error en Z"
- Empieza con prefijo técnico: `fix:` / `feat:` / `build:` / `dev:` / `chore:`

### NO ejecutar el pipeline si:
- Es una pregunta (termina en `?`)
- Empieza con: "explícame", "qué es", "cómo funciona", "cuándo", "por qué", "dónde", "muéstrame", "dame", "qué piensas"
- Es una consulta de estado: `akdd buscar`, `akdd health`, `akdd metrics`, `akdd trail`
- Es una conversación sobre el proyecto, no una acción sobre él

### Comportamiento al detectar tarea sin aa:
Antes de ejecutar, mostrar exactamente:
```
🔄 Detecté una tarea de desarrollo — ejecutando como aa:
```
Luego proceder con el pipeline completo como si el dev hubiera escrito `aa:`.


# ============================================================
# INSTRUCCIONES DEL PROYECTO — agregar las tuyas aquí abajo
# ============================================================

## MODO EXPLORE — aa: explore [objetivo]

Antes de implementar, pensar junto al dev sin escribir código.

Si el mensaje empieza con `aa: explore` o `aa: think`:

1. Leer `.agentic/config.md` y memoria relevante
2. Analizar el objetivo: ¿qué implica? ¿qué riesgos hay? ¿qué alternativas existen?
3. Presentar:
   ```
   🔍 EXPLORE: [objetivo]
   
   Opciones de implementación:
     A) [enfoque 1] — pros/contras
     B) [enfoque 2] — pros/contras
   
   Contratos en riesgo: [lista]
   Blast radius estimado: [ALTO/MEDIO/BAJO]
   Archivos que tocaría: [lista]
   
   ¿Arrancamos con aa: [opción elegida]?
   ```
4. NO escribir ningún archivo. NO correr tests. Solo análisis.

---

## CONTRACT GUARD — Registro automático post-TDD Gate

Después de cada TDD Gate PASS en cualquier ciclo `aa:`, ejecutar:

```
node .agentic/grafo/tdd-gate.cjs run [area]
```

Donde `[area]` es el nombre del módulo implementado (ej: `clients`, `auth`, `invoices`).

**Esto es obligatorio.** Sin este paso los contratos no se acumulan.

---

# ============================================================
# INSTRUCCIONES DEL PROYECTO — agregar las tuyas aquí abajo
# ============================================================

## LOCK MANAGER — Desarrollo multi-instancia

Cuando múltiples instancias de Cursor o Claude Code trabajan en el mismo proyecto,
usar lock-manager.cjs para evitar colisiones.

### Al INICIO de cada ciclo aa:
```
node .agentic/grafo/lock-manager.cjs acquire --module=[área] --files=[archivos] --purpose=[tarea]
```
Si retorna 🔴 → STOP. Otro agente está trabajando en ese módulo. Esperar o elegir otro módulo.

### ANTES de cualquier migration de Prisma o schema:
```
node .agentic/grafo/lock-manager.cjs acquire-schema --purpose=migration
```
Si retorna 🔴 → STOP. No correr migrations hasta que el schema esté libre.

### AL TERMINAR cada ciclo aa: (después de Memory step):
```
node .agentic/grafo/lock-manager.cjs release --module=[área]
node .agentic/grafo/lock-manager.cjs release-schema   # solo si se adquirió
```

### Comandos disponibles
```
akdd locks                → ver locks activos
akdd locks release-all    → liberar todos los locks de esta instancia
akdd locks check --files=src/auth.ts,src/middleware.ts → verificar archivos
```

### Reglas
- NUNCA adquirir lock de un módulo que ya tiene otro agente
- Renovar el lock si la tarea tarda más de 25 minutos: `lock-manager.cjs renew --module=[área]`
- Si Cursor crashea, los locks expiran solos en 30 minutos
- Schema lock: máximo 10 minutos — solo para el tiempo de la migration

## POST-CYCLE — OBLIGATORIO después de CADA ciclo aa: exitoso

⛔ SIN EXCEPCIÓN. NO es opcional. NO depende del usuario pedirlo.

> NOTA (v3.7.0): si los git hooks están instalados (`akdd hooks`, o automático en
> `akdd init` / `akdd update`), post-cycle se dispara solo tras cada commit, en segundo
> plano y sin bloquear el commit. El comando manual de abajo sigue siendo válido.

```bash
node .agentic/grafo/post-cycle.cjs [área] --tests=[N] --task="[descripción]"
```

Ejemplo:
```bash
node .agentic/grafo/post-cycle.cjs auth --tests=24 --task="JWT multi-tenant auth"
```

Resuelve automáticamente:
- Ciclo registrado en BD (+1 al contador)
- Contratos acumulados (tdd-gate run)
- Módulo documentado en config.md
- Patrones Node.js detectados y escritos
- Spec del módulo generada en .agentic/specs/
- Log de observabilidad escrito
- Config guardada en project_settings
- Grafo sincronizado

**Si NO corres post-cycle.cjs: el dashboard nunca sube del 57%, los ciclos no se cuentan, los contratos no se acumulan.**
