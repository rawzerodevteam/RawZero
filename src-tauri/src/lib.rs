use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

/// Process Python en cours (sidecar). Tué explicitement à la fermeture de l'app.
struct Sidecar(Mutex<Option<Child>>);

fn pick_free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .expect("impossible de réserver un port local")
        .local_addr()
        .unwrap()
        .port()
}

/// Port préféré du sidecar : la webview charge `http://127.0.0.1:{port}/`, et c'est cette
/// origine (port compris) qui sert de clé de stockage au localStorage (thème, raccourcis
/// clavier, état des panneaux…). Un port aléatoire à chaque lancement repartait donc de zéro
/// à chaque redémarrage de l'app empaquetée (issue #38 : « les paramètres ne persistent pas »).
/// On garde un port fixe pour que l'origine — et donc le stockage — reste stable d'une session
/// à l'autre, et on ne retombe sur un port aléatoire que si celui-ci est indisponible (ex. une
/// autre instance de RawZero tourne déjà).
const PREFERRED_PORT: u16 = 47863;

fn pick_port() -> u16 {
    match TcpListener::bind(("127.0.0.1", PREFERRED_PORT)) {
        Ok(listener) => {
            drop(listener);
            PREFERRED_PORT
        }
        Err(_) => pick_free_port(),
    }
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
    if cfg!(windows) { "rawzero-backend.exe" } else { "rawzero-backend" }
}

/// Chemin du binaire sidecar (backend figé par PyInstaller --onedir).
/// En dev : sous backend/dist (build manuel). En prod : sous le dossier de ressources de l'app
/// (cf. "resources" dans tauri.conf.json, qui copie backend/dist/rawzero-backend → resourceDir/backend).
fn sidecar_path(app: &tauri::App) -> PathBuf {
    if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("backend")
            .join("dist")
            .join("rawzero-backend")
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
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let base_dir = app.path().app_data_dir().expect("app_data_dir introuvable");
            let data_dir = base_dir.join("data");
            std::fs::create_dir_all(&data_dir)?;

            let port = pick_port();
            let bin = sidecar_path(app);
            log::info!("Lancement du sidecar backend : {bin:?} (port {port})");

            let mut cmd = Command::new(&bin);
            cmd.env("PORT", port.to_string())
                .env("DATA_DIR", &data_dir)
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
                // Ne pas ouvrir une webview pointée sur un serveur mort en silence (l'utilisateur
                // verrait juste une page blanche/erreur réseau sans explication) : le processus
                // sidecar orphelin est tué, un message natif explique le problème, puis on quitte.
                if let Some(state) = app.try_state::<Sidecar>() {
                    if let Some(mut child) = state.0.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
                app.dialog()
                    .message(
                        "Le serveur RawZero n'a pas démarré à temps. Vérifiez qu'aucune autre \
                         instance ne tourne déjà, puis relancez l'application.",
                    )
                    .kind(MessageDialogKind::Error)
                    .title("RawZero — échec du démarrage")
                    .blocking_show();
                std::process::exit(1);
            }

            let url = format!("http://127.0.0.1:{port}/").parse().unwrap();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("RawZero")
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
