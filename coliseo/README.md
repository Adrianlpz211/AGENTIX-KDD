# 🏛️ Coliseo Agentix — arena adversarial de ruptura

Esta rama (`coliseo-arena`) no es parte del paquete que se publica en npm.
Es la evidencia del endurecimiento v3.15.2: 15 rondas diseñadas para **romper**
Agentix (no para demostrar que gana), corridas contra un proyecto real
(MediCore) — con y sin el framework, para medir la diferencia con hechos.

## Empezar

```bash
git clone https://github.com/Adrianlpz211/AGENTIX-KDD.git -b coliseo-arena
cd AGENTIX-KDD/coliseo
```

Lee en este orden:

1. **[LEEME.md](LEEME.md)** — arranque en 3 pasos + el mapa de trampas plantadas.
2. **[COLISEO.md](COLISEO.md)** — el playbook: 15 rondas, prompts exactos, mecánica A/B (blindado vs desnudo).
3. **[MARCADOR.md](MARCADOR.md)** — el resultado real de la corrida: 14/15 rondas verdes, la única grieta encontrada, y el veredicto final.

El proyecto víctima (**MediCore**, un SaaS clínico multi-tenant real con 18-32
tests según la ronda) está en [`medicore/`](medicore/) — sin `.agentic/`
instalado: instálalo tú mismo con `akdd init` siguiendo el `LEEME.md`, para
correr las rondas sobre la versión de Agentix que tengas en ese momento.

## Las 3 grietas que esto encontró — ya reparadas

Ver [`_output/plan-8-grietas-coliseo.md`](../_output/plan-8-grietas-coliseo.md)
en la rama `main` para el detalle completo de cada reparación y su
verificación mecánica.
