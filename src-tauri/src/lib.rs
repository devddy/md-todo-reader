use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};

#[cfg(target_os = "macos")]
mod notch;

/// A daily note: a markdown file whose name is `YYYY-MM-DD.md`.
#[derive(Serialize)]
struct DailyNote {
    date: String,
    path: String,
    content: String,
}

/// A sprint note written by the `/sprint-sync` skill: `<vault>/sprints/*.md`.
#[derive(Serialize)]
struct SprintFile {
    path: String,
    name: String,
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

fn collect_sprints(dir: &Path) -> Vec<SprintFile> {
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<SprintFile> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || !path.is_file() {
                return None;
            }
            let stem = name.strip_suffix(".md")?.to_string();
            let content = fs::read_to_string(&path).ok()?;
            Some(SprintFile {
                path: path.to_string_lossy().to_string(),
                name: stem,
                content,
            })
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Reads `<vault>/sprints/*.md` (not recursive). A missing folder just means no sprints yet.
#[tauri::command]
fn load_sprints(vault: String) -> Result<Vec<SprintFile>, String> {
    let root = PathBuf::from(&vault);
    if !root.is_dir() {
        return Err(format!("폴더를 찾을 수 없어요: {vault}"));
    }
    Ok(collect_sprints(&root.join("sprints")))
}

fn find_named(dir: &Path, depth: usize, name: &str) -> Option<PathBuf> {
    let entries = fs::read_dir(dir).ok()?;
    let mut dirs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let file = entry.file_name().to_string_lossy().to_string();
        if file.starts_with('.') || file == "node_modules" {
            continue;
        }
        if path.is_dir() {
            dirs.push(path);
        } else if file == name {
            return Some(path);
        }
    }
    if depth == 0 {
        return None;
    }
    dirs.into_iter().find_map(|d| find_named(&d, depth - 1, name))
}

/// One daily note by date, without reading the rest of the vault (notch panel).
#[tauri::command]
fn find_daily(vault: String, date: String) -> Result<Option<DailyNote>, String> {
    let root = PathBuf::from(&vault);
    if !root.is_dir() {
        return Err(format!("폴더를 찾을 수 없어요: {vault}"));
    }
    let Some(path) = find_named(&root, 4, &format!("{date}.md")) else {
        return Ok(None);
    };
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(Some(DailyNote {
        date,
        path: path.to_string_lossy().to_string(),
        content,
    }))
}

/// Folder for a new daily note: next to the latest existing `YYYY-MM-DD.md`,
/// else `<vault>/daily` (same rule as `folderForNew` in notes.ts).
fn latest_daily_dir(dir: &Path, depth: usize, best: &mut Option<(String, PathBuf)>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        if path.is_dir() {
            if depth > 0 {
                latest_daily_dir(&path, depth - 1, best);
            }
        } else if let Some(date) = is_date_name(&name) {
            if best.as_ref().is_none_or(|(d, _)| date > *d) {
                *best = Some((date, dir.to_path_buf()));
            }
        }
    }
}

/// Where the notch panel creates today's note when it does not exist yet.
#[tauri::command]
fn new_daily_path(vault: String, date: String) -> Result<String, String> {
    let root = PathBuf::from(&vault);
    if !root.is_dir() {
        return Err(format!("폴더를 찾을 수 없어요: {vault}"));
    }
    let mut best = None;
    latest_daily_dir(&root, 4, &mut best);
    let dir = best.map_or_else(|| root.join("daily"), |(_, d)| d);
    Ok(dir.join(format!("{date}.md")).to_string_lossy().to_string())
}

