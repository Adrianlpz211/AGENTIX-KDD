# Design System — [Nombre del Proyecto]
<!-- 
  Este archivo es un knowledge doc para Agentic KDD.
  Después de completarlo corre: akdd knowledge
  Agentic lo leerá en cada ciclo aa: y nunca se saldrá de esta estructura.
  
  Instrucción para generar este archivo automáticamente:
  aa: analiza todos los componentes existentes en el proyecto, identifica 
  el design system (librería UI, colores, tipografía, patrones de layout) 
  y completa docs/DESIGN_SYSTEM.md con lo que encontraste. Luego corre akdd knowledge.
-->

---

## Stack de UI

```
Librería principal:   [Tailwind CSS / shadcn/ui / MUI / Chakra / CSS Modules]
Framework:            [Next.js 14 / React / Vue / otro]
Iconos:               [Lucide / Heroicons / FontAwesome / otro]
Fuentes:              [Inter / Geist / custom]
Animaciones:          [Framer Motion / CSS / ninguna]
```

---

## Colores

### Paleta principal
```
Primary:      #[hex]    — botones principales, links, acciones primarias
Secondary:    #[hex]    — botones secundarios, badges
Background:   #[hex]    — fondo general de la app
Surface:      #[hex]    — fondo de cards, modales, sidebars
Border:       #[hex]    — bordes de inputs, cards, separadores
Text:         #[hex]    — texto principal
Text Muted:   #[hex]    — texto secundario, placeholders, labels
```

### Estados
```
Success:      #[hex]    — confirmaciones, éxito
Warning:      #[hex]    — advertencias
Error:        #[hex]    — errores, destructive actions
Info:         #[hex]    — información neutral
```

### Modo oscuro
```
Soporta dark mode:  [sí / no]
Implementación:     [CSS variables / Tailwind dark: / next-themes]
```

---

## Tipografía

```
Font family:      [nombre]
Heading 1 (h1):   [tamaño] / [peso] / [line-height]
Heading 2 (h2):   [tamaño] / [peso] / [line-height]
Heading 3 (h3):   [tamaño] / [peso] / [line-height]
Body:             [tamaño] / [peso] / [line-height]
Small / Caption:  [tamaño] / [peso]
Code / Mono:      [familia] / [tamaño]
```

---

## Espaciado y layout

```
Grid:             [12 columnas / flex / grid personalizado]
Container max:    [1280px / 1440px / full]
Padding base:     [16px / 24px]
Gap entre cards:  [16px / 24px]
Border radius:    [4px / 8px / 12px / rounded-full para pills]
```

---

## Componentes base — cómo se usan

### Botones
```
Primario:     <Button variant="default">
Secundario:   <Button variant="secondary">
Destructivo:  <Button variant="destructive">
Ghost:        <Button variant="ghost">
Tamaños:      sm / default / lg / icon
```

### Inputs y formularios
```
Input:        <Input type="text" placeholder="..." />
Select:       <Select> ... </Select>
Checkbox:     <Checkbox />
Label:        <Label htmlFor="...">
Validación:   [react-hook-form / zod / manual]
Errores:      [dónde y cómo se muestran]
```

### Cards
```
Estructura:   <Card> <CardHeader> <CardTitle> <CardContent> <CardFooter>
Sombra:       [shadow-sm / shadow-md / ninguna]
Borde:        [con borde / sin borde]
```

### Tablas
```
Librería:     [TanStack Table / shadcn Table / HTML nativo]
Paginación:   [client-side / server-side]
Sorting:      [activado / desactivado]
Estructura:   <Table> <TableHeader> <TableRow> <TableHead> <TableBody> <TableCell>
```

### Modales y overlays
```
Librería:     [shadcn Dialog / Radix / custom]
Estructura:   <Dialog> <DialogTrigger> <DialogContent> <DialogHeader> <DialogTitle>
Drawer:       [sí / no — para mobile]
```

### Navegación
```
Sidebar:      [fija / colapsable / overlay en mobile]
Navbar:       [top / sin navbar]
Breadcrumbs:  [sí / no]
Tabs:         <Tabs> <TabsList> <TabsTrigger> <TabsContent>
```

### Notificaciones y feedback
```
Toast:        [sonner / react-hot-toast / shadcn Toast]
Alert:        <Alert variant="default | destructive">
Loading:      [Skeleton / Spinner / skeleton de shadcn]
Empty states: [componente custom / inline]
```

