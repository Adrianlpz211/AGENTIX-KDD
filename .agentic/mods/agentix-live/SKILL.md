---
name: agentix-live
description: Panel "Agentix" al lado del chat de Claude Code — consumo de la sesión (tokens, USD, contexto, herramientas, tiempo) y estado del ciclo aa:, reloj, TDD, guardia y TEAMS. Se instala con `akdd mod on`; `/agentix` lo reabre.
---

# Agentix en vivo

Este plugin dibuja el panel **Agentix** junto a la conversación y se actualiza solo
mientras Claude trabaja. No cambia nada del pipeline `aa:` ni de la guardia: solo
observa, muestra y reporta el uso real del host a `.agentic/grafo/costo-uso.cjs`.

- `/agentix` → reabre el panel si se cerró.
- `akdd mod status` → ¿la copia instalada está al día con la fuente de `.agentic/mods/`?
- Lo que no existe en disco sale como `n/d`, nunca como 0.
