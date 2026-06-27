# Agentic KDD — Monaco/Theia IDE Roadmap

## Objetivo

Construir un IDE ligero con Agentic KDD integrado nativamente:
- Monaco editor (mismo que VS Code)
- Agentic KDD como panel de control
- MCP server corriendo localmente
- Sin necesidad de instalar VS Code
- Distribuible como app web o Electron

---

## Por qué Eclipse Theia (y no un fork de VS Code)

| Criterio | Fork VS Code | Eclipse Theia |
|----------|-------------|--------------|
| Tiempo de setup | Semanas | 1–2 días |
| Usa extensiones VS Code | Sí (algunas) | Sí (muchas) |
| Monaco integrado | Sí | Sí |
| AI / MCP nativo | No | **Sí (Theia AI)** |
| Distribuible como web | Complejo | **Nativo** |
| Ganador CODiE 2025 | No | **Sí** |
| Para un solo dev | Demasiado | **Óptimo** |

---

## Arquitectura propuesta

```
agentic-kdd-ide/
├── packages/
│   ├── browser/              ← App web (Theia browser)
│   ├── electron/             ← App desktop (Theia electron)
│   └── agentic-extension/    ← Extension Theia que integra Agentic KDD
│       ├── src/
│       │   ├── agentic-frontend.ts   ← Panel de dashboard
│       │   ├── agentic-commands.ts   ← Comandos del IDE
│       │   ├── mcp-integration.ts    ← Registro del MCP server
│       │   └── ast-decoration.ts     ← Decoraciones en el editor
│       └── package.json
├── .agentic/                 ← Agentic KDD runtime (symlink o embedded)
└── package.json              ← Theia application
```

---

## Theia AI — la pieza clave

Theia AI es el módulo de IA oficial de Eclipse Theia (lanzado en 2025):
- Soporta múltiples modelos LLM (OpenAI, Anthropic, Ollama, custom)
- **MCP nativo**: registrar tools MCP es primera clase, no un plugin
- Agent loop integrado: el IDE orquesta el agente directamente
- Variables de prompt: `${file}`, `${selection}`, `${workspaceRoot}`

```typescript
// Registrar el MCP server de Agentic KDD en Theia AI
@injectable()
export class AgenticKDDMCPContribution implements MCPServerContribution {
  getMCPServers(): MCPServer[] {
    return [{
      id: 'agentic-kdd',
      name: 'Agentic KDD Memory',
      command: 'node',
      args: ['.agentic/grafo/mcp-server.cjs'],
      type: 'stdio',
      env: { PROJECT_ROOT: this.workspaceService.workspace?.resource.path.toString() }
    }];
  }
}
```

---

## Plan de implementación por fases

### Fase A — Setup Theia (1–2 días)
- [ ] `npx create-theia-app agentic-kdd-ide`
- [ ] Configurar `package.json` con dependencias Theia
- [ ] Verificar que Monaco funciona con un proyecto de prueba
- [ ] Agregar la extensión VS Code de Agentic KDD como dependencia

### Fase B — Extensión nativa Theia (1 semana)
- [ ] `agentic-extension/` con contribution points de Theia
- [ ] Registro del MCP server via Theia AI API
- [ ] Panel sidebar con el dashboard existente (iframe o webview Theia)
- [ ] Comandos: index-ast, query-memory, show-impact, create-spec
- [ ] File watcher para indexación automática al guardar

### Fase C — AI Chat integrado (1–2 semanas)
- [ ] Chat panel usando Theia AI chat API
- [ ] Prompt templates que consumen la memoria de Agentic KDD
- [ ] Variables: `${agentMemory}`, `${astImpact}`, `${knowledgeBase}`
- [ ] Modo autonomous: el agente ejecuta el pipeline aa: desde el IDE

### Fase D — Build y distribución (3–5 días)
- [ ] Build como app Electron (desktop, Windows/Mac/Linux)
- [ ] Build como app web (Docker, deploy en VPS)
- [ ] Branding: nombre, logo, splash screen

---

## Stack de la extensión Theia

```json
{
  "@theia/core": "^1.47.0",
  "@theia/editor": "^1.47.0",
  "@theia/filesystem": "^1.47.0",
  "@theia/ai-core": "^1.47.0",
  "@theia/ai-mcp": "^1.47.0",
  "@theia/terminal": "^1.47.0",
  "inversify": "^6.0.2"
}
```

---

## Referencia para la Fase A

```bash
# Crear la app Theia
npm install -g @theia/generator-app
yo @theia/app

# Seleccionar:
#   Target: browser (para web) o electron (para desktop)
#   Plugins: incluir @theia/ai-core, @theia/ai-mcp

# Agregar extensión VS Code existente
# en package.json de la app Theia:
"theiaPlugins": {
  "agentic-kdd": "local:./vscode-extension"
}
```

---

## Referencia: proyectos similares a estudiar

- **Gitpod (Eclipse)**: Theia como base, ha migrado a VS Code pero el código Theia es referencia
- **Che (Eclipse)**: IDE en navegador con Theia, multi-workspace
- **Theia Cloud**: deployment web de Theia, Docker + Kubernetes
- **Arduino IDE 2.0**: usa Theia + Monaco, ejemplo de IDE de dominio específico

---

## Timeline estimado (un dev, tiempo parcial)

| Fase | Tiempo | Resultado |
|------|--------|-----------|
| A — Setup | 1–2 días | Theia corriendo con Monaco |
| B — Extensión nativa | 1 semana | Comandos + MCP + dashboard |
| C — AI Chat | 1–2 semanas | Chat con memoria Agentic |
| D — Distribución | 3–5 días | App instalable |
| Total | ~4–5 semanas | IDE completo |