---

## Patrones de layout

### Estructura general de una página
```tsx
// Patrón estándar — NO cambiar esta estructura
<div className="[layout-class]">
  <Sidebar />
  <main className="[main-class]">
    <PageHeader title="..." />
    <div className="[content-class]">
      {/* contenido */}
    </div>
  </main>
</div>
```

### Estructura de una sección con tabla
```tsx
// Patrón estándar para módulos con listado
<Card>
  <CardHeader>
    <CardTitle>[Título]</CardTitle>
    <div className="[actions-class]">
      <Button>[Acción principal]</Button>
    </div>
  </CardHeader>
  <CardContent>
    <DataTable columns={columns} data={data} />
  </CardContent>
</Card>
```

### Estructura de un formulario
```tsx
// Patrón estándar para formularios
<form onSubmit={handleSubmit}>
  <div className="[form-grid-class]">
    <div className="[field-class]">
      <Label htmlFor="field">Label</Label>
      <Input id="field" {...register('field')} />
      {errors.field && <p className="[error-class]">{errors.field.message}</p>}
    </div>
  </div>
  <div className="[actions-class]">
    <Button type="button" variant="secondary">Cancelar</Button>
    <Button type="submit">Guardar</Button>
  </div>
</form>
```

---

## Convenciones de código UI

### Nomenclatura de archivos
```
Componentes:      PascalCase → UserCard.tsx, InvoiceTable.tsx
Páginas:          kebab-case → /dashboard, /patients/[id]
Hooks:            camelCase → usePatients.ts, useFormValidation.ts
Utils UI:         camelCase → formatCurrency.ts, cn.ts
```

### Estructura de un componente
```tsx
// Orden siempre: imports → types → component → export
import { ... } from '...'

interface ComponentProps {
  // props tipadas siempre
}

export function ComponentName({ prop1, prop2 }: ComponentProps) {
  // hooks primero
  // handlers después
  // return al final
  return (
    // JSX
  )
}
```

### Clases de Tailwind — convenciones
```
Responsive:   mobile-first (sm: md: lg: xl:)
Variantes:    usar cn() para clases condicionales
Custom:       [declarar aquí cualquier clase personalizada]
Evitar:       estilos inline, !important, style={{}}
```

---

## Componentes existentes en el proyecto

<!-- 
  Completar con los componentes que ya existen.
  Agentic usará esta lista antes de crear componentes nuevos
  para reutilizar lo que ya hay.
-->

```
components/ui/          → componentes base (shadcn o custom)
components/layout/      → Sidebar, Navbar, PageHeader, etc.
components/[módulo]/    → componentes específicos por módulo

Componentes reutilizables confirmados:
  [ ] DataTable con paginación y sorting
  [ ] PageHeader con título y acciones
  [ ] ConfirmDialog para acciones destructivas
  [ ] StatusBadge para estados
  [ ] FormField wrapper para inputs con label y error
  [ ] LoadingSkeleton
  [ ] EmptyState
```

---

## Lo que Agentic NUNCA debe hacer en este proyecto

```
❌ Usar estilos inline (style={{}}) — siempre Tailwind o className
❌ Crear componentes fuera de la estructura definida arriba
❌ Cambiar el layout general de una página existente
❌ Usar librerías de UI distintas a las declaradas aquí
❌ Hardcodear colores o tamaños — siempre usar las variables/tokens
❌ Crear páginas sin PageHeader
❌ Crear formularios sin validación con zod
❌ Ignorar los patrones de nomenclatura de archivos
```

---

## Lo que Agentic SIEMPRE debe hacer

```
✅ Revisar este archivo antes de crear cualquier componente UI
✅ Reutilizar componentes existentes antes de crear nuevos
✅ Mantener la estructura de layout definida
✅ Usar los colores y tipografía de la paleta
✅ Seguir los patrones de nomenclatura
✅ Agregar tipos TypeScript a todos los props
✅ Usar cn() para clases condicionales de Tailwind
✅ Validar formularios con zod
```

---

## Notas adicionales del equipo

<!-- 
  Agregar aquí cualquier decisión de diseño importante,
  quirks del proyecto, o convenciones específicas del equipo.
  Ejemplos:
  - "Los modales siempre tienen máximo 600px de ancho"
  - "Las tablas siempre muestran 10 filas por defecto"
  - "El sidebar colapsa en tablets (md:) y es overlay en mobile (sm:)"
-->
