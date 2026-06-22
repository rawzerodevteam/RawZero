use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

/// Process Python en cours (sidecar). Tué explicitement à la fermeture de l'app.
struct Sidecar(Mutex<Option<Child>>);

fn pick_free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .expect("impossible de réserver un port local")
        .local_addr()
        .unwrap()
        .port()
}

/// Attend que le sidecar accepte des connexions TCP (= uvicorn a démarré).
fn wait_for_port(port: u16, timeout: Duration) -> bool {
    let addr: SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

/// Nom du binaire sidecar selon l'OS (PyInstaller ajoute `.exe` sous Windows).
fn bin_name() -> &'static str {
    if cfg!(windows) { "rawstudio-backend.exe" } else { "rawstudio-backend" }
}

/// Chemin du binaire sidecar (backend figé par PyInstaller --onedir).
/// En dev : sous backend/dist (build manuel). En prod : sous le dossier de ressources de l'app
/// (cf. "resources" dans tauri.conf.json, qui copie backend/dist/rawstudio-backend → resourceDir/backend).
fn sidecar_path(app: &tauri::App) -> PathBuf {
    if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("backend")
            .join("dist")
            .join("rawstudio-backend")
            .join(bin_name())
    } else {
        app.path()
            .resource_dir()
            .expect("resource dir introuvable")
            .join("backend")
            .join(bin_name())
    }
}

/// Dossier des assets frontend buildés, servis par le sidecar (STATIC_DIR).
fn static_dir(app: &tauri::App) -> PathBuf {
    if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("frontend").join("dist")
    } else {
        app.path()
            .resource_dir()
            .expect("resource dir introuvable")
            .join("frontend-dist")
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let base_dir = app.path().app_data_dir().expect("app_data_dir introuvable");
            let import_dir = base_dir.join("import");
            let data_dir = base_dir.join("data");
            std::fs::create_dir_all(&data_dir)?;
            std::fs::create_dir_all(&import_dir)?;

            let port = pick_free_port();
            let bin = sidecar_path(app);
            log::info!("Lancement du sidecar backend : {bin:?} (port {port})");

            let mut cmd = Command::new(&bin);
            cmd.env("PORT", port.to_string())
                .env("DATA_DIR", &data_dir)
                .env("IMPORT_DIR", &import_dir)
                .env("STATIC_DIR", static_dir(app))
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit());
            // Si le process Tauri meurt brutalement (crash, kill -9, OOM), le sidecar reçoit
            // SIGTERM automatiquement au lieu de rester orphelin : RunEvent::Exit ne se déclenche
            // que sur une fermeture propre, pas sur un kill direct du process parent.
            #[cfg(unix)]
            unsafe {
                use std::os::unix::process::CommandExt;
                cmd.pre_exec(|| {
                    libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
                    Ok(())
                });
            }
            let child = cmd
                .spawn()
                .unwrap_or_else(|e| panic!("échec du lancement du sidecar {bin:?}: {e}"));

            app.manage(Sidecar(Mutex::new(Some(child))));

            if !wait_for_port(port, Duration::from_secs(20)) {
                log::error!("Le sidecar backend n'a pas répondu sur le port {port} dans le délai imparti");
            }

            let url = format!("http://127.0.0.1:{port}/").parse().unwrap();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("RawStudio")
                .inner_size(1400.0, 900.0)
                .min_inner_size(1024.0, 700.0)
                .build()?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("erreur au lancement de l'application Tauri")
        .run(|app_handle, event| {
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<Sidecar>() {
                    if let Some(mut child) = state.0.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
            }
        });
}
