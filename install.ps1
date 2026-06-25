# Agentic KDD — Windows Installer
# irm https://raw.githubusercontent.com/Adrianlpz211/Agentic-KDD/main/install.ps1 | iex

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "  Agentic KDD - Installer" -ForegroundColor White
Write-Host "  A development team of one. A team becomes a legion." -ForegroundColor DarkGray
Write-Host ""

# ── 1. Verificar Node.js ──────────────────────────────────────────────────────

$nodeOk = $false

try {
    $nodeVersion = node -e "console.log(process.versions.node.split('.')[0])" 2>$null
    if ($nodeVersion -ge 18) {
        Write-Host "  ✓ Node.js $nodeVersion detectado" -ForegroundColor Green
        $nodeOk = $true
    } else {
        Write-Host "  ✗ Node.js $nodeVersion — se requiere 18+" -ForegroundColor Red
    }
} catch {
    Write-Host "  ! Node.js no encontrado" -ForegroundColor Yellow
}

if (-not $nodeOk) {
    Write-Host ""
    Write-Host "  Instalando Node.js 20 via winget..." -ForegroundColor Yellow

    $wingetOk = $false
    try {
        winget install -e --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
        $wingetOk = $true
        Write-Host "  ✓ Node.js instalado" -ForegroundColor Green

        # Refresh PATH
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    } catch {
        $wingetOk = $false
    }

    if (-not $wingetOk) {
        Write-Host ""
        Write-Host "  No se pudo instalar automáticamente." -ForegroundColor Red
        Write-Host "  Descarga Node.js 20 desde: https://nodejs.org" -ForegroundColor DarkGray
        Write-Host "  Luego vuelve a correr este instalador." -ForegroundColor DarkGray
        Write-Host ""
        exit 1
    }
}

# ── 2. Instalar Agentic KDD ───────────────────────────────────────────────────

Write-Host ""
Write-Host "  Instalando agentic-kdd..." -ForegroundColor DarkGray

try {
    npm install -g agentic-kdd@latest --silent
} catch {
    Write-Host "  ✗ Error instalando. Intentar manualmente:" -ForegroundColor Red
    Write-Host "    npm install -g agentic-kdd" -ForegroundColor Gray
    exit 1
}

# ── 3. Verificar instalación ──────────────────────────────────────────────────

try {
    $ver = akdd --version 2>$null
    Write-Host ""
    Write-Host "  ✓ Agentic KDD $ver instalado correctamente" -ForegroundColor Green
    Write-Host ""
    Write-Host "  ─────────────────────────────────────────────" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  Siguiente paso:" -ForegroundColor White
    Write-Host ""
    Write-Host "    cd tu-proyecto" -ForegroundColor Cyan
    Write-Host "    akdd init" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Después en Cursor o Claude Code:" -ForegroundColor White
    Write-Host ""
    Write-Host "    aa: configure" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  ─────────────────────────────────────────────" -ForegroundColor DarkGray
    Write-Host ""
} catch {
    Write-Host ""
    Write-Host "  ✗ Instalación completada pero 'akdd' no está en PATH." -ForegroundColor Yellow
    Write-Host "  Cierra y vuelve a abrir PowerShell, luego corre: akdd --version" -ForegroundColor DarkGray
    Write-Host ""
}
