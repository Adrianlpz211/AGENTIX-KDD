# Decisiones arquitectónicas — KDD Layer 4
<!--
Esta es la capa más importante de KDD.
No registra QUÉ se hizo — registra POR QUÉ se hizo así.
Cuando un agente entiende el razonamiento detrás de una decisión,
puede tomar decisiones coherentes en situaciones nuevas no cubiertas por las reglas.

Formato:
## [FECHA] Título de la decisión
Decisión: qué se decidió
Razón: por qué (el razonamiento real, no "porque sí")
Contexto: qué situación llevó a esta decisión
Alternativas descartadas: qué más se consideró y por qué no
Impacto: qué módulos o patrones afecta
-->

## Registro de decisiones

## [2026-07-12] Período de prueba: 14 días fijos — SUPERSEDED
Decisión: el período de prueba (trial) es de exactamente 14 días, sin flexibilidad
Razón: es una decisión de producto ya tomada por el usuario. No es negociable
       ni configurable sin aprobación explícita del usuario.
Contexto: registro preventivo antes de implementar features que involucren
          lógica de trial/expiración.
Alternativas descartadas:
  - Trial configurable por admin: descartado — el usuario especificó que es fijo
  - Trial variable por plan: descartado — no aplica, es un valor único
Impacto: cualquier módulo de billing, suscripciones o acceso debe respetar
         este valor hardcoded (14 días) hasta que el usuario apruebe un cambio.
Superseded por: decisión del 2026-07-12 (mismo día) — ver entrada siguiente.

## [2026-07-12] Período de prueba: 7 días (test A/B de conversión) — GLOBAL
Decisión: el período de prueba (trial) se cambia de 14 a **7 días** en todo
          el proyecto (todos los benchmarks y escenarios).
Razón: el owner quiere probar si un período más corto mejora la conversión.
       Confirmado explícitamente por el owner en chat.
Contexto: cambio global solicitado con `aa:`. Se actualizó config/plans.json
          en las 6 copias existentes (vscode, arena, arena-a, arena-b,
          opencode, scenarios/03-cross-session-memory/seed).
Alternativas descartadas: ninguna — cambio directo de valor, sin lógica nueva.
Impacto: config/plans.json (trialDays: 14 → 7) en las 6 copias. src/billing.js
         no requirió cambios — consume plans.trialDays dinámicamente. Verificado
         con trialEndDate() que el nuevo período da exactamente 7 días.
Estado: ACTIVO — 🔒 LOCKED: no cambiar sin aprobación explícita del owner.

## [2026-07-15] Estrategia de dos capas en AST indexer — la capa 2 nunca se conectó
Decisión: (inferida del código) el indexador AST se diseñó con dos capas: regex
          fallback siempre disponible + tree-sitter opcional para precisión —
          pero solo la capa 1 se implementó de punta a punta; la capa 2 quedó
          como wrapper sin invocar.
Razón: la capa regex cubre 12+ lenguajes sin dependencias; el costo real de
       tree-sitter (peso de grammars + escribir extracción por lenguaje) se
       pospuso indefinidamente.
Contexto: aa:aprende (2026-07-15), investigando por qué line_end nunca se llena.
          La cabecera de ast-indexer.cjs declara la estrategia; tryTreeSitter
          existe pero sin llamadas ni dependencias instaladas.
Alternativas descartadas: desconocidas — inferido del código, verificar con el equipo.
Impacto: toda la precisión actual del grafo AST (símbolos, edges, PageRank,
         análisis de impacto) sale del fallback regex. Cualquier mejora de
         precisión debe o conectarse a la capa 2 o diseñarse para la capa 1.

## [2026-07-15] Tree-sitter por vía WASM, no nativa — evita compilación en Windows
Decisión: (inferida del código) si algún día se conecta tree-sitter, la vía
          elegida en el wrapper es web-tree-sitter + grammars .wasm — NO el
          binding nativo (node-gyp).
Razón: los binarios nativos ya causaron dolor real en este proyecto en Windows
       (tar, better-sqlite3 relegado a optionalDependency); WASM instala sin
       compilar nada en la máquina del usuario.
Contexto: aa:aprende (2026-07-15) — tryTreeSitter en ast-indexer.cjs:504 usa
          require('web-tree-sitter') y busca grammars en tree-sitter-wasms/out/.
Alternativas descartadas:
  - tree-sitter nativo: requiere toolchain de compilación — la pared "cara"
  - parser JS puro (@babel/parser): exacto y liviano pero solo JS/TS, no los
    12 lenguajes que el indexador soporta
Impacto: si se retoma la fase 2 de precisión, arrancar por web-tree-sitter +
         tree-sitter-wasms, no por el binding nativo.

---

## Ejemplos de cómo se verá este archivo:

<!--
## [2026-06-15] Modales persistentes por defecto
Decisión: todos los modales que pueden abrir otros modales se implementan como persistentes
Razón: al abrir un modal secundario y volver al primario, los datos ingresados
       se perdían porque el DOM se destruía al cerrar. Esto causaba frustración
       y pérdida de trabajo en formularios largos.
Contexto: detectado por QA durante revisión del módulo de admisión.
          El usuario abría el modal de paciente, luego el de seguro médico,
          y al cerrarlo los datos del paciente habían desaparecido.
Alternativas descartadas:
  - Guardar en localStorage: complica el código y genera estado inconsistente
  - Confirmación antes de cerrar: mala UX, interrumpe el flujo
Impacto: aplica a todos los módulos con modales anidados

## [2026-06-20] PDO sobre ORM para este proyecto
Decisión: usar PDO directo en lugar de Eloquent u otro ORM
Razón: el proyecto hereda un schema de BD legacy con convenciones
       inconsistentes que un ORM manejaría mal. PDO da control total
       sobre las queries y es más predecible en este contexto.
Contexto: al intentar usar Eloquent, los nombres de columnas no seguían
          las convenciones esperadas y requería demasiada configuración custom.
Alternativas descartadas:
  - Eloquent: demasiado acoplado a convenciones Laravel
  - TypeORM: overhead innecesario para el scope del proyecto
Impacto: todos los modelos del proyecto usan PDO con prepared statements
-->
