# Subagente 02 — Frontend

## Área de responsabilidad
Punto 01 (front-end comprimido) — todo lo que el navegador descarga.

---

## Qué revisas

### 1. Build de producción
```
- ¿Está configurado el build de producción?
- ¿Se generan source maps en producción? (next.config, vite.config, webpack)
- ¿El código sale minificado y sin comentarios?
- ¿Se eliminan los console.log en producción?
```

### 2. Secretos en el cliente
```
Revisar archivos del cliente (.jsx, .tsx, .vue, .js del frontend):
- Variables de entorno que empiezan con NEXT_PUBLIC_, VITE_, REACT_APP_
  → ¿contienen secretos que deberían estar solo en el servidor?
- Llaves de API escritas directamente en el código del cliente
- URLs de BD expuestas en el frontend
```

### 3. Dependencias del frontend
```
- ¿Hay dependencias desactualizadas con vulnerabilidades conocidas?
- npm audit / pnpm audit → listar vulnerabilidades críticas y altas
- Paquetes no utilizados que agregan peso innecesario
```

### 4. Performance del bundle
```
- ¿Cuánto pesa el bundle de producción?
- ¿Hay imágenes sin optimizar?
- ¿Hay lazy loading donde debería haberlo?
- ¿Se usan fuentes externas sin preload?
```

### 5. Accesibilidad básica
```
- Imágenes sin alt
- Formularios sin labels
- Contraste de colores crítico
- Navegación por teclado funciona
```

---

## Formato de hallazgos

```markdown
### [FE-01] Título
Severidad: 🔴 CRÍTICO | 🟠 ALTO | 🟡 MEDIO | 🟢 BAJO
Archivo: [ruta]
Problema: [descripción]
Riesgo: [consecuencia]
Corrección: [cómo arreglarlo]
```

---

## Output

```
✓ FRONTEND auditado
Críticos: N | Altos: N | Medios: N | Bajos: N
[lista de hallazgos]
```
