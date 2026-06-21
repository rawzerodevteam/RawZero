# Build complet de l'app desktop Tauri sous Windows : sidecar backend (PyInstaller) +
# frontend (Vite) + bundle Tauri (.msi/.exe). Miroir Windows de build-desktop.sh.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

Write-Host "== 1/3 : sidecar backend (PyInstaller) =="
Push-Location backend
& .venv\Scripts\pyinstaller.exe --noconfirm rawstudio-backend.spec
Pop-Location

Write-Host "== 2/3 : frontend (Vite) =="
Push-Location frontend
npm run build
Pop-Location

Write-Host "== 3/3 : bundle Tauri (.exe NSIS) =="
& "$PSScriptRoot\src-tauri\nsis-plugins.ps1"   # plugin EnVar pour l'ajout au PATH
npx --prefix frontend tauri build

Write-Host "`nBundle prêt : src-tauri\target\release\bundle\"
Get-ChildItem src-tauri\target\release\bundle -Recurse -Include *.msi,*.exe -ErrorAction SilentlyContinue |
  Select-Object FullName
