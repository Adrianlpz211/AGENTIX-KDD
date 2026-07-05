<div align="center">

<img src="assets/logo.svg" alt="Agentix KDD" width="600">

### La armadura de tu IA de código.

<p>
<img src="https://img.shields.io/badge/versión-3.11.3-3FE2E8?style=for-the-badge&labelColor=0A0E14" alt="version"/>
<img src="https://img.shields.io/badge/licencia-MIT-D9A33C?style=for-the-badge&labelColor=0A0E14" alt="license"/>
<img src="https://img.shields.io/badge/Claude_Code_·_Cursor-listo-8A97A6?style=for-the-badge&labelColor=0A0E14" alt="compat"/>
</p>

**Un equipo de Dev's de un solo hombre.**

[English](README.md) · Español

</div>

---

## Qué es

**Agentix KDD** no es otra IA que programa por ti. Es la **armadura** que se le pone a la IA que ya usas — de forma nativa en **Claude Code y Cursor** — para que **recuerde, no rompa lo que funcionaba, y no se contradiga**.

Vive **dentro de tu proyecto**: lee tu código, guarda cada decisión y cada error en una memoria persistente, y usa todo eso para que la siguiente tarea sea más segura que la anterior. Tú sigues con tu editor de siempre; Agentix lo blinda por debajo.

> Agentix hace que la IA de código **recuerde, respete y preserve el proyecto mientras evoluciona.**
> Convierte el código del proyecto en una **memoria operativa que gobierna el comportamiento futuro de la IA.**

> *KDD = Knowledge-Driven Development — desarrollo guiado por el conocimiento acumulado del propio proyecto. (Paquete npm: `agentic-kdd`.)*

---

## El problema que resuelve

Abres Cursor o Claude Code. Le explicas tu proyecto *otra vez*. La IA empieza de cero *otra vez*. Rompe algo que ya funcionaba *otra vez*. Cambia una regla de negocio sin acordarse de por qué estaba así.

No estás programando — estás cuidando el contexto a mano. **Agentix se encarga de eso.**

---

## Las tres piezas de la armadura

| | Pieza | Qué hace |
|---|-------|----------|
| ⚓ | **Ancla** — memoria | Recuerda decisiones, reglas y errores entre sesiones. Búsqueda semántica real (embeddings locales) para traer lo relevante en el momento justo. |
| 🔧 | **Palanca** — verificación | Antes de aceptar un cambio, **corre los tests y comprueba que no rompió lo que funcionaba**. Si algo se rompe, lo dice — no declara "verde" en falso. |
| 🔨 | **Martillo** — autonomía | Detecta y corrige problemas por su cuenta (incluida seguridad), y te lo reporta. Tú lees el resultado. |

---

## Cómo funciona

Agentix usa una **memoria de 4 capas** (arquitectura CoALA) guardada en **SQLite dentro de tu proyecto** — tuya, sin nube, sin suscripción:

```
Working    → contexto de la tarea actual
Procedural → patrones, errores y decisiones (las reglas de tu proyecto)
Episódica  → qué se intentó, en qué orden, por qué funcionó o falló
Semántica  → grafo de módulos, APIs y dependencias — qué rompe qué
```

Sobre esa memoria corren los **gates** que protegen tu trabajo:

- **Spec Gate** — frena un cambio que contradice una regla de negocio guardada (ej. cambiar una tarifa fijada) y pide confirmación.
- **Regression Guard + TDD Gate** — corren la suite real; si un cambio rompe un test que pasaba, se detienen.
- **Security Gate** — revisa los archivos sensibles (auth, multi-tenant) antes de escribir.

---

## Despacho de sub-agentes — con correa, no un swarm aparte

Sobre el pipeline secuencial, Agentix puede desplegar sub-agentes especializados en
paralelo para 3 momentos concretos del ciclo `aa:` — reusando exactamente el mismo
mecanismo que ya usaba `audit: auditar` (el asistente invocando su propia herramienta de
sub-agentes varias veces en un mensaje), sin infraestructura nueva ni depender de un
swarm externo.

1. **Context Enricher** — antes de que arranque cualquier `aa:`, consulta memoria
   episódica/procedimental, contratos activos y alertas pendientes, y le entrega al
   pipeline un brief de riesgo en vez de una tarea pelada. Nunca bloquea: si no encuentra
   nada, el pipeline sigue exactamente igual que antes.
