# Setup — Agentic KDD

## Cuándo corres
Cuando config.md dice `CONFIGURADO: NO` o cuando el usuario escribe `aa: configurar`.

---

## FASE 0 — Absorber contexto existente del proyecto

ANTES de hacer cualquier pregunta, lee todo lo que el proyecto ya tiene:

```
Si existe .cursorrules → leerlo completo
  → extraer: stack, reglas, convenciones, restricciones

Si existe CLAUDE.md previo (con contenido del proyecto) → leerlo
  → extraer: descripción, módulos, reglas de negocio

Si existe CONTEXTO.md o similar → leerlo
  → extraer: arquitectura, decisiones, contexto del negocio

Si existe repomix-output.xml → leerlo
  → es el proyecto completo — extraer todo

Si existe README.md → leerlo
  → descripción del proyecto, instrucciones

Si existe .claude/ con archivos → leerlos
  → pueden tener memoria o contexto valioso
```

Todo lo que encuentres va a enriquecer el `config.md`.
El objetivo es que Agentic entienda el proyecto TAN BIEN como
los archivos de contexto existentes — o mejor.

---

## FASE 1 — Leer el código

```
package.json / composer.json / pyproject.toml
  → stack, framework, dependencias, comandos reales

src/ app/ lib/ components/ api/ routes/ controllers/
  → estructura real del proyecto

Un archivo real de cada tipo
  → patrón exacto del proyecto
```

---

## FASE 2 — Decidir el camino

### Caso A — Proyecto existente con código y/o contexto
```
→ Lee todo (Fase 0 + Fase 1)
→ Genera descripción completa
→ Muestra al usuario:

"Encontré esto en el proyecto:
Stack: [stack detectado]
Módulos: [lista]
Contexto existente absorbido: [archivos leídos]
Descripción generada: [descripción]

¿Es correcta? (sí / ajusta esto: [corrección])"
```

### Caso B — Proyecto nuevo con conocimiento/
```
→ Lee todos los archivos de conocimiento/
→ Genera descripción desde esos docs
→ Confirma con el usuario
```

### Caso C — Proyecto nuevo sin nada
```
→ Pregunta:

"No encontré información del proyecto.

Opciones:
A) Descríbeme el proyecto:
   - ¿Qué hace?
   - ¿Qué módulos tendrá?
   - ¿Qué tecnologías usas?

B) Sube archivos a .agentic/conocimiento/
   y vuelve a escribir: aa: configurar"
```

### Caso D — Proyecto existente sin docs claros
```
→ Lista lo que encontró
→ Pregunta descripción adicional
```

---

## FASE 3 — Detectar stack

```
package.json → Node.js
  → next → Next.js
  → react → React
  → vue → Vue 3
  → express → Express

composer.json → PHP
  → laravel → Laravel
  → sin framework → PHP nativo

pyproject.toml / requirements.txt → Python
```

---

## FASE 4 — Escribir config.md

```markdown
# Agentic KDD — Configuración del proyecto
CONFIGURADO: SI
VERSION: 2.0

## Proyecto
Nombre: [nombre]
Descripción: [descripción detallada — mínimo 3 líneas]
Tipo: NUEVO | EXISTENTE

## Contexto absorbido
Archivos de contexto existentes leídos:
- [lista de archivos que se leyeron en Fase 0]

## Stack
[stack real detectado]

## Módulos
### Implementados
[detectados del código]

### Pendientes
[mencionados en docs]

## Archivos compartidos críticos
[detectados]

## Reglas del proyecto
[extraídas de .cursorrules, CLAUDE.md, CONTEXTO.md, etc.]

## Sinónimos del proyecto
_Sin sinónimos registrados aún._
```

---

## FASE 5 — Actualizar memoria/trabajo.md

```markdown
## Goal del proyecto
[objetivo principal extraído del contexto]
```

---

## Output final

```
╔══════════════════════════════════════╗
║  AGENTIC KDD — CONFIGURADO           ║
╚══════════════════════════════════════╝

Proyecto: [nombre]
Stack: [resumen]
Contexto absorbido: [N archivos leídos]
Módulos detectados: N

Listo. Escribe:
aa: [tu tarea]
```
