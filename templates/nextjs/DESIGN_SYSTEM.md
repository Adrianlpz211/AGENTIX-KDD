# DESIGN_SYSTEM.md
<!-- Agentic KDD — Design System Reference -->
<!-- El agente Front lee este archivo antes de cualquier tarea de UI -->

## Stack de UI
- Framework: Next.js 14 (App Router)
- Estilos: Tailwind CSS
- Componentes: (completar: shadcn/ui, Radix, custom)
- Iconos: (completar: lucide-react, heroicons, etc.)
- Fuentes: (completar)

## Paleta de colores
<!-- Rellenar con los colores reales del proyecto -->
```
Primary:    #000000   (completar)
Secondary:  #000000   (completar)
Background: #FFFFFF   (completar)
Surface:    #F5F5F5   (completar)
Border:     #E5E5E5   (completar)
Text:       #111111   (completar)
Muted:      #6B7280   (completar)
Danger:     #EF4444
Success:    #22C55E
Warning:    #F59E0B
```

## Tipografía
```
Font base:  (completar)
Scale:
  xs:   12px
  sm:   14px
  base: 16px
  lg:   18px
  xl:   20px
  2xl:  24px
  3xl:  30px
```

## Espaciado
Usa la escala de Tailwind. Unidad base: 4px (= 1 unidad Tailwind).

## Componentes base
<!-- Documenta los componentes compartidos del proyecto -->

### Button
```tsx
// Variantes disponibles: default, outline, ghost, destructive
<Button variant="default" size="md">Label</Button>
```

### Card
```tsx
<Card>
  <CardHeader><CardTitle>Título</CardTitle></CardHeader>
  <CardContent>Contenido</CardContent>
</Card>
```

### Form inputs
```tsx
<Input type="text" placeholder="..." />
<Textarea placeholder="..." />
<Select>...</Select>
```

## Convenciones de layout
- Container max-width: (completar)
- Sidebar: (completar) px
- Padding de página: p-6 (desktop), p-4 (mobile)
- Gap estándar en grids: gap-4 o gap-6

## Convenciones de naming
- Componentes: PascalCase
- Páginas (App Router): page.tsx en carpeta del segmento
- Layouts: layout.tsx
- Clases Tailwind: orden → layout → spacing → typography → colors → states

## Estados de loading / error
- Skeleton: usar componente Skeleton durante carga
- Error: mostrar mensaje + botón retry
- Empty state: ilustración + texto descriptivo + CTA

## Accesibilidad mínima
- Todos los inputs tienen label visible o aria-label
- Botones de icono tienen aria-label
- Contraste mínimo: 4.5:1 para texto normal

---
> Actualiza este archivo cuando cambies el design system.
> El agente Front lo lee antes de cada tarea de UI.
