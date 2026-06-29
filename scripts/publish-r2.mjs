#!/usr/bin/env node
// Upload des artefacts updater Tauri + manifeste vers R2.
// Un manifeste PAR PLATEFORME (latest-<target>-<arch>.json) : chaque runner CI
// publie le sien, donc aucun job de fusion entre OS. L'updater (tauri.conf.json)
// lit https://<public>.r2.dev/latest-{{target}}-{{arch}}.json.
//
// Auth wrangler : CLOUDFLARE_API_TOKEN (+ CLOUDFLARE_ACCOUNT_ID) en CI, OAuth en local.
// Usage : node scripts/publish-r2.mjs          (build réel : lit le bundle, upload)
//         node scripts/publish-r2.mjs --self-check   (vérifie la logique, sans réseau)

import { readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BUCKET = process.env.R2_BUCKET || "rawstudio-updates";
const PUBLIC_BASE = (process.env.R2_PUBLIC_BASE || "https://pub-2c5d731ce2a44186877bd788147f06a0.r2.dev").replace(/\/$/, "");
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE_DIR = join(REPO_ROOT, "src-tauri", "target", "release", "bundle");

const TARGET = { linux: "linux", win32: "windows", darwin: "darwin" }[process.platform] || process.platform;
const ARCH = { x64: "x86_64", arm64: "aarch64", ia32: "i686", arm: "armv7" }[process.arch] || process.arch;

// Tous les .sig sous dir (Node 20 n'a pas fs.globSync).
function findSigs(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...findSigs(p));
    else if (name.endsWith(".sig")) out.push(p);
  }
  return out;
}

// Construit le manifeste Tauri v2 à partir des paires artefact/.sig d'un runner.
// platformKey = "<target>-<arch>" (ex. linux-x86_64) ; signature = contenu du .sig.
function buildManifest({ version, platformKey, artifacts, notes = "", pubDate = new Date().toISOString() }) {
  if (artifacts.length === 0) throw new Error("aucun artefact updater (.sig) trouvé — la signature a-t-elle tourné ?");
  const platforms = {};
  for (const { name, signature } of artifacts) {
    platforms[platformKey] = {
      signature,
      url: `${PUBLIC_BASE}/${version}/${encodeURIComponent(name)}`,
    };
  }
  return { version, notes, pub_date: pubDate, platforms };
}

function wrangler(args) {
  const r = spawnSync("npx", ["--yes", "wrangler", ...args], { stdio: "inherit", shell: true });
  if (r.status !== 0) throw new Error(`wrangler ${args.join(" ")} a échoué (code ${r.status})`);
}

function putObject(key, file, contentType, cacheControl) {
  wrangler(["r2", "object", "put", `${BUCKET}/${key}`, `--file=${file}`, "--remote",
    `--content-type=${contentType}`, `--cache-control=${cacheControl}`]);
}

function main() {
  const conf = JSON.parse(readFileSync(join(REPO_ROOT, "src-tauri", "tauri.conf.json"), "utf8"));
  const version = conf.version;
  const platformKey = `${TARGET}-${ARCH}`;

  const sigs = findSigs(BUNDLE_DIR);
  const artifacts = sigs.map((sig) => {
    const artifactPath = sig.slice(0, -4); // retire ".sig"
    return { path: artifactPath, name: basename(artifactPath), signature: readFileSync(sig, "utf8").trim() };
  });

  // Binaires : chemin versionné => cache immuable. Manifeste : jamais caché.
  for (const a of artifacts) {
    putObject(`${version}/${a.name}`, a.path, "application/octet-stream", "public, max-age=31536000, immutable");
  }
  const manifest = buildManifest({ version, platformKey, artifacts, notes: process.env.UPDATE_NOTES || "" });
  const manifestFile = join(tmpdir(), `latest-${platformKey}.json`);
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  putObject(`latest-${platformKey}.json`, manifestFile, "application/json", "no-cache, must-revalidate");

  console.log(`Publié ${platformKey} v${version} : ${artifacts.length} artefact(s) + manifeste sur ${PUBLIC_BASE}`);
}

function selfCheck() {
  const dir = mkdtempSync(join(tmpdir(), "r2chk-"));
  writeFileSync(join(dir, "rawstudio_0.1.0_amd64.AppImage"), "BIN");
  writeFileSync(join(dir, "rawstudio_0.1.0_amd64.AppImage.sig"), "  SIGDATA\n");
  writeFileSync(join(dir, "rawstudio_0.1.0_amd64.deb"), "no sig -> ignoré");

  const sigs = findSigs(dir);
  console.assert(sigs.length === 1, "doit trouver exactement 1 .sig (le .deb sans sig est ignoré)");

  const artifacts = sigs.map((s) => ({ name: basename(s.slice(0, -4)), signature: readFileSync(s, "utf8").trim() }));
  const m = buildManifest({ version: "0.1.0", platformKey: "linux-x86_64", artifacts, pubDate: "2026-06-29T00:00:00Z" });
  console.assert(m.version === "0.1.0", "version");
  console.assert(m.platforms["linux-x86_64"].signature === "SIGDATA", ".sig lu et trimmé");
  console.assert(
    m.platforms["linux-x86_64"].url === `${PUBLIC_BASE}/0.1.0/rawstudio_0.1.0_amd64.AppImage`,
    "url = base/version/nom"
  );

  try { buildManifest({ version: "0.1.0", platformKey: "linux-x86_64", artifacts: [] }); throw new Error("aurait dû échouer"); }
  catch (e) { console.assert(/aucun artefact/.test(e.message), "échoue si pas d'artefact"); }

  console.log("self-check OK");
}

process.argv.includes("--self-check") ? selfCheck() : main();
