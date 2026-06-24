#!/bin/bash
# Agentic KDD — Installer
# curl -fsSL https://raw.githubusercontent.com/Adrianlpz211/Agentic-KDD/main/install.sh | bash

set -e

BOLD="\033[1m"
GREEN="\033[0;32m"
YELLOW="\033[0;33m"
RED="\033[0;31m"
RESET="\033[0m"

echo ""
echo -e "${BOLD}  Agentic KDD — Installer${RESET}"
echo "  A development team of one. A team becomes a legion."
echo ""

# ── 1. Verificar Node.js ──────────────────────────────────────────────────────

if command -v node &>/dev/null; then
  NODE_VER=$(node -e "console.log(process.versions.node.split('.')[0])")
  if [ "$NODE_VER" -ge 18 ]; then
    echo -e "  ${GREEN}✓${RESET} Node.js $NODE_VER detectado"
  else
    echo -e "  ${RED}✗${RESET} Node.js $NODE_VER detectado — se requiere Node.js 18+"
    echo ""
    echo "  Instalar Node.js 18+: https://nodejs.org"
    echo "  O con nvm: nvm install 20 && nvm use 20"
    exit 1
  fi
else
  echo -e "  ${YELLOW}!${RESET} Node.js no encontrado. Instalando via nvm..."
  echo ""

  # Instalar nvm
  if ! command -v nvm &>/dev/null; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
  fi

  nvm install 20
  nvm use 20

  if ! command -v node &>/dev/null; then
    echo -e "  ${RED}✗${RESET} No se pudo instalar Node.js automáticamente."
    echo "  Instalar manualmente: https://nodejs.org"
    exit 1
  fi
  echo -e "  ${GREEN}✓${RESET} Node.js 20 instalado"
fi

# ── 2. Instalar Agentic KDD ───────────────────────────────────────────────────

echo ""
echo "  Instalando agentic-kdd..."
npm install -g agentic-kdd@latest --silent

# ── 3. Verificar instalación ──────────────────────────────────────────────────

if command -v akdd &>/dev/null; then
  VER=$(akdd --version 2>/dev/null || echo "instalado")
  echo ""
  echo -e "  ${GREEN}✓${RESET} Agentic KDD $VER instalado"
  echo ""
  echo "  ─────────────────────────────────────────────"
  echo ""
  echo "  Siguiente paso:"
  echo ""
  echo "    cd tu-proyecto"
  echo "    akdd init"
  echo ""
  echo "  Después en Cursor o Claude Code:"
  echo ""
  echo "    aa: configure"
  echo ""
  echo "  ─────────────────────────────────────────────"
  echo ""
else
  echo -e "  ${RED}✗${RESET} Instalación fallida. Intentar manualmente:"
  echo ""
  echo "    npm install -g agentic-kdd"
  echo ""
  exit 1
fi
