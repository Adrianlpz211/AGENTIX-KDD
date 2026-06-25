<div align="center">

<img src="https://img.shields.io/badge/Agentic_KDD-v2.2-8b5cf6?style=for-the-badge&labelColor=0a0d14" alt="version"/>

# 🧠 Agentic KDD

### Tu compañero de código que sí recuerda.

**Las demás herramientas de IA olvidan todo en cuanto cierras el chat.**  
**Agentic KDD construye una memoria viva de tu proyecto — y se vuelve más inteligente cada vez que codeas.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm](https://img.shields.io/npm/v/agentic-kdd.svg?color=10b981)](https://www.npmjs.com/package/agentic-kdd)
[![Funciona con Cursor](https://img.shields.io/badge/Funciona_con-Cursor-3b82f6)](https://cursor.sh)
[![Funciona con Claude Code](https://img.shields.io/badge/Funciona_con-Claude_Code-f59e0b)](https://claude.ai/code)

[**Empezar**](#inicio-rápido) · [**Cómo funciona**](#cómo-funciona) · [**Comandos**](#comandos) · [**English**](README.md)

---

```
Tú escribes una línea.
Agentic construye, prueba, corrige, aprende y documenta — automáticamente.
```

</div>

---

## El problema que nadie menciona

Abres Cursor. Abres Claude Code. Describes tu proyecto *otra vez*. La IA empieza desde cero *otra vez*. Comete el mismo error de hace dos semanas *otra vez*.

No estás programando — estás babysitting el contexto.

**Agentic KDD lo resuelve** — de una vez por todas.

Vive dentro de tu proyecto. Lee tu código, aprende de cada error, recuerda cada decisión, y usa todo eso para que la próxima tarea sea más inteligente que la anterior. Sesión tras sesión. Para siempre.

---

## Qué pasa cuando escribes `aa: construye el módulo de pagos`

```
  ┌─────────────────────────────────────────────────────────────────────┐
  │                                                                     │
  │  1. Context Guard    Valida que la tarea pertenece al proyecto      │
  │                      Revisa si los archivos tienen historial riesgo │
  │                      Ejecuta predicciones desde memoria episódica   │
  │                                                                     │
  │  2. Analista         Busca en 3 capas de memoria simultáneamente    │
  │                      "auth.service.ts falló 3x sin migraciones"     │
  │                      Lee el diff de git — sabe qué cambió hoy      │
  │                                                                     │
  │  3. Agente Front     Construye la UI                                │
  │  4. Agente Back      Construye API + lógica                         │
  │                                                                     │
  │  5. TDD + Self-Healing                                              │
  │     Genera tests → EJECUTA → lee el output                         │
  │     Si falla: busca en memoria episódica → web search → fix        │
  │     Re-ejecuta → máx 3 intentos → nunca abandona en silencio       │
  │                                                                     │
  │  6. Agente QA        Suite completa — detecta regresiones          │
  │  7. Review           Código vs las reglas de tu propio proyecto     │
  │  8. Agente Memoria   Registra episodio → sincroniza el grafo       │
  │                      Patrones que funcionaron → promovidos a ALTA  │
  │                      Patrones sin uso → decay temporal aplicado    │
  │                                                                     │
  └─────────────────────────────────────────────────────────────────────┘

  Tú lees el reporte. No tocaste nada en el camino.
```

---

## Nuevo en v2.2 — La actualización de inteligencia

Agentic pasó de reactivo (aprende después del hecho) a **predictivo** (previene fallos antes de que ocurran).

### ⚡ Motor de predicción

Tu memoria episódica ahora trabaja para ti *antes* de cometer el error.

```
Escribes: aa: refactoriza el servicio de autenticación

Agentic revisa el historial:

  🔴 PREDICCIÓN [ALTO]
  auth.service.ts falló 3/4 veces en episodios anteriores
  Razón conocida: no se corrieron las migraciones antes de tocar SessionManager
  Fix que funcionó: correr migraciones primero (80% éxito cuando se hace)

  ✓ Precondición detectada: ¿Correr migraciones primero?
```

No está adivinando. Está leyendo *el historial de tu propio proyecto* y conectando los puntos.

### 🔍 Contexto Git

Cada `akdd sync` lee tu diff de git y lo cruza contra la memoria.

```
akdd sync

  ⚠️  CONTEXTO GIT
  Rama: feature/pagos

  🔴 [ALTO]  stripe.service.ts — falló 2x
             Último fix: agregar STRIPE_WEBHOOK_SECRET al .env.local

  🟡 [MEDIO] session.ts — 1 fallo anterior, proceder con cuidado
```

Antes de que la IA toque un solo archivo, ya sabe cuáles son peligrosos y por qué.

### 🧬 Embeddings locales — 100% offline

Búsqueda semántica sin ninguna API key. El modelo `all-MiniLM-L6-v2` (23MB, corre localmente) hace que la recuperación de memoria pase de coincidencia de palabras a *comprensión de significado*.

```
Buscas: "cómo manejo sesiones expiradas"

Sin embeddings:  encuentra entradas con "expiradas" o "sesiones"
Con embeddings:  encuentra "JWT timeout", "token vencido", "session cleanup",
                 "auth refresh loop" — porque significan lo mismo
```

La relevancia pasa de ~60% a ~90%. Cada `aa:` se beneficia automáticamente.

### 🔁 Memoria CI/CD

Tu repositorio escribe en tu memoria — incluso cuando no estás trabajando.

```bash
akdd ci-install   # un comando → workflow de GitHub Actions instalado
```

Cada test fallido en CI se registra como episodio de memoria. Llegas al trabajo al día siguiente y Agentic ya sabe qué rompió en el deploy de medianoche, y por qué.

---

## Cómo funciona

Agentic KDD está construido sobre la **arquitectura de memoria CoALA** (Princeton/CMU) — la misma taxonomía usada por Mem0, LangChain y Letta — adaptada específicamente para desarrollo de software.

```
4 capas de memoria, siempre activas:

  Working Memory    → contexto activo de la tarea actual
  Procedural        → patrones, errores, decisiones (las reglas de tu proyecto)
  Episódica         → trayectorias RAW — qué se intentó, en qué orden, por qué funcionó o falló
  Semántica         → grafo de entidades — módulos, APIs, dependencias, qué rompe qué
```

Todo vive en una **base de datos SQLite dentro de tu proyecto** — tuya para siempre, sin nube, sin suscripción.

```sql
-- Las reglas de tu proyecto, ordenadas por confiabilidad probada
SELECT * FROM nodos WHERE area = 'auth' AND confianza = 'ALTA';
-- Retorna: solo reglas aplicadas 7+ veces con 80%+ tasa de éxito

-- Cada vez que este archivo causó un problema, y exactamente qué lo resolvió
SELECT * FROM episodios WHERE archivos_tocados LIKE '%auth.service%' AND resultado = 'fallo';
```

El Analista consulta las 3 capas en **menos de 5ms** antes de planificar cualquier tarea.

---

## Para todos — dev experimentado o vibe coder de primera vez

No necesitas entender cómo funciona esto internamente.

**Si eres nuevo en AI coding:** instálalo, escribe `aa: configurar`, describe lo que quieres construir. Agentic hace el resto.

**Si eres dev experimentado:** se acabó re-explicar la arquitectura. Se acabó "la IA ignoró mis patrones otra vez". Tus reglas se aplican automáticamente, cada vez.

**Usas Cursor:** funciona nativamente — CLAUDE.md activa todo.  
**Usas Claude Code:** funciona nativamente — escribe `aa:` en el terminal.  
**Los dos al mismo tiempo:** `_LOCKS.md` coordina los agentes paralelos.

---

## Inicio Rápido

### Opción A — MCP (más automático) ⭐

```bash
npm install -g agentic-kdd
npm install -g agentic-kdd-mcp
```

Agregar en Cursor → Settings → Tools & MCPs:
```json
{
  "mcpServers": {
    "agentic-kdd": {
      "command": "node",
      "args": ["TU_RUTA_GLOBAL/node_modules/agentic-kdd-mcp/server.js"]
    }
  }
}
```

> Encuentra tu ruta: `npm root -g` → agrega `/agentic-kdd-mcp/server.js`

Para Claude Code:
```bash
claude mcp add agentic-kdd -- node $(npm root -g)/agentic-kdd-mcp/server.js
```

Luego en cualquier proyecto:
```
aa: configurar
```
Listo. Agentic lee tu proyecto y se configura solo.

---

### Opción B — CLI

```bash
npm install -g agentic-kdd
cd tu-proyecto
akdd init
```

Abre en Cursor o Claude Code → escribe `aa: configurar`

---

### Opción C — Manual (sin instalar nada)

1. Descarga y descomprime en la raíz de tu proyecto
2. Abre en Cursor o Claude Code
3. Escribe `aa: configurar`

> SQLite funciona automáticamente: intenta `better-sqlite3` → cae en `node:sqlite` (Node 22+) → cae en `sql.js`. Sin configuración.

---

### Stacks detectados automáticamente

| Stack | Auto-detectado | Reglas precargadas |
|-------|---------------|-------------------|
| Next.js 14 | ✓ | App Router, Server Components, Supabase |
| Laravel | ✓ | Services, Repositories, Form Requests |
| Node/Express | ✓ | Services layer, manejo de errores |
| React | ✓ | Hooks, state management, API services |
| PHP | ✓ | Queries PDO, validación |
| Python/FastAPI | ✓ | Pydantic, SQLAlchemy, pytest |

---

## Comandos

### `aa:` — El pipeline principal

```bash
aa: configurar              # setup inicial — lee tu proyecto automáticamente
aa: [cualquier tarea]       # ciclo autónomo completo
aa: continúa — [respuesta]  # retomar después de un STOP
aa: aprende                 # absorber conocimiento de trabajo fuera del pipeline
aa: aprende — error: [x]    # registrar un error específico
aa: aprende — decisión: [x] # registrar una decisión arquitectónica
```

### `aa: sprint` — Encadenar múltiples tareas

```bash
# Cadena explícita
aa: sprint — ciclo de calidad completo para el módulo auth
  → tarea 1: auditar y generar reporte de issues
  → tarea 2: corregir los BLOCKERs encontrados
  → tarea 3: generar tests para los casos que fallaron
  → tarea 4: actualizar documentación

# Forma corta — Agentic planifica las tareas y propone antes de ejecutar
aa: sprint — construir módulo de pagos desde cero
aa: sprint skip    # saltar tarea actual
aa: sprint abort   # cancelar sprint, conservar lo completado
```

La memoria KDD fluye entre todas las tareas. El output de la tarea 1 informa a la tarea 2. Persiste para siempre.

### `ag:` — Mejorar código existente

```bash
ag: refactor [archivo]   # respeta cada decisión arquitectónica
ag: test [archivo]       # tests basados en errores reales conocidos — no plantillas
ag: doc [archivo]        # documenta el POR QUÉ, no solo el qué
ag: review [archivo]     # BLOCKER / REQUIRED / SUGGESTED vs las reglas de tu proyecto
```

### `audit:` — 7 subagentes de QA independientes

```bash
audit: auditar      # auditoría completa — los 7 subagentes
audit: seguridad    # secretos, auth, vulnerabilidades
audit: frontend     # source maps, claves expuestas, build artifacts
audit: backend      # endpoints, validación, APIs
audit: datos        # RLS, data leaks, control de acceso
audit: performance  # rate limiting, caché, escalabilidad
audit: codigo       # calidad de código e higiene de Git
```

### CLI — lista completa

```bash
# Setup
akdd init              # instalar en el proyecto actual
akdd update            # actualizar motor + agentes (la memoria queda intacta)

# Uso diario
akdd sync              # sincronizar memoria + decay + consolidación episódica
akdd analyze           # analizar código → llenar grafo semántico de entidades
akdd dashboard         # dashboard visual en localhost:3847

# Memoria
akdd coala             # stats: las 4 capas de memoria
akdd buscar "query"    # búsqueda híbrida en todas las capas
akdd impacto "Módulo"  # ¿qué se rompe si tocas esto?
akdd predict           # patrones predictivos del historial episódico

# v2.2 Inteligencia
akdd git-context                  # análisis de riesgo del diff actual
akdd git-context --install-hook   # auto-ejecutar al cambiar de rama
akdd embed-install                # instalar embeddings locales (23MB, offline)
akdd embed-status                 # verificar motor de embeddings
akdd ci-install                   # instalar workflow de GitHub Actions
akdd ci-status                    # últimos reportes CI/CD en memoria
```

---

## Dashboard visual

```bash
akdd dashboard   # http://localhost:3847
```

- **Grafo neuronal** — mapa interactivo D3 de todo el conocimiento y sus conexiones
- **Métricas** — Goal Attainment Rate, Autonomy Ratio, Handoff Integrity, Drift Index
- **Timeline** — cada decisión y spec de módulo, cronológicamente
- **Patrones** — barras de uso y niveles de confianza
- **Errores** — issues conocidos con historial de resolución
- **Onboarding** — barra de progreso de setup para nuevos miembros del equipo

---

## El Protocolo STOP — honesto antes que inventado

Cuando algo no puede completarse después de 2 intentos, Agentic para con un reporte preciso. Nunca hace loop. Nunca inventa.

```
🛑 STOP — Agente Back

Tarea:    persistir expiry_date en tabla warehouse
Fase:     2 de 3
Intentos: 2

Error:    "Invalid column name 'expiry_date'"
Razón:    La columna no existe. Migración no ejecutada.

→ aa: continúa — correr: ALTER TABLE warehouse ADD expiry_date DATE NULL
```

El STOP no es un fracaso. Es el sistema siendo honesto.

---

## Nivel de autonomía

```
L1  Re-explicas todo en cada sesión
L2  Memoria básica — recuerda algunas cosas
L3  ← Agentic KDD v2.2
        Previene fallos antes de que ocurran
        Aprende del CI/CD automáticamente
        Contexto semántico siempre cargado
L4  Autonomía total del proyecto
L5  Codebase que se auto-mejora
```

Cada ciclo `aa:` te mueve hacia la derecha.

---

## Changelog

Ver [CHANGELOG.md](CHANGELOG.md).

## Licencia

MIT — úsalo, forkéalo, constrúyelo.

---

<div align="center">

**La IA que finalmente recuerda tu proyecto.**

Hecho con 🧠 por [@Adrianlpz211](https://github.com/Adrianlpz211)

[npm](https://www.npmjs.com/package/agentic-kdd) · [GitHub](https://github.com/Adrianlpz211/Agentic-KDD) · [English](README.md)

*Si Agentic KDD te ahorró tiempo → ⭐*

</div>
