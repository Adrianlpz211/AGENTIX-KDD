# aa: aprende — Agente de absorción de conocimiento

## Cuándo se activa
```
aa: aprende                          → analiza todo el proyecto
aa: aprende — sesión de hoy          → foco en cambios recientes
aa: aprende — módulo [nombre]        → foco en un módulo específico
aa: aprende [archivo o carpeta]      → foco en archivo o carpeta
aa: aprende — error: [descripción]   → registrar error específico
aa: aprende — decisión: [texto]      → registrar decisión específica
aa: aprende — patrón: [texto]        → registrar patrón específico
```

**Propósito:** absorber conocimiento de trabajo hecho fuera del pipeline `aa:`.
Cuando trabajaste en Cursor, Claude Code, o manualmente sin usar `aa:`,
este agente lee lo que hiciste y suma ese aprendizaje a la memoria KDD.

---

## FASE 1 — Leer el estado actual

### Qué leer siempre
```
1. config.md → stack, módulos, reglas del proyecto
2. memoria/trabajo.md → último ciclo registrado
3. memoria/patrones.md → patrones existentes (para no duplicar)
4. memoria/errores.md → errores existentes (para no duplicar)
5. memoria/decisiones.md → decisiones existentes (para no duplicar)
```

### Qué leer según el objetivo
```
aa: aprende (general):
  → Leer estructura de carpetas del proyecto
  → Leer archivos modificados recientemente (git diff si disponible)
  → Leer archivos principales del stack (rutas, modelos, servicios)

aa: aprende — módulo [nombre]:
  → Leer todos los archivos de ese módulo
  → Leer tests si existen
  → Leer comentarios y TODOs en el código

aa: aprende [archivo]:
  → Leer ese archivo completo
  → Leer archivos relacionados (imports, dependencias)

aa: aprende — error/decisión/patrón:
  → Ir directo a FASE 3 con el contenido dado
```

---

## FASE 2 — Detectar conocimiento nuevo

### Detectar patrones implícitos en el código
Lee el código y busca convenciones que se repiten:

```
Naming conventions:
  → ¿Cómo se nombran los archivos? (camelCase, kebab-case, etc.)
  → ¿Cómo se nombran las funciones? ¿Las clases?
  → ¿Prefijos o sufijos consistentes? (.service.ts, .handler.js, etc.)

Estructura de archivos:
  → ¿Dónde viven los queries? ¿Los servicios? ¿Los componentes?
  → ¿Hay una arquitectura implícita que no está documentada?

Patrones de código:
  → ¿Siempre se usa try/catch de la misma forma?
  → ¿Hay un patrón de manejo de errores?
  → ¿Se usa siempre el mismo patrón para autenticación?
  → ¿Hay utilidades compartidas que se usan en todos lados?

Decisiones de dependencias:
  → ¿Qué librerías se usan para qué? ¿Por qué esas y no otras?
  → ¿Hay librerías que se evitan deliberadamente?
```

### Detectar errores potenciales o resueltos
```
Buscar en el código:
  → Comentarios tipo // FIX, // HACK, // TODO, // BUG
  → Código comentado (puede indicar algo que no funcionó)
  → Manejo de casos edge (null checks, validaciones)
  → Código de workaround (suele indicar un problema resuelto)

Si hay git disponible:
  → git log --oneline -20 → ver qué se cambió recientemente
  → git diff HEAD~5 → ver cambios de las últimas 5 sesiones
```

### Detectar decisiones arquitectónicas implícitas
```
Buscar evidencia de decisiones en:
  → La estructura de carpetas (revela arquitectura elegida)
  → Los imports (revela qué depende de qué)
  → Los comentarios de sección en archivos grandes
  → Los nombres de branches si hay git
  → Los archivos .env.example (revela qué configuración existe)
```

---

## FASE 3 — Proponer qué registrar

Antes de escribir en memoria, presenta al usuario lo que detectaste:

```
📚 aa: aprende — Análisis completado

Encontré esto que no está en tu memoria KDD:

PATRONES DETECTADOS (N):
  ✦ [patrón 1] — detectado en [archivos]
    → Propongo registrar como: Confianza BAJA, Área: [área]
  ✦ [patrón 2] — detectado en [archivos]
    → Propongo registrar como: Confianza BAJA, Área: [área]

ERRORES/FIXES DETECTADOS (N):
  ✦ [descripción del error o fix] — en [archivo:línea o comentario]
    → Propongo registrar como: Confianza BAJA, Área: [área]

DECISIONES IMPLÍCITAS (N):
  ✦ [decisión] — evidencia: [dónde se ve en el código]
    → Propongo registrar como decisión arquitectónica

YA ESTABA EN MEMORIA (N) — no duplico:
  ✓ [lista de lo que ya existía]

¿Qué registro?
A) Todo — registrar todos los N hallazgos
B) Solo patrones — N entradas
C) Solo errores — N entradas
D) Solo decisiones — N entradas
E) Seleccionar — dime cuáles sí y cuáles no
F) Cancelar — no registrar nada ahora
```

---

## FASE 4 — Registrar en memoria

Según la respuesta del usuario, escribe en los archivos de memoria:

### Formato para patrones detectados
```markdown
## [FECHA] [nombre descriptivo del patrón]
Área: [módulo o global]
Confianza: BAJA
Aplicado: 0
Útil: 0
Estado: ACTIVO
Última validación: [FECHA]
Creado: [FECHA]
Origen: aa:aprende — detectado en [archivos]
Regla: [descripción clara del patrón]
Evidencia: [dónde se ve en el código]
```

### Formato para errores detectados
```markdown
## [FECHA] [descripción del error o problema]
Área: [módulo]
Confianza: BAJA
Aplicado: 0
Útil: 0
Estado: ACTIVO
Última validación: [FECHA]
Creado: [FECHA]
Origen: aa:aprende — detectado en [archivo]
Error: [descripción del error]
Solución: [cómo se resolvió o se evita]
```

### Formato para decisiones implícitas
```markdown
## [FECHA] [título de la decisión]
Área: [módulo o global]
Confianza: BAJA
Estado: ACTIVO
Última validación: [FECHA]
Origen: aa:aprende — inferida del código
Decisión: [qué se decidió]
Razón: [por qué se infiere del código]
Evidencia: [dónde se ve la evidencia]
Alternativas descartadas: desconocidas — verificar con el equipo
```

---

## FASE 5 — Sincronizar

```bash
node .agentic/grafo/grafo.cjs sync
```

---

## Output final

```
✅ aa: aprende — COMPLETADO

Registrado en memoria KDD:
  Patrones nuevos:    N
  Errores nuevos:     N
  Decisiones nuevas:  N
  Ya existían:        N (no duplicados)

Grafo sincronizado ✓

Confianza inicial: BAJA para todos
→ Se promoverán a MEDIA/ALTA conforme el sistema los use y confirme
→ Para promover manualmente: aa: aprende — patrón: [nombre] → confianza ALTA

Próximo paso sugerido:
  aa: [continúa tu trabajo] ← el sistema ya conoce lo que hiciste
```

---

## Regla de calidad

**No registrar ruido.** Si el código no tiene una convención clara
o el patrón aparece solo 1 vez — no registrar.

**Confianza BAJA siempre** para lo detectado por `aa: aprende`.
Solo el uso real con `aa:` puede promover la confianza.

**Preguntar antes de registrar** — nunca escribir en memoria
sin mostrar primero la propuesta al usuario.
