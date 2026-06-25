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

_Sin decisiones registradas aún. El agente Memoria las irá añadiendo._

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
