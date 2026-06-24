# _LOCKS.md — Coordinación entre instancias paralelas
# El Orquestador registra aquí qué archivos compartidos están en uso.
# La Memoria los libera al terminar cada ciclo.

## Archivos en uso ahora
| Archivo | Instancia | Desde | Tarea |
|---------|-----------|-------|-------|
| libre | — | — | — |

## Cómo usar
1. Antes de tocar un archivo compartido crítico → añadir fila
2. Al terminar → borrar la fila (dejar "libre")
3. Si el archivo que necesitas está ocupado → esperar o coordinar

## Archivos compartidos del proyecto
_El Setup detecta y lista estos archivos al configurarse._
