// Global show/hide for Mochi's island. Author: Uddish.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::AppHandle;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// Edit this one line to change the hotkey.
pub const TOGGLE_SHORTCUT: &str = "Ctrl+M";

/// True while the user has hidden Mochi with the hotkey. The start-up routine in
/// lib.rs checks it, so it never shows Mochi again against the user's wish.
static USER_HID: AtomicBool = AtomicBool::new(false);

pub fn user_hid() -> bool {
    USER_HID.load(Ordering::Relaxed)
}

/// Registers the toggle, and push-to-talk beside it: every place that has to put
/// Mochi's own shortcuts back after the others were applied calls this one
/// function. Safe to call again: each drops its own registration first.
pub fn register(app: &AppHandle) {
    if crate::platform::global_shortcuts_blocked().is_some() {
        return;
    }
    crate::voice::register(app);
    let gs = app.global_shortcut();
    let _ = gs.unregister(TOGGLE_SHORTCUT);
    let result = gs.on_shortcut(TOGGLE_SHORTCUT, |app, _shortcut, event| {
        if event.state() == ShortcutState::Pressed {
            toggle(app);
        }
    });
    if let Err(err) = result {
        crate::log::line(format!("visibility shortcut failed: {err}"));
    }
}

fn toggle(app: &AppHandle) {
    let Some(win) = crate::island::window(app) else { return };
    let hide = win.is_visible().unwrap_or(true);
    USER_HID.store(hide, Ordering::Relaxed);
    if hide {
        let _ = win.hide();
    } else {
        let _ = win.show();
    }
    // Hidden means stopped: the pollers stop talking to the network too.
    crate::integrations::set_paused(hide);
}