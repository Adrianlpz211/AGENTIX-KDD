# Subagentes Pro — Agentic KDD
# Palabra de activación: ag:

## Qué es esto
Sistema de subagentes especializados que trabajan sobre el conocimiento
acumulado del proyecto. Complementan el pipeline `aa:` con capacidades
que requieren contexto profundo de la memoria KDD.

La diferencia con herramientas genéricas:
cada subagente lee `memoria/decisiones.md`, `memoria/patrones.md`
y `memoria/errores.md` antes de actuar.
No dan respuestas genéricas — dan respuestas del proyecto.

---

## Comandos disponibles

```
ag: help              → muestra este menú

ag: refactor [obj]    → refactoriza respetando decisiones y patrones del proyecto
ag: test [obj]        → genera tests basados en errores conocidos del proyecto
ag: doc [obj]         → documenta con el por qué real de la arquitectura
ag: review [obj]      → code review contra memoria KDD del proyecto
```

### Ejemplos reales
```
ag: refactor src/components/CitasModal.tsx
ag: refactor módulo auth

ag: test src/app/api/citas/route.ts
ag: test todo lo que no tiene cobertura

ag: doc src/middleware.ts
ag: doc arquitectura del proyecto
ag: doc onboarding para nuevo dev

ag: review src/components/CitasModal.tsx
ag: review PR — agrega filtro de fecha a citas
```

---

## Cuándo usar ag: vs aa:

```
aa: [tarea]     → construir features nuevas, corregir bugs, pipeline completo
ag: refactor    → mejorar código existente sin cambiar comportamiento
ag: test        → generar cobertura de tests
ag: doc         → documentar código existente
ag: review      → revisar código antes de merge o deploy
audit: auditar  → auditoría de seguridad y calidad del proyecto completo
```

No son excluyentes — puedes usar `aa:` para construir
y luego `ag: review` para validar antes de commitear.

---

## Archivos de cada subagente
- `.agentic/agentes/pro/ag-refactor.md`
- `.agentic/agentes/pro/ag-test.md`
- `.agentic/agentes/pro/ag-doc.md`
- `.agentic/agentes/pro/ag-review.md`

---

## Regla absoluta

`ag:` activa el subagente correspondiente.
Sin `ag:` → responder normalmente.
Los subagentes `ag:` no modifican el pipeline `aa:` ni el sistema `audit:`.
