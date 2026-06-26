# Agentic KDD — VS Code Extension

Integra el framework Agentic KDD directamente en VS Code. El agente tiene acceso a memoria persistente, grafo AST, y knowledge base desde el editor.

## Requisitos

- VS Code 1.85+
- Node.js 18+
- El proyecto debe tener Agentic KDD inicializado (`akdd init`)

## Instalación (desarrollo)

```bash
# 1. Ir al directorio de la extensión
cd vscode-extension

# 2. Instalar dependencias
npm install

# 3. Abrir en VS Code
code .

# 4. Presionar F5 para lanzar Extension Development Host
```

## Publicar en Marketplace

```bash
# Instalar vsce
npm install -g @vscode/vsce

# Empaquetar
vsce package

# Publicar (requiere cuenta en marketplace.visualstudio.com)
vsce publish
```

## Comandos disponibles

| Comando | Atajo | Descripción |
|---------|-------|-------------|
| `Agentic KDD: Open Dashboard` | — | Abre el dashboard de memoria |
| `Agentic KDD: Index Project (AST)` | — | Indexa el proyecto en el grafo AST |
| `Agentic KDD: Query Memory` | — | Busca en la memoria KDD |
| `Agentic KDD: Analyze Impact of Current File` | — | Analiza el impacto del archivo activo |
| `Agentic KDD: Create Spec for Module` | — | Crea spec Kiro-style para un módulo |
| `Agentic KDD: Sync ADRs & Gotchas` | — | Sincroniza la base de conocimiento |

## MCP Server registration

La extensión registra automáticamente el MCP server de Agentic KDD usando `registerMcpServerDefinitionProvider`. Esto permite que Claude Code (y otros agentes que soporten MCP en VS Code) tengan acceso directo a la memoria del proyecto.

## Configuración

```json
// settings.json
{
  "agentickdd.astEnabled": true,
  "agentickdd.embeddingsModel": "miniLM",
  "agentickdd.collabMode": "disabled"
}
```

## Arquitectura

```
extension.js
├── AgenticDashboardProvider  ← Webview sidebar con el dashboard
├── MCP registration           ← registerMcpServerDefinitionProvider
├── Commands                   ← 6 comandos registrados
└── File save hook             ← AST auto-index al guardar
```

## Próximo paso: Theia IDE

Ver `docs/monaco-ide-roadmap.md` para el plan de construir un IDE completo
con Theia + Theia AI que integra Agentic KDD nativamente.
