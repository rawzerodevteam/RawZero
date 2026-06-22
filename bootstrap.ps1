
























































































































<#
.SYNOPSIS
  Installe tout l'outillage de dev de RawStudio depuis un clone vierge (zéro prérequis système).

.DESCRIPTION
  À lancer une fois après `git clone`. Met en place l'outillage *portable* dans .tools\
  (rien n'est installé au niveau système, rien ne pollue le PATH global) :

    1. uv (gestionnaire Python d'Astral)   -> .tools\uv.exe
    2. Python 3.12 + venv + deps backend    -> .tools\venv  (depuis backend\requirements-lock.txt)
    3. Node.js portable                     -> .tools\node
    4. npm install du frontend              -> frontend\node_modules

  Idempotent : relancer ne réinstalle que ce qui manque. Utiliser -Force pour tout refaire.
  Une fois terminé : .\start.ps1 (web) ou .\start.ps1 -Dev (hot reload).

.PARAMETER Force
  Recrée le venv, re-télécharge Node et relance npm install même si déjà présents.

.PARAMETER SkipFrontend
  N'installe pas les dépendances npm (utile si on ne touche qu'au backend).

.EXAMPLE
  .\bootstrap.ps1            # installation complète
  .\bootstrap.ps1 -Force     # repart de zéro
#>
param(
  [switch]$Force,
  [switch]$SkipFrontend
)

$ErrorActionPreference = "Stop"
$root  = $PSScriptRoot
$tools = Join-Path $root ".tools"

# Versions épinglées (reproductibilité d'un poste à l'autre).
$NodeVersion = "22.17.1"
$PythonSpec  = "3.12"

$uvExe       = Join-Path $tools "uv.exe"
$nodeDir     = Join-Path $tools "node"
$nodeExe     = Join-Path $nodeDir "node.exe"
$venvDir     = Join-Path $tools "venv"
$venvPython  = Join-Path $venvDir "Scripts\python.exe"

# Caches uv confinés dans .tools\ (jetable, ignoré par git) plutôt que dans %APPDATA%.
$env:UV_CACHE_DIR          = Join-Path $tools "uv-cache"
$env:UV_PYTHON_INSTALL_DIR = Join-Path $tools "python"

function Info($m) { Write-Host $m -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  OK $m" -ForegroundColor Green }

# Téléchargement via curl.exe (présent sur Windows 10+) avec --ssl-no-revoke : certains
# réseaux interceptent TLS et cassent la vérification de révocation OCSP (sinon échec
# CRYPT_E_NO_REVOCATION_CHECK). Inoffensif sur un réseau normal.
function Get-File([string]$url, [string]$out) {
  Info "  téléchargement $url"
  & curl.exe --ssl-no-revoke -fL --retry 3 -o $out $url
  if ($LASTEXITCODE -ne 0) { throw "Échec du téléchargement : $url" }
}

New-Item -ItemType Directory -Force -Path $tools | Out-Null

# ---------------------------------------------------------------------------
# 1/4 — uv
# ---------------------------------------------------------------------------
Info "== 1/4 : uv =="
if ($Force -or -not (Test-Path $uvExe)) {
  $zip = Join-Path $env:TEMP "uv.zip"
  $ext = Join-Path $env:TEMP "uv-extract"
  Get-File "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip" $zip
  if (Test-Path $ext) { Remove-Item -Recurse -Force $ext }
  Expand-Archive $zip -DestinationPath $ext -Force
  Copy-Item (Join-Path $ext "uv.exe") $uvExe -Force
  Remove-Item -Force $zip; Remove-Item -Recurse -Force $ext
  Ok "uv installé"
} else {
  Ok "uv déjà présent ($(& $uvExe --version))"
}

# ---------------------------------------------------------------------------
# 2/4 — Python 3.12 + venv + deps backend
# ---------------------------------------------------------------------------
Info "== 2/4 : Python $PythonSpec + venv + dépendances backend =="
if ($Force -and (Test-Path $venvDir)) { Remove-Item -Recurse -Force $venvDir }
if (-not (Test-Path $venvPython)) {
  # uv télécharge Python 3.12 dans .tools\python\ au besoin, puis crée le venv.
  & $uvExe venv $venvDir --python $PythonSpec
  if ($LASTEXITCODE -ne 0) { throw "Échec de la création du venv" }
  Ok "venv créé"
} else {
  Ok "venv déjà présent"
}
# Installation/synchro des deps (le venv uv n'a pas pip : on passe par `uv pip`).
$lock = Join-Path $root "backend\requirements-lock.txt"
& $uvExe pip install --python $venvPython -r $lock
if ($LASTEXITCODE -ne 0) { throw "Échec de l'installation des dépendances backend" }
Ok "dépendances backend installées"

# ---------------------------------------------------------------------------
# 3/4 — Node.js portable
# ---------------------------------------------------------------------------
Info "== 3/4 : Node.js $NodeVersion (portable) =="
if ($Force -and (Test-Path $nodeDir)) { Remove-Item -Recurse -Force $nodeDir }
if (-not (Test-Path $nodeExe)) {
  $name = "node-v$NodeVersion-win-x64"
  $zip  = Join-Path $env:TEMP "$name.zip"
  $ext  = Join-Path $env:TEMP "node-extract"
  Get-File "https://nodejs.org/dist/v$NodeVersion/$name.zip" $zip
  if (Test-Path $ext) { Remove-Item -Recurse -Force $ext }
  Expand-Archive $zip -DestinationPath $ext -Force
  Move-Item (Join-Path $ext $name) $nodeDir -Force
  Remove-Item -Force $zip; Remove-Item -Recurse -Force $ext
  Ok "Node installé ($(& $nodeExe --version))"
} else {
  Ok "Node déjà présent ($(& $nodeExe --version))"
}

# ---------------------------------------------------------------------------
# 4/4 — Dépendances frontend
# ---------------------------------------------------------------------------
if ($SkipFrontend) {
  Info "== 4/4 : frontend ignoré (-SkipFrontend) =="
} else {
  Info "== 4/4 : dépendances frontend (npm install) =="
  $env:Path = "$nodeDir;$env:Path"
  $env:NODE_OPTIONS = "--use-system-ca"   # même contournement TLS que ci-dessus, côté npm
  Push-Location (Join-Path $root "frontend")
  try {
    if ($Force -and (Test-Path "node_modules")) { Remove-Item -Recurse -Force "node_modules" }
    & (Join-Path $nodeDir "npm.cmd") install --no-fund --no-audit
    if ($LASTEXITCODE -ne 0) { throw "Échec de npm install" }
  } finally { Pop-Location }
  Ok "dépendances frontend installées"
}

Write-Host ""
Write-Host "Installation terminée." -ForegroundColor Green
Write-Host "  Lancer l'app  : .\start.ps1" -ForegroundColor White
Write-Host "  Mode dev      : .\start.ps1 -Dev   (backend --reload + Vite hot reload)" -ForegroundColor White
