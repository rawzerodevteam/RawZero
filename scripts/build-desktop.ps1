# Build complet de l'app desktop Tauri sous Windows : sidecar backend (PyInstaller) +
# frontend (Vite) + bundle Tauri (.msi/.exe). Miroir Windows de build-desktop.sh.
#
# Prérequis : .\bootstrap.ps1 (outillage dev) + Rust installé (cargo dans le PATH).
# PyInstaller est installé automatiquement dans .tools\venv au besoin.
$ErrorActionPreference = 'Stop'
# Ce script vit dans scripts\ ; on opère depuis la racine du dépôt (dossier parent).
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$tools       = Join-Path $root ".tools"
$uvExe       = Join-Path $tools "uv.exe"
$nodeDir     = Join-Path $tools "node"
$venvPython  = Join-Path $tools "venv\Scripts\python.exe"
$pyInstaller = Join-Path $tools "venv\Scripts\pyinstaller.exe"

# ---- Prérequis ------------------------------------------------------------
if (-not (Test-Path $venvPython)) {
  Write-Host "Outillage dev introuvable (.tools\venv). Lance d'abord : .\bootstrap.ps1" -ForegroundColor Red
  exit 1
}
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
  Write-Host "Rust (cargo) introuvable — requis pour compiler le shell Tauri." -ForegroundColor Red
  Write-Host "À installer (toi-même, une fois) :" -ForegroundColor Yellow
  Write-Host "  winget install Rustlang.Rustup   puis rouvrir le terminal" -ForegroundColor Yellow
  Write-Host "  (ou https://www.rust-lang.org/tools/install)" -ForegroundColor Yellow
  exit 1
}

# Caches uv confinés dans .tools\ ; Node + contournement TLS sur le PATH.
$env:UV_CACHE_DIR          = Join-Path $tools "uv-cache"
$env:UV_PYTHON_INSTALL_DIR = Join-Path $tools "python"
$env:Path                  = "$nodeDir;$env:Path"
$env:NODE_OPTIONS          = "--use-system-ca"

# ---- 1/3 : sidecar backend (PyInstaller) ----------------------------------
Write-Host "== 1/3 : sidecar backend (PyInstaller) =="
if (-not (Test-Path $pyInstaller)) {
  Write-Host "  Installation de PyInstaller dans .tools\venv…" -ForegroundColor Cyan
  & $uvExe pip install --python $venvPython pyinstaller
  if ($LASTEXITCODE -ne 0) { throw "Échec de l'installation de PyInstaller" }
}
Push-Location backend
try {
  & $pyInstaller --noconfirm rawstudio-backend.spec
  if ($LASTEXITCODE -ne 0) { throw "Échec du build PyInstaller" }
} finally { Pop-Location }

# ---- 2/3 : frontend (Vite) ------------------------------------------------
Write-Host "== 2/3 : frontend (Vite) =="
Push-Location frontend
try {
  & (Join-Path $nodeDir "npm.cmd") run build
  if ($LASTEXITCODE -ne 0) { throw "Échec du build frontend" }
} finally { Pop-Location }

# ---- 3/3 : bundle Tauri (.exe NSIS) ---------------------------------------
Write-Host "== 3/3 : bundle Tauri (.exe NSIS) =="
$npx = Join-Path $nodeDir "npx.cmd"
& "$root\src-tauri\nsis-plugins.ps1"   # plugin EnVar (ajout au PATH) dans le cache NSIS de Tauri
& $npx --prefix frontend tauri build
if ($LASTEXITCODE -ne 0) {
  # Au TOUT premier build, Tauri télécharge NSIS *pendant* le build et réextrait le dossier
  # Plugins, ce qui écrase EnVar.dll déposé juste avant -> makensis ne le trouve plus.
  # NSIS est maintenant en cache : on redépose le plugin et on relance une seule fois (le 2e
  # build réutilise le cache sans l'écraser). Builds suivants : OK du premier coup.
  Write-Host "Plugin EnVar probablement écrasé par le 1er téléchargement de NSIS — réinstallation et nouvelle tentative…" -ForegroundColor Yellow
  & "$root\src-tauri\nsis-plugins.ps1"
  & $npx --prefix frontend tauri build
  if ($LASTEXITCODE -ne 0) { throw "Échec du bundle Tauri" }
}

Write-Host "`nBundle prêt : src-tauri\target\release\bundle\" -ForegroundColor Green
Get-ChildItem src-tauri\target\release\bundle -Recurse -Include *.msi,*.exe -ErrorAction SilentlyContinue |
  Select-Object FullName
