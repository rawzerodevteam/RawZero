; Hooks NSIS pour l'installeur Windows de RawZero.
; Tauri appelle ces macros pendant l'install/désinstall (cf. bundle.windows.nsis.installerHooks).
;
; Seul rôle ici : ajouter / retirer le dossier d'install du PATH.
; On passe par le plugin EnVar (fetché par src-tauri/nsis-plugins.ps1 avant le build) car il
; gère les PATH longs sans tronquer — contrairement à un WriteRegStr manuel (limite ~1024 car.),
; qui corromprait silencieusement le PATH de l'utilisateur.

!macro NSIS_HOOK_POSTINSTALL
  ; ponytail: écrit dans le PATH utilisateur (HKCU) → pas d'élévation requise.
  ; Pour un PATH "toutes machines", remplacer par EnVar::SetHKLM (nécessite l'install per-machine).
  EnVar::SetHKCU
  EnVar::AddValue "Path" "$INSTDIR"
  Pop $0
  DetailPrint "RawZero: ajout au PATH de '$INSTDIR' (code EnVar: $0)"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  EnVar::SetHKCU
  EnVar::DeleteValue "Path" "$INSTDIR"
  Pop $0
  DetailPrint "RawZero: retrait du PATH de '$INSTDIR' (code EnVar: $0)"
!macroend
