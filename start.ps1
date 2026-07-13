<#
.SYNOPSIS
  Lance RawZero en local sans Docker (outillage portable .tools).

.DESCRIPTION
  Mode par défaut : build le frontend si nécessaire puis sert API + frontend
  sur un seul port via uvicorn (comme l'image Docker). Ctrl+C pour arrêter.

  -Dev      : uvicorn --reload + serveur Vite (hot reload) → http://localhost:5173
  -Rebuild  : force le rebuild du frontend avant de lancer
  -NoBrowser: ne pas ouvrir le navigateur automatiquement
  -Port     : port du backend (8000 par défaut)

.EXAMPLE
  .\start.ps1            # lancement normal
  .\start.ps1 -Dev       # développement frontend avec hot reload
  .\start.ps1 -Rebuild   # après modification du frontend, sans -Dev
#>
param(
  [switch]$Dev,
  [switch]$Rebuild,
  [switch]$NoBrowser,
  [int]$Port = 8000
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

$python  = Join-Path $root ".tools\venv\Scripts\python.exe"
$nodeDir = Join-Path $root ".tools\node"
$front   = Join-Path $root "frontend"
$dist    = Join-Path $front "dist"

# ---- Vérification des prérequis (l'installation se fait via bootstrap.ps1) ----
if (-not (Test-Path $python) -or -not (Test-Path (Join-Path $nodeDir "node.exe"))) {
  Write-Host "Outillage portable introuvable (.tools manquant ou incomplet)." -ForegroundColor Red
  Write-Host "Lancer d'abord l'installation : .\bootstrap.ps1" -ForegroundColor Yellow
  exit 1
}

$env:Path = "$nodeDir;$env:Path"
$env:NODE_OPTIONS = "--use-system-ca"   # réseau avec interception TLS (cf. CLAUDE.md / mémoire projet)

if (-not (Test-Path (Join-Path $front "node_modules"))) {
  Write-Host "frontend\node_modules est absent : npm install est nécessaire." -ForegroundColor Yellow
  $rep = Read-Host "Lancer 'npm install' maintenant ? (o/N)"
  if ($rep -notmatch '^[oOyY]') { Write-Host "Abandon."; exit 1 }
  Push-Location $front
  & (Join-Path $nodeDir "npm.cmd") install --no-fund --no-audit
  if ($LASTEXITCODE -ne 0) { Pop-Location; exit 1 }
  Pop-Location
}

# ---- Accélérateur natif Rust (rsfast) : optionnel, compilé si cargo est présent ----
# Le pipeline détecte la DLL au runtime et retombe sur NumPy si elle est absente
# (cf. backend/app/rsfast.py). On ne bloque jamais le lancement là-dessus.
$rsfastDir = Join-Path $root "backend\rsfast"
$rsfastDll = Join-Path $rsfastDir "target\release\rsfast.dll"
$cargo = Get-Command cargo -ErrorAction SilentlyContinue
if ($cargo) {
  $needBuild = $Rebuild -or (-not (Test-Path $rsfastDll))
  if (-not $needBuild) {
    $srcNewest = Get-ChildItem (Join-Path $rsfastDir "src") -Recurse -File -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    if ($srcNewest -and $srcNewest.LastWriteTimeUtc -gt (Get-Item $rsfastDll).LastWriteTimeUtc) { $needBuild = $true }
  }
  if ($needBuild) {
    Write-Host "Build de l'accélérateur natif rsfast (cargo --release)…" -ForegroundColor Cyan
    Push-Location $rsfastDir
    & $cargo.Source build --release
    if ($LASTEXITCODE -ne 0) { Write-Host "  build rsfast échoué → repli NumPy" -ForegroundColor Yellow }
    Pop-Location
  }
} elseif (-not (Test-Path $rsfastDll)) {
  Write-Host "cargo introuvable : rsfast non compilé → pipeline NumPy (perf normale)." -ForegroundColor DarkGray
}

# ---- Variables d'environnement de l'app ----
$env:DATA_DIR = Join-Path $root "data"
New-Item -ItemType Directory -Force -Path $env:DATA_DIR | Out-Null

# ---- Le build du frontend est-il périmé par rapport aux sources ? ----
function Test-FrontendStale([string]$front, [string]$dist) {
  $index = Join-Path $dist "index.html"
  if (-not (Test-Path $index)) { return $true }
  $builtAt = (Get-Item $index).LastWriteTimeUtc
  $watch = @("src", "index.html", "package.json", "vite.config.ts", "tsconfig.json") |
    ForEach-Object { Join-Path $front $_ } | Where-Object { Test-Path $_ }
  foreach ($p in $watch) {
    $newest = Get-ChildItem -Path $p -Recurse -File -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    if ($newest -and $newest.LastWriteTimeUtc -gt $builtAt) { return $true }
  }
  return $false
}

# ---- Ouverture du navigateur quand le serveur répond ----
function Open-WhenReady([string]$url, [string]$healthUrl) {
  if ($NoBrowser) { return }
  # Supprime tout job d'ouverture resté d'un lancement précédent : sinon ces
  # « pollers » fantômes ouvrent chacun un onglet dès que le serveur répond.
  Get-Job -Name "rawzero-open" -ErrorAction SilentlyContinue | Remove-Job -Force
  Start-Job -Name "rawzero-open" -ArgumentList $url, $healthUrl -ScriptBlock {
    param($u, $h)
    $ok = $false
    foreach ($i in 1..40) {
      try { Invoke-WebRequest -Uri $h -UseBasicParsing -TimeoutSec 1 | Out-Null; $ok = $true; break }
      catch { Start-Sleep -Milliseconds 500 }
    }
    if ($ok) { Start-Process $u }
  } | Out-Null
}

if ($Dev) {
  # ---- Mode développement : backend --reload en arrière-plan + Vite au premier plan ----
  # On limite la surveillance au code source backend : sinon uvicorn --reload watche tout le
  # dossier racine (node_modules, .tools, et surtout data/ et ses milliers de fichiers de cache
  # régénérés en tâche de fond) → reload lent et redémarrages intempestifs.
  $env:STATIC_DIR = ""
  $backendSrc = Join-Path $root "backend\app"
  Write-Host "Backend (reload) : http://localhost:$Port — Frontend (Vite) : http://localhost:5173" -ForegroundColor Cyan
  Write-Host "  → Ouvre http://localhost:5173 (HMR). Code front = instantané, code Python = redémarrage auto." -ForegroundColor DarkGray
  $backend = Start-Process -PassThru -NoNewWindow $python `
    -ArgumentList "-m", "uvicorn", "app.main:app", "--app-dir", "backend", "--reload", "--reload-dir", $backendSrc, "--port", $Port
  try {
    Open-WhenReady "http://localhost:5173" "http://localhost:5173"
    Push-Location $front
    & (Join-Path $nodeDir "npm.cmd") run dev
  } finally {
    Pop-Location
    if (-not $backend.HasExited) { Stop-Process -Id $backend.Id -Force }
  }
} else {
  # ---- Mode normal : un seul serveur, comme dans Docker ----
  if ($Rebuild -or (Test-FrontendStale $front $dist)) {
    Write-Host "Build du frontend (sources modifiées)…" -ForegroundColor Cyan
    Push-Location $front
    & (Join-Path $nodeDir "npm.cmd") run build
    if ($LASTEXITCODE -ne 0) { Pop-Location; exit 1 }
    Pop-Location
  }
  $env:STATIC_DIR = $dist
  Write-Host "RawZero : http://localhost:$Port  (Ctrl+C pour arrêter)" -ForegroundColor Cyan
  Open-WhenReady "http://localhost:$Port" "http://localhost:$Port/api/health"
  & $python -m uvicorn app.main:app --app-dir backend --port $Port
}
