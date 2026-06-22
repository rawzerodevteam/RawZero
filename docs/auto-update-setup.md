# Auto-Update Setup (issue #14)

How the Tauri auto-updater is wired up for RawStudio, and what to do if the
signing key ever needs to be rotated.

## How it works

1. `src-tauri/tauri.conf.json` → `plugins.updater` holds the public key and
   the endpoint (`.../releases/latest/download/latest.json`).
2. On every tag push (`v*`), `.github/workflows/release.yml` builds the
   installers via `tauri-apps/tauri-action`, signs them with the private key,
   and publishes `latest.json` to the GitHub Release.
3. The app checks that endpoint via the "Check for updates" button in
   Settings (`@tauri-apps/plugin-updater` + `plugin-process` to restart after
   install).

## One-time setup (already done)

1. Generate the key pair:
   ```
   npx tauri signer generate -w .tauri/rawstudio.key
   ```
   This creates `rawstudio.key` (private, password-protected) and
   `rawstudio.key.pub` (public).
2. Paste the public key into `tauri.conf.json` → `plugins.updater.pubkey`.
3. Upload the private key + password as GitHub Actions secrets (CI needs
   them to sign, never commit them):
   ```
   Get-Content -Raw .tauri\rawstudio.key | gh secret set TAURI_SIGNING_PRIVATE_KEY --repo rawzerodevteam/RawZero
   gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo rawzerodevteam/RawZero
   ```
4. Keep `.tauri/rawstudio.key` somewhere safe outside the repo (currently
   `Project RawZero/.tauri/`, sibling to the repo folder) — losing it means
   every future signed update is rejected by apps running an older signed
   build.

## Releasing a new version

1. Bump the version in `src-tauri/tauri.conf.json` and `package.json`.
2. Push a tag: `git tag v0.1.x && git push origin v0.1.x`.
3. CI builds, signs, and creates a **draft** GitHub Release with the
   installers + `latest.json`.
4. Review the draft, then publish it. Apps poll the endpoint and will offer
   the update on next "Check for updates".

## If the private key is lost or compromised

There's no recovery — regenerate:

1. `npx tauri signer generate -w .tauri/rawstudio.key`
2. Update `tauri.conf.json` with the new `pubkey`.
3. Re-upload both secrets (same commands as above).
4. Cut a new release. Apps signed with the *old* key won't trust updates
   signed with the new key automatically — users on very old builds may need
   to reinstall manually once.
