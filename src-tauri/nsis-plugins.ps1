# Dépose le plugin NSIS EnVar là où makensis (téléchargé par Tauri) le cherche, pour que
# installer-hooks.nsh puisse modifier le PATH sans risque de troncature. Idempotent : ne
# retélécharge pas si le DLL est déjà présent. À lancer avant `tauri build` (Windows uniquement).
$ErrorActionPreference = 'Stop'

$dir = Join-Path $env:LOCALAPPDATA 'tauri\NSIS\Plugins\x86-unicode'
$dll = Join-Path $dir 'EnVar.dll'
if (Test-Path $dll) { Write-Host "EnVar.dll déjà présent : $dll"; return }

New-Item -ItemType Directory -Force -Path $dir | Out-Null
$zip = Join-Path $env:TEMP 'EnVar_plugin.zip'
$ext = Join-Path $env:TEMP 'EnVar_plugin'
Invoke-WebRequest 'https://nsis.sourceforge.io/mediawiki/images/7/7f/EnVar_plugin.zip' -OutFile $zip
Expand-Archive $zip -DestinationPath $ext -Force
Copy-Item (Join-Path $ext 'Plugins\x86-unicode\EnVar.dll') $dll -Force
Write-Host "EnVar.dll installé : $dll"