/// Fresh read right before a write, so a toggle never clobbers edits made elsewhere.
#[tauri::command]
fn read_note(path: String) -> Result<String, String> {
    fs::read_to_string(path).map_err(|e| e.to_string())
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

/// The webview of the notch panel reports its content height (macOS only).
#[tauri::command]
fn notch_set_height(app: AppHandle, height: f64) {
    #[cfg(target_os = "macos")]
    notch::set_height(&app, height);
    #[cfg(not(target_os = "macos"))]
    let _ = (app, height);
}

/// The notch add-input: `pinned` keeps the panel open, `key` gives it the keyboard (macOS only).
#[tauri::command]
fn notch_set_pinned(app: AppHandle, pinned: bool, key: bool) {
    #[cfg(target_os = "macos")]
    notch::set_pinned(&app, pinned, key);
    #[cfg(not(target_os = "macos"))]
    let _ = (app, pinned, key);
}

/// tauri-nspanel keeps the swizzled panels in its own state; a no-op plugin off macOS.
fn tauri_plugin_notch_panel<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    #[cfg(target_os = "macos")]
    return tauri_nspanel::init();
    #[cfg(not(target_os = "macos"))]
    tauri::plugin::Builder::new("nspanel").build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_notch_panel())
        .setup(|app| {
            app.manage(WatcherState::default());
            #[cfg(target_os = "macos")]
            notch::setup(app.handle())?;
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
        .invoke_handler(tauri::generate_handler![
            load_daily,
            load_sprints,
            find_daily,
            new_daily_path,
            read_note,
            write_note,
            watch_vault,
            notch_set_height,
            notch_set_pinned
        ])
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
    use super::{collect_sprints, find_daily, is_date_name, new_daily_path};
    use std::fs;

    #[test]
    fn date_names() {
        assert_eq!(is_date_name("2026-10-05.md").as_deref(), Some("2026-10-05"));
        assert_eq!(is_date_name("2026-10-5.md"), None);
        assert_eq!(is_date_name("notes.md"), None);
        assert_eq!(is_date_name("2026-10-05.txt"), None);
    }

    #[test]
    fn sprint_files() {
        let dir = std::env::temp_dir().join(format!("md-todo-sprints-{}", std::process::id()));
        let sprints = dir.join("sprints");
        fs::create_dir_all(sprints.join("old")).unwrap();
        fs::write(sprints.join("BE3-sprint-21.md"), "# b").unwrap();
        fs::write(sprints.join("BE3-sprint-20.md"), "# a").unwrap();
        fs::write(sprints.join("notes.txt"), "x").unwrap();
        fs::write(sprints.join(".hidden.md"), "x").unwrap();
        fs::write(sprints.join("old").join("BE3-sprint-19.md"), "x").unwrap();

        let found = collect_sprints(&sprints);
        let names: Vec<_> = found.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["BE3-sprint-20", "BE3-sprint-21"]);
        assert_eq!(found[0].content, "# a");
        assert!(collect_sprints(&dir.join("missing")).is_empty());

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn find_daily_by_date() {
        let dir = std::env::temp_dir().join(format!("md-todo-find-{}", std::process::id()));
        fs::create_dir_all(dir.join("work").join("daily")).unwrap();
        fs::write(dir.join("work").join("daily").join("2026-10-10.md"), "## 오늘 꼭").unwrap();
        let vault = dir.to_string_lossy().to_string();

        let found = find_daily(vault.clone(), "2026-10-10".into()).unwrap().unwrap();
        assert!(found.path.ends_with("work/daily/2026-10-10.md"));
        assert_eq!(found.content, "## 오늘 꼭");
        assert!(find_daily(vault.clone(), "2026-10-11".into()).unwrap().is_none());

        // A new note goes next to the latest existing one, else into <vault>/daily.
        fs::create_dir_all(dir.join("old")).unwrap();
        fs::write(dir.join("old").join("2025-01-01.md"), "").unwrap();
        let next = new_daily_path(vault, "2026-10-11".into()).unwrap();
        assert!(next.ends_with("work/daily/2026-10-11.md"));
        let empty = std::env::temp_dir().join(format!("md-todo-empty-{}", std::process::id()));
        fs::create_dir_all(&empty).unwrap();
        let fresh = new_daily_path(empty.to_string_lossy().to_string(), "2026-10-11".into()).unwrap();
        assert!(fresh.ends_with("daily/2026-10-11.md"));
        fs::remove_dir_all(&empty).unwrap();

        fs::remove_dir_all(&dir).unwrap();
    }
}