2. **Front/Back en paralelo** — cuando una tarea de verdad necesita frontend y backend a
   la vez, y sus archivos no se cruzan, los dos se construyen al mismo tiempo en vez de
   que uno dispare al otro — mismo mecanismo de sub-agentes, con verificación explícita
   de que ningún archivo lo toquen los dos.
3. **QA con 4 lentes** — antes de aprobar una fase, corren 4 revisores independientes en
   paralelo (seguridad, decisiones/patrones, errores conocidos, cumplimiento de spec) en
   vez de un solo criterio juzgando todo. En una prueba real, esto encontró un bug de
   concurrencia en un fix de sesión de WhatsApp que una revisión de un solo autor se
   había saltado — el diff se veía bien por sí solo; el bug solo apareció al cruzarlo
   contra el código fuente de la librería externa.

Misma regla de degradación que todo lo demás aquí: si el entorno no soporta sub-agentes
en paralelo, cae a secuencial — mismo resultado, solo más lento, nunca se rompe por no
poder paralelizar.

---

## Inicio rápido

```bash
# 1. Instalar el CLI
npm install -g agentic-kdd

# 2. En tu proyecto
cd tu-proyecto
akdd init

# 3. Abre en Claude Code o Cursor y escribe:
aa: configurar
```

Listo. Agentix lee tu proyecto y se configura solo. A partir de ahí, cada tarea empieza con `aa:`.

---

## Compatibilidad

Agentix es **primera clase en Claude Code y Cursor** — es donde está **probado a fondo**. Como su motor se apoya en **estándares abiertos** (`AGENTS.md` y **MCP**), también *debería* funcionar con otros agentes (VS Code, Windsurf, Kiro, Aider…), pero por honestidad: **por ahora solo está probado a fondo en Claude Code y Cursor**. Si lo pruebas en otro IDE y te funciona, abre un issue y lo sumamos a la lista de "probados".

---

## Comandos — qué corre solo y qué corres tú

> **Leyenda:** 🟢 automático (corre solo) · 🔵 disparador (lo escribes en el chat) · ⚪ manual (terminal, solo cuando lo necesites)

### 🟢 Lo que pasa SOLO — no escribes nada

Desde la v3.7+, esto se registra **automáticamente, en segundo plano y a 0 tokens**:

| Cuándo | Qué pasa solo |
|--------|---------------|
| En cada **commit** de git | Cierra el ciclo: **registra el ciclo**, **acumula contratos**, indexa el código (AST incremental) y sincroniza el grafo |
| Cada **5 ciclos** | Guarda un **checkpoint** para retomar en otro chat o PC |
| Dentro de cada **`aa:`** | Lee la memoria, corre los tests (TDD Gate), QA, el gate de contratos, review y guarda lo aprendido |
| Al hacer **`akdd init`** en un proyecto con código | Corre `onboard` + `ast` + `sync` solos para dejar el dashboard poblado |
| Al **instalar / actualizar** | Instala el gatillo de git por sí mismo |

### 🔵 Lo que escribes en el chat — disparadores del pipeline

| Comando | Qué hace |
|---------|----------|
| `aa: [cualquier tarea]` | Pipeline completo: analiza · construye · prueba · aprende |
| `aa: sprint — [objetivo]` | Encadena varias tareas; la memoria fluye entre ellas |
| `aa: aprende` | Absorbe conocimiento de trabajo hecho fuera del pipeline |
| `audit: auditar` · `audit: seguridad` | Departamento QA — audita, **no toca código** |

También expone **54 herramientas MCP** para clientes compatibles (Claude Code, Cursor, cualquier cliente MCP por stdio).

> El vocabulario de comandos (`aa:`, `audit:`, `akdd buscar`…) está en español — la tarea que escribes después de `aa:` puede ir en cualquier idioma.

---

## ⚪ Referencia completa del CLI (manual)

Todo lo de abajo es **manual** — lo corres solo cuando lo necesites. Lo automático está en la sección de arriba.

