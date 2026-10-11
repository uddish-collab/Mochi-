// Notification-area icon: Open, Weekly recap, Wardrobe, Settings, Pause, Show/Hide, Quit.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::i18n::{n_, t};
use crate::island::WINDOW_LABEL;

/// The menu's items, id and English label, in order.
const ITEMS: [(&str, &str); 7] = [
    ("open", n_("Open Mochi")),
    ("recap", n_("Weekly recap")),
    ("wardrobe", n_("Wardrobe…")),
    ("settings", n_("Settings…")),
    ("pause", n_("Pause")),
    ("show_hide", n_("Hide Mochi")),
    ("quit", n_("Quit")),
];

/// Kept so language changes or visibility state changes can relabel the menu.
struct Items(Vec<(&'static str, MenuItem<Wry>)>);

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let mut items = Vec::new();
    for (id, label) in ITEMS {
        items.push((label, MenuItem::with_id(app, id, t(label), true, None::<&str>)?));
    }
    let [open, recap, wardrobe, settings, pause, show_hide, quit] = [0, 1, 2, 3, 4, 5, 6].map(|i| &items[i].1);
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(
        app,
        &[open, recap, &sep1, wardrobe, settings, pause, &sep2, show_hide, quit],
    )?;
    app.manage(Items(items));

    let mut builder = TrayIconBuilder::with_id("Mochi")
        .tooltip("Mochi")
        .menu(&menu)
        .on_menu_event(|app: &AppHandle, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            "settings" => crate::show_settings_window(app),
            "show_hide" => {
                if let Some(win) = crate::island::window(app) {
                    let is_visible = win.is_visible().unwrap_or(true);
                    if is_visible {
                        let _ = win.hide();
                        crate::integrations::set_paused(true);
                        update_visibility_label(app, false);
                    } else {
                        let _ = win.show();
                        crate::integrations::set_paused(false);
                        update_visibility_label(app, true);
                    }
                }
            }
            id => {
                let _ = app.emit_to(WINDOW_LABEL, "tray", id.to_string());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    Ok(())
}

/// Relabels the menu in the current language, preserving visibility text.
pub fn retitle(app: &AppHandle) {
    let Some(items) = app.try_state::<Items>() else { return };
    let Some(win) = crate::island::window(app) else { return };
    let visible = win.is_visible().unwrap_or(true);

    for (label, item) in &items.0 {
        if *label == "Hide Mochi" || *label == "Show Mochi" {
            let text = if visible { t("Hide Mochi") } else { t("Show Mochi") };
            let _ = item.set_text(text);
        } else {
            let _ = item.set_text(t(label));
        }
    }
}

/// Dynamically updates the Show/Hide tray menu text based on window visibility state.
pub fn update_visibility_label(app: &AppHandle, visible: bool) {
    let Some(items) = app.try_state::<Items>() else { return };
    for (label, item) in &items.0 {
        if label.contains("Hide") || label.contains("Show") || *label == "Hide Mochi" || *label == "Show Mochi" {
            let new_text = if visible { t("Hide Mochi") } else { t("Show Mochi") };
            let _ = item.set_text(new_text);
            break;
        }
    }
}