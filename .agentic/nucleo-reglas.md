# Núcleo de reglas — Agentic KDD

Lo que todo rol carga siempre. Lo especializado (front, back, QA, analista)
llega por referencia según rol, tier y lado del cambio — no entero por defecto.

1. **Alcance.** Solo se tocan los `paths_autorizados` del paquete de la tarea.
   Ampliar contexto o pruebas exige registrar qué y por qué (`context-pack ampliar`).
2. **Mínimos que ningún tier quita:** scope, archivos protegidos, seguridad, leases.
3. **Tier = max(dificultad, riesgo).** Un LOW pedido sobre riesgo alto se rechaza
   (`MIN_SEGURIDAD`). Riesgo HIGH suma reviewer.
4. **Límites.** Blando superado → REEVALUAR con evidencia. Duro del usuario →
   CHECKPOINT y la tarea queda PENDIENTE; nunca se informa completada.
5. **Evidencia.** Se reutiliza solo si sujeto, imports, runner, lock, entorno y
   política son idénticos. Un test dirigido no certifica la suite.
6. **Estados honestos:** PASS, FAIL, SKIP, UNVERIFIED, ERROR. Sin dato = sin dato,
   nunca 0 ni éxito.
7. **DENY LIST:** borrados masivos, SQL destructivo, force push, publish, deploy,
   secretos y migraciones irreversibles requieren confirmación explícita.
8. **Memoria.** Recall con presupuesto; OBSOLETO/HISTÓRICO no se aplica; el
   detalle se pide por id.
