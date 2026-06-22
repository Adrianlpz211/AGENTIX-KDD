<div align="center">

# 🤖 Agentic KDD

### Knowledge-Driven Development para desarrollo asistido por IA

**El pipeline de desarrollo autónomo que aprende de tu proyecto — y mejora en cada ciclo.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-2.0-blue.svg)](https://github.com/Adrianlpz211/Agentic-KDD)
[![Works with Cursor](https://img.shields.io/badge/Funciona%20con-Cursor-blue)](https://cursor.sh)
[![Works with Claude Code](https://img.shields.io/badge/Funciona%20con-Claude%20Code-orange)](https://claude.ai/code)

[**English**](README.md) · [**Español**](README.es.md) · [**Metodología KDD**](docs/kdd-methodology.md)

</div>

---

## Las 4 innovaciones de v2

### 1. Context Guard
Antes de ejecutar cualquier tarea, el Orquestador valida que la instrucción pertenece al proyecto.

```
aa: carga los servicios en el index

Context Guard busca "servicios" en:
  config.md ............... ✗ no encontrado
  memoria/patrones.md ..... ✗ no encontrado
  código existente ........ ✗ no encontrado
  Proyecto definido como: web de pedidos de productos

🔍 CONTEXT STOP

"servicios" no tiene respaldo en ninguna fuente conocida.

Posibilidades:
  A) Error en la petición — ¿quisiste decir "productos"?
  B) Feature nueva — descríbela para continuar
```

---

### 2. Lectura en capas
Los agentes leen solo lo que necesitan, no todo en cada fase.

```
Sin lectura en capas:
  5 módulos × 3 fases × releer todo = 45+ lecturas

Con lectura en capas (v2):
  Arranque:        3 archivos (una vez)
  Cambio de fase:  1 línea del PLAN.md
  Dentro de fase:  0 lecturas adicionales
```

---

### 3. Señales de confianza
La base de conocimiento mejora automáticamente según si las entradas realmente ayudaron.

```
Cada error/patrón registrado tiene:
  Confianza: BAJA → MEDIA → ALTA
  Aplicado:  N veces
  Útil:      N veces
```

---

### 4. QA verificador independiente
El agente QA no sabe cómo se implementó — solo qué debería hacer. Detecta lo que el implementador no vería.

---

## Inicio rápido

```
aa: configurar          # configuración inicial (una sola vez)
aa: [tu tarea]          # pipeline completo autónomo
aa: continúa — [resp]   # retomar después de un STOP
```

Sin `aa:` → Cursor/Claude Code funcionan normalmente.
Con `aa:` → Agentic KDD toma el control.

---

## Metodología KDD

KDD (Knowledge-Driven Development) — el conocimiento acumulado del proyecto guía activamente cada decisión del agente.

→ [Leer la metodología completa](docs/kdd-methodology.md)

---

<div align="center">

**Si Agentic KDD te ahorró tiempo, dale una ⭐**

Hecho con 🧠 por [@Adrianlpz211](https://github.com/Adrianlpz211)

</div>