### Setup y ciclo de vida
```bash
akdd init                      # Instalar Agentix KDD en un proyecto nuevo
akdd onboard                   # Adoptar un proyecto existente (brownfield)
akdd update                    # Actualizar el motor desde GitHub (la memoria queda intacta)
akdd sync                      # Sincronizar memoria + grafo de conocimiento
akdd hooks [status]            # Instalar / verificar el gatillo automático de git
akdd mcp                       # (Re)configurar MCP para Cursor / Claude Code / VS Code
akdd health [--fix]            # Diagnóstico del sistema (--fix repara lo que puede)
akdd dashboard                 # Tablero visual en localhost:3847
```

¿Primera vez en la pestaña Knowledge Graph del dashboard, o te confunden los números de
contratos de Preservation Intel? Dos guías visuales:

<a href="docs/GRAFO-GUIA.md"><img src="assets/grafo-guia.svg" width="49%"></a>
<a href="docs/CONTRATOS-GUIA.md"><img src="assets/contratos-guia.svg" width="49%"></a>

[Cómo leer el grafo](docs/GRAFO-GUIA.md) · [Cómo leer contratos + Creative Engine](docs/CONTRATOS-GUIA.md)

### Memoria y grafo de conocimiento
```bash
akdd buscar "query"            # Búsqueda híbrida semántica + BM25 en la memoria
akdd recall "query"            # Traer memoria relevante para una tarea
akdd historial                 # Recuperar checkpoint — pégalo en un chat nuevo
akdd checkpoint                # Crear un checkpoint de sesión ahora
akdd graph                     # Resumen del grafo de conocimiento
akdd stats                     # Estadísticas de la memoria
akdd why <archivo|entidad>     # Por qué existe algo — cadena de decisiones
akdd trail <id>                # Trazabilidad completa de una entidad
akdd forget <id> "<razón>"     # Borrar un nodo de memoria (auditado)
akdd decay                     # Aplicar decaimiento temporal a nodos viejos
akdd cure [run|report]         # MemCurator — gobernanza autónoma de la memoria
akdd memory                    # Resumen de la memoria
```

### Contratos y gates (capa de preservación)
```bash
akdd contracts                 # Estado del Contract Guard (protegido/verificado/candidato)
akdd contracts gate            # Correr el gate de contratos a mano
akdd validate                  # Validar consistencia del conocimiento
akdd predict <archivo>         # Predecir riesgo de regresión antes de editar
akdd impacto <archivo|módulo>  # Análisis de impacto — qué se rompe si esto cambia
akdd ast-impact <archivo>      # Análisis de impacto a nivel AST
```

### Creative Engine
```bash
akdd creative suggest          # Generar sugerencias de mejora
akdd creative apply <id>       # Aplicar una sugerencia
akdd creative dismiss <id>     # Descartar una sugerencia
akdd creative level            # Ver nivel de autonomía (asistido → autónomo)
akdd creative wins             # Ver mejoras aplicadas
akdd creative stats            # Estadísticas del Creative Engine
```

### AST e inteligencia de código
```bash
akdd ast index [target]        # Indexar el código (símbolos, dependencias)
akdd ast stats                 # Estadísticas del índice AST
akdd ast symbols <archivo>     # Listar símbolos de un archivo
akdd git-context               # Contexto git actual para el agente
```

### Departamento QA / Auditoría 🔵 (en el chat — solo audita, no toca código)
```bash
audit: auditar                 # Auditoría completa — 7 subagentes en paralelo
audit: seguridad               # Seguridad — secretos, auth, vulnerabilidades
audit: frontend                # Frontend — source maps, llaves filtradas, build
audit: backend                 # Backend — endpoints, validación, APIs
audit: datos                   # Datos — RLS, BD expuesta, fugas
audit: performance             # Rendimiento — rate limiting, caché, escalabilidad
audit: browser                 # QA real en navegador
audit: codigo                  # Calidad de código y Git
audit: help                    # Muestra el menú de auditoría
```
> Los reportes se guardan en `_output/audit-[fecha].md` y `.audit/reporte-actual.md`.
> Para corregir un hallazgo: `aa: corrige el hallazgo SEG-01` (o pídelo directo en el chat).

