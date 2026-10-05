use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};

/// A daily note: a markdown file whose name is `YYYY-MM-DD.md`.
#[derive(Serialize)]
struct DailyNote {
    date: String,
    path: String,
    content: String,
}

#[derive(Default)]
struct WatcherState(Mutex<Option<RecommendedWatcher>>);

fn is_date_name(name: &str) -> Option<String> {
    let stem = name.strip_suffix(".md")?;
    let b = stem.as_bytes();
    let ok = b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b
            .iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit());
    ok.then(|| stem.to_string())
}

fn collect(dir: &Path, depth: usize, out: &mut Vec<DailyNote>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        if path.is_dir() {
            if depth > 0 {
                collect(&path, depth - 1, out);
            }
        } else if let Some(date) = is_date_name(&name) {
            if let Ok(content) = fs::read_to_string(&path) {
                out.push(DailyNote {
                    date,
                    path: path.to_string_lossy().to_string(),
                    content,
                });
            }
        }
    }
}

/// Scans the vault (up to 4 levels deep) for daily notes, sorted by date.
#[tauri::command]
fn load_daily(vault: String) -> Result<Vec<DailyNote>, String> {
    let root = PathBuf::from(&vault);
    if !root.is_dir() {
        return Err(format!("폴더를 찾을 수 없어요: {vault}"));
    }
    let mut notes = Vec::new();
    collect(&root, 4, &mut notes);
    notes.sort_by(|a, b| a.date.cmp(&b.date));
    Ok(notes)
}

#[tauri::command]
fn write_note(path: String, content: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, content).map_err(|e| e.to_string())
}

/// Watches the vault and emits `vault-changed` whenever a markdown file changes.
#[tauri::command]
fn watch_vault(app: AppHandle, state: State<WatcherState>, vault: String) -> Result<(), String> {
    let handle = app.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            let touches_md = event
                .paths
                .iter()
                .any(|p| p.extension().is_some_and(|e| e == "md"));
            if touches_md {
                let _ = handle.emit("vault-changed", ());
            }
        }
    })
    .map_err(|e| e.to_string())?;
    watcher
        .watch(Path::new(&vault), RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    *state.0.lock().unwrap() = Some(watcher);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            app.manage(WatcherState::default());
            Ok(())
        })
        // Closing the window only hides it, so the evening reminder can still fire.
        // Quit with Cmd+Q; clicking the Dock icon brings the window back.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![load_daily, write_note, watch_vault])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            let _ = (app, event);
        });
}

#[cfg(test)]
mod tests {
    use super::is_date_name;

    #[test]
    fn date_names() {
        assert_eq!(is_date_name("2026-10-05.md").as_deref(), Some("2026-10-05"));
        assert_eq!(is_date_name("2026-10-5.md"), None);
        assert_eq!(is_date_name("notes.md"), None);
        assert_eq!(is_date_name("2026-10-05.txt"), None);
    }
}