### Observabilidad ⚪ (terminal)
```bash
akdd audit                     # Reporte de auditoría de memoria (nodos viejos / en conflicto)
akdd telemetry                 # Reporte de telemetría
akdd report                    # Reporte de efectividad (antes/después)
akdd metrics                   # Métricas del proyecto
```

### Multi-instancia (Lock Manager)
```bash
akdd locks                     # Estado de locks — quién tiene qué
akdd locks acquire --module=X  # Adquirir lock de un módulo
akdd locks release --module=X  # Liberar lock de un módulo
akdd locks check --files=...   # Verificar si hay archivos bloqueados
akdd locks acquire-schema      # Adquirir el lock de schema (antes de migraciones)
akdd locks release-schema      # Liberar el lock de schema
akdd locks wait --module=X     # Esperar hasta que un módulo se libere
akdd locks release-all         # Liberar todos los locks (limpieza de sesión)
```

### Colaboración (sync de equipo) — 🔒 beta privada
> La **memoria compartida de equipo** está en **beta privada** y aún no está habilitada para uso
> público. Todo lo demás de Agentix funciona **100% local, sin ninguna cuenta** — la colaboración
> es la única pieza que sigue cerrada. ¿La necesitas para tu equipo? [Abre un issue](https://github.com/Adrianlpz211/AGENTIX-KDD/issues).

### Specs y planificación
```bash
akdd spec create <módulo>      # Crear una spec para un módulo
akdd spec                      # Listar specs
akdd sprint-plan               # Planificar un sprint multi-fase
akdd benchmarks                # Correr / ver benchmarks
```

### Embeddings (búsqueda semántica)
```bash
akdd embed-status              # Estado del índice de embeddings
akdd embed-install             # Instalar soporte de embeddings
akdd jina-install              # Instalar el modelo jina-embeddings-v2 (descarga pesada)
```

### CI/CD
```bash
akdd ci-install                # Instalar la integración de CI
akdd ci-status                 # Estado de CI
akdd ci-report                 # Reporte de CI
akdd llms                      # Generar llms.txt + knowledge-graph.json
```

---

## Resultados de benchmark

En una prueba de 19 fases construyendo un SaaS multi-tenant real (mismo modelo Claude en ambos modos), con vs. sin Agentix:

| Métrica | Sin | Con |
|---------|-----|-----|
| Errores por fase | 2.6 | ~0 |
| Fases con error repetido | 3 | 0 |
| Tests al primer intento | 79% | 100% |
| Cascada de refactor correcta | 4/7 | 11/11 |

> ⚠️ **Honestidad ante todo:** estos números son **N=1, direccionales, no peer-reviewed** — un solo proyecto. Sirven para mostrar la dirección, no como verdad absoluta. Reproduce el benchmark tú mismo en `benchmark/`.

---

## Estado y transparencia

Agentix es software **joven y en evolución**. Se auditaron los 48 archivos del motor y se repararon **30+ bugs** (memoria, gates, búsqueda vectorial, publicación). Aun así, **una auditoría no certifica cero defectos** — si encuentras algo, abre un issue.

Lo que **sí funciona hoy**: el pipeline `aa:`, el registro automático de ciclos y contratos (vía gatillo de git), la memoria persistente con búsqueda semántica real, los gates (Spec / Regression / TDD / Security), el dashboard con métricas reales, el servidor MCP y la coordinación multi-instancia.

**El despacho de sub-agentes es más nuevo (v3.10–v3.11)** y cada pieza tiene un nivel de confianza distinto: Context Enricher y QA con 4 lentes están **confirmados contra tareas reales** (el de QA encontró de hecho un bug real de concurrencia que una revisión de un solo autor se había saltado). Front/Back en paralelo está implementado y conectado con el mismo mecanismo, pero todavía no tiene una confirmación limpia de que se dispare en paralelo de verdad en el mundo real — la única prueba real salió con un solo autor, por razones defendibles (una feature chica y muy acoplada), no por un bug conocido. Trátalo como "debería funcionar" y no como "comprobado" hasta que se confirme con una tarea que de verdad separe front de back.

---

## Licencia

MIT — úsalo, forkéalo, constrúyelo.

<div align="center">

Hecho por [@Adrianlpz211](https://github.com/Adrianlpz211)

*Si Agentix te ahorró tiempo → ⭐*

</div>
