// Coucou for Windows — app wiring and the commands the island calls.

mod agent_hooks;
mod agents;
mod chat;
mod claude;
mod codex_plan;
mod config_file;
mod desktop;
mod files;
mod github;
mod hooks;
mod i18n;
mod identity;
mod integrations;
mod island;
mod local_chat;
mod log;
mod net;
mod openai_compat;
mod pipe;
mod platform;
#[cfg(target_os = "linux")]
mod portal;
mod recap;
mod secrets;
mod session_window;
mod settings;
mod shortcuts;
mod sounds;
mod tray;
mod visibility;
mod voice;
#[cfg(windows)]
mod webview_drop;

use std::process::Command;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::{ManagerExt, MacosLauncher};

use chat::{Chat, ChatContext, ChatReply};
use files::DroppedFile;
use hooks::{HookPreview, HookStatus};
use island::{PollGate, ScreenInfo};
use pipe::Pending;
use settings::Settings;

pub struct Shared {
    pub settings: Mutex<Settings>,
    pub gate: Arc<PollGate>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootInfo {
    settings: Settings,
    screen: ScreenInfo,
    version: String,
    hook_path: String,
    /// False where the OS has no global cursor (Wayland): the page then reports
    /// the cursor from its own mouse events.
    cursor_poll: bool,
}

#[tauri::command]
fn boot(app: AppHandle, shared: State<Shared>) -> BootInfo {
    let mut settings = shared.settings.lock().unwrap().clone();
    // The real state of ~/.claude/settings.json wins over whatever we stored.
    let hooks_status = hooks::status();
    settings.hooks_installed = hooks_status.installed;
    settings.plan_relay_installed = hooks_status.plan_relay_installed;
    let screen = island::screen_info(&app, &settings.screen);
    BootInfo {
        settings,
        screen,
        version: env!("CARGO_PKG_VERSION").to_string(),
        hook_path: settings::hook_exe_path().to_string_lossy().to_string(),
        cursor_poll: platform::CURSOR_POLL,
    }
}

#[tauri::command]
fn save_settings(app: AppHandle, shared: State<Shared>, settings: Settings) {
    let (screen_changed, shortcuts_changed) = {
        let mut current = shared.settings.lock().unwrap();
        let screen_changed = current.screen != settings.screen;
        let shortcuts_changed = current.shortcuts != settings.shortcuts;
        // Where Mochi sits on the desktop is desktop.rs's to say, not a webview's.
        let mut settings = settings.clone();
        settings.desktop_mochi = current.desktop_mochi.clone();
        // Mochi always starts with the computer: whatever a webview sends back
        // can't say otherwise.
        settings.autostart = true;
        *current = settings;
        (screen_changed, shortcuts_changed)
    };
    let settings = shared.settings.lock().unwrap().clone();
    if let Err(err) = settings::save(&settings) {
        log::line(format!("could not save settings: {err}"));
    }
    if screen_changed {
        let collapsed = shared.gate.collapsed.load(Ordering::Relaxed);
        island::apply_geometry(&app, &settings.screen, collapsed);
    }
    integrations::settings_saved(&app, &settings.active_integrations);
    if shortcuts_changed {
        shortcuts::apply(&app, &settings.shortcuts);
        // Applying the stored shortcuts may have let go of the visibility one.
        visibility::register(&app);
    }
    if i18n::set_picked(&settings.language) {
        language_changed(&app);
    }
    // Keep the other window in step (island ⇄ settings window).
    let _ = app.emit("settings-changed", settings);
}

/// The island reports the system's languages at launch, for "System" in
/// Settings → Language (WebView2 and WebKitGTK know them best).
#[tauri::command]
fn set_system_languages(app: AppHandle, languages: Vec<String>) {
    if i18n::set_system(languages) {
        language_changed(&app);
    }
}

/// What Rust labels itself follows the new language: the tray menu and the
/// settings window's title. The webviews switch on their own.
fn language_changed(app: &AppHandle) {
    tray::retitle(app);
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.set_title(&i18n::t("Settings — Coucou"));
    }
}

/// Hidden island → shrink the window to the invisible wake strip and park the
/// cursor poll; anything else → the whole display and 60 Hz polling.
#[tauri::command]
fn set_collapsed(app: AppHandle, shared: State<Shared>, collapsed: bool) {
    let pref = shared.settings.lock().unwrap().screen.clone();
    shared.gate.collapsed.store(collapsed, Ordering::Relaxed);
    island::apply_geometry(&app, &pref, collapsed);
    // The wake strip must always take the mouse, and a resize invalidates the flag.
    island::refresh_click_through(&app, &shared.gate);
    shared.gate.set_active(!collapsed);
    platform::set_pointer_watch(!collapsed);
}

/// The front end pushes the island shape; Rust decides click-through from it.
#[tauri::command]
fn set_island_rect(app: AppHandle, shared: State<Shared>, x: f64, y: f64, width: f64, height: f64) {
    shared.gate.set_rect(island::IslandRect { x, y, w: width, h: height });
    // Without the cursor poll the input region is the click-through: it follows the island.
    if !platform::CURSOR_POLL {
        island::refresh_click_through(&app, &shared.gate);
    }
}

/// The to-do widget's shape, pushed the same way: it takes the mouse too.
/// A zero width means the widget is closed.
#[tauri::command]
fn set_extra_rect(app: AppHandle, shared: State<Shared>, x: f64, y: f64, width: f64, height: f64) {
    shared.gate.set_extra(island::IslandRect { x, y, w: width, h: height });
    if !platform::CURSOR_POLL {
        island::refresh_click_through(&app, &shared.gate);
    }
}

#[tauri::command]
fn focus_window(app: AppHandle, focused: bool) {
    let Some(win) = island::window(&app) else { return };
    platform::set_activating(&win, focused);
    if focused {
        let _ = win.set_focus();
    }
}

#[tauri::command]
fn reposition(app: AppHandle, shared: State<Shared>) {
    let pref = shared.settings.lock().unwrap().screen.clone();
    let collapsed = shared.gate.collapsed.load(Ordering::Relaxed);
    island::apply_geometry(&app, &pref, collapsed);
}

/// The displays the island can be pinned to, for Settings.
#[tauri::command]
fn list_monitors(app: AppHandle) -> Vec<island::MonitorChoice> {
    island::monitor_choices(&app)
}

#[tauri::command]
fn open_url(url: String) {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return;
    }
    platform::open_url(&url);
}

/// "Open terminal" opens the working folder in VS Code when `code` is on PATH,
/// and falls back to the file manager otherwise.
#[tauri::command]
fn open_in_vscode(path: Option<String>) -> bool {
    // No shell anywhere near this. The path is a project folder chosen by
    // whoever is using Claude Code, and a shell would happily read `&`, `^`, `%`
    // or `$` in a folder name as syntax. Finding the launcher ourselves and
    // handing the path over as a separate argument keeps it a path.
    let path = path.filter(|p| !p.is_empty());
    // It arrives in a hook payload: only an existing folder, given by its full
    // path, goes any further. `code` would read `--something` as an option, and
    // xdg-open would launch a file with whatever handles its type.
    if let Some(p) = path.as_deref() {
        let p = std::path::Path::new(p);
        if !(p.is_absolute() && p.is_dir()) {
            return false;
        }
    }
    if let Some(code) = platform::find_on_path("code") {
        let mut cmd = Command::new(code);
        if let Some(p) = path.as_deref() {
            cmd.arg(p);
        }
        if platform::no_console(&mut cmd).spawn().is_ok() {
            return true;
        }
    }
    if let Some(p) = path.as_deref() {
        platform::reveal_folder(p);
    }
    false
}

/// "Open terminal": brings forward the terminal or editor window the session
/// runs in, when it was found (see session_window.rs); otherwise opens the
/// folder in VS Code, as before.
#[tauri::command]
fn open_session(session_id: Option<String>, path: Option<String>) -> bool {
    let Some(owners) = session_id.as_deref().and_then(session_window::lookup) else {
        return open_in_vscode(path);
    };
    let folder = path.as_deref().map(session_window::folder_name).unwrap_or_default().to_string();
    #[cfg(windows)]
    {
        if platform::focus_session_window(&owners, &folder) {
            return true;
        }
        open_in_vscode(path)
    }
    // Linux asks the display server, KWin or the terminal, which can take a
    // moment: never on the UI thread a sync command runs on. VS Code still
    // opens when none of them could bring the window forward.
    #[cfg(target_os = "linux")]
    {
        std::thread::spawn(move || {
            if !platform::focus_session_window(&owners, &folder) {
                open_in_vscode(path);
            }
        });
        true
    }
}

/// The Claude Desktop pill's target: the Claude app (Windows only — it has no
/// Linux build).
#[tauri::command]
fn open_claude_desktop() -> bool {
    platform::open_claude_desktop()
}

/// The file behind a live diff, if it may be handed to the editor: an existing
/// regular file given by its full path. Anything else — a relative path, a
/// folder, a path `code` could read as an option — goes no further.
fn diff_file(path: &str) -> Option<&std::path::Path> {
    let p = std::path::Path::new(path);
    (p.is_absolute() && p.is_file()).then_some(p)
}

/// The diff card's ↗: opens the edited file in VS Code when `code` is on PATH,
/// otherwise shows its folder. The file itself is never opened by its type —
/// xdg-open or Explorer would run a script that Claude just wrote.
#[tauri::command]
fn open_file_in_vscode(path: String) -> bool {
    let Some(file) = diff_file(&path) else { return false };
    if let Some(code) = platform::find_on_path("code") {
        let mut cmd = Command::new(code);
        cmd.arg(file);
        if platform::no_console(&mut cmd).spawn().is_ok() {
            return true;
        }
    }
    if let Some(folder) = file.parent().filter(|d| d.is_dir()) {
        platform::reveal_folder(&folder.to_string_lossy());
    }
    false
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Tray → Pause. Paused means paused: the pollers stop talking to the network,
/// not just the island stopping showing things.
#[tauri::command]
fn set_paused(paused: bool) {
    integrations::set_paused(paused);
}

// ── Claude Code hooks ─────────────────────────────────────────────────────────

#[tauri::command]
fn hooks_status() -> HookStatus {
    hooks::status()
}

/// Pill ID → whether that agent's hooks reach Coucou. Read-only.
#[tauri::command]
fn agent_hooks_status() -> std::collections::HashMap<String, bool> {
    agent_hooks::status()
}

/// Returns the diff the user has to look at before anything is written.
#[tauri::command]
fn hooks_preview(install: bool) -> Result<HookPreview, String> {
    hooks::preview(install)
}

/// Only ever called from an explicit click in the settings window.
#[tauri::command]
fn hooks_apply(
    app: AppHandle,
    shared: State<Shared>,
    install: bool,
    fingerprint: String,
) -> Result<String, String> {
    // The fingerprint comes from the preview the user actually looked at, so a
    // settings.json that changed in between is refused rather than overwritten.
    let backup = hooks::write(install, &fingerprint)?;
    let updated = {
        let mut current = shared.settings.lock().unwrap();
        current.hooks_installed = install;
        if let Err(err) = settings::save(&current) {
            log::line(format!("could not save settings: {err}"));
        }
        current.clone()
    };
    let _ = app.emit("settings-changed", updated);
    Ok(backup)
}

// ── Other agents' hooks and plugins ──────────────────────────────────────────

#[tauri::command]
fn agent_hooks_list() -> Vec<agents::AgentStatus> {
    agents::list()
}

/// The diff the user has to look at before anything is written.
#[tauri::command]
fn agent_hooks_preview(agent: String, install: bool) -> Result<config_file::Plan, String> {
    agents::preview(&agent, install)
}

/// Only ever called from an explicit click in the settings window, with the
/// fingerprint of the preview the user looked at.
#[tauri::command]
fn agent_hooks_apply(agent: String, install: bool, fingerprint: String) -> Result<String, String> {
    let backups = agents::apply(&agent, install, &fingerprint)?;
    let done = if install { "installed" } else { "removed" };
    log::line(format!("agent hooks {done} for {agent}"));
    Ok(backups)
}

// ── Plan usage ────────────────────────────────────────────────────────────────

/// The diff of putting the plan usage relay into (or taking it out of) the
/// status line, before anything is written.
#[tauri::command]
fn status_line_preview(install: bool) -> Result<HookPreview, String> {
    hooks::status_line_preview(install)
}

/// Only ever called from an explicit click in the settings window.
#[tauri::command]
fn status_line_apply(
    app: AppHandle,
    shared: State<Shared>,
    install: bool,
    fingerprint: String,
) -> Result<String, String> {
    let backup = hooks::status_line_write(install, &fingerprint)?;
    let updated = {
        let mut current = shared.settings.lock().unwrap();
        current.plan_relay_installed = install;
        // As on the Mac: taking the relay out turns the pill off with it.
        if !install {
            current.show_plan_in_notch = false;
        }
        if let Err(err) = settings::save(&current) {
            log::line(format!("could not save settings: {err}"));
        }
        current.clone()
    };
    let _ = app.emit("settings-changed", updated);
    Ok(backup)
}

/// Codex plan usage, asked of the Codex CLI (`codex app-server`) when its pill
/// shows. Off the main thread: it can take a few seconds.
#[tauri::command]
async fn codex_plan_usage() -> Option<serde_json::Value> {
    tauri::async_runtime::spawn_blocking(codex_plan::read).await.ok().flatten()
}

#[tauri::command]
fn approval_decision(app: AppHandle, request_id: String, decision: String) {
    recap::record_decision(&app, &request_id, &decision);
    pipe::answer(&app, &request_id, &decision);
}

/// An option picked on the island for a question Claude Code asked.
#[tauri::command]
fn approval_answer(
    app: AppHandle,
    request_id: String,
    answers: std::collections::HashMap<String, serde_json::Value>,
) {
    // An answered question is not an Allow / Deny: nothing for the recap.
    recap::forget_request(&app, &request_id);
    pipe::answer_question(&app, &request_id, &answers);
}

/// The island has the card on screen, so the long wait for a human may begin.
/// Until this arrives the relay only waits a few hundred milliseconds, which is
/// what stops a paused or unresponsive island from freezing Claude Code.
#[tauri::command]
fn approval_ack(app: AppHandle, request_id: String) {
    pipe::acknowledge(&app, &request_id);
}

/// Nobody can act on this request — the island is paused, or another card is
/// already up. Claude Code falls back to asking in the terminal immediately.
#[tauri::command]
fn approval_decline(app: AppHandle, request_id: String) {
    recap::forget_request(&app, &request_id);
    pipe::decline(&app, &request_id);
}

// ── Chat, files and secrets ───────────────────────────────────────────────────

/// One chat turn with the provider picked in the chat view. API keys and any
/// file bytes stay on the Rust side.
#[tauri::command]
async fn chat_send(
    app: AppHandle,
    shared: State<'_, Shared>,
    chat: State<'_, Chat>,
    query: String,
    context: Option<ChatContext>,
) -> Result<ChatReply, String> {
    let settings = shared.settings.lock().unwrap().clone();
    chat::send(&app, &chat, &settings, query, context).await
}

/// Opens the provider's official CLI so the user can switch its signed-in account.
#[tauri::command]
fn github_auth_accounts() -> integrations::GitHubAuthAccounts {
    integrations::github_auth_accounts()
}

fn valid_github_login(login: &str) -> bool {
    !login.is_empty() && login.len() <= 39
        && login.bytes().all(|ch| ch.is_ascii_alphanumeric() || ch == b'-')
        && !login.starts_with('-') && !login.ends_with('-')
}

fn github_auth_cli_args(provider: &str, account: Option<&str>) -> Result<(&'static str, Vec<String>), String> {
    let (action, args): (&str, Vec<&str>) = match provider {
        "github" | "github_add" => ("add", vec!["auth", "login", "--hostname", "github.com"]),
        "github_switch" => {
            let login = account.ok_or_else(|| "Choose the GitHub account to switch to.".to_string())?;
            if !valid_github_login(login) { return Err("The selected GitHub username is invalid. Refresh the account list and try again.".into()); }
            ("switch", vec!["auth", "switch", "--hostname", "github.com", "--user", login])
        }
        "github_logout" => {
            let login = account.ok_or_else(|| "Choose the GitHub account to disconnect.".to_string())?;
            if !valid_github_login(login) { return Err("The selected GitHub username is invalid. Refresh the account list and try again.".into()); }
            ("logout", vec!["auth", "logout", "--hostname", "github.com", "--user", login])
        }
        _ => return Err("Unknown GitHub account action.".into()),
    };
    Ok((action, args.into_iter().map(str::to_owned).collect()))
}

#[cfg(windows)]
const GITHUB_AUTH_CREATE_NEW_CONSOLE: u32 = 0x0000_0010;

#[cfg(windows)]
fn github_auth_process(gh: &std::path::Path, wt: Option<&std::path::Path>, args: &[String]) -> Command {
    use std::os::windows::process::CommandExt;
    if let Some(wt) = wt {
        let mut command = Command::new(wt);
        command.args(["--wait", "-w", "new", "new-tab", "--title", "Mochi GitHub"]);
        command.arg(gh).args(args);
        command
    } else {
        let mut command = Command::new(gh);
        command.args(args).creation_flags(GITHUB_AUTH_CREATE_NEW_CONSOLE);
        command
    }
}

#[cfg(windows)]
fn launch_github_auth(app: AppHandle, provider: &str, requested_account: Option<&str>) -> Result<(), String> {
    let (action, args) = github_auth_cli_args(provider, requested_account)?;
    let auth = integrations::github_auth_accounts();
    if !auth.cli_installed { return Err("GitHub CLI (gh) was not found on PATH. Install GitHub CLI, then restart Mochi.".into()); }
    if action != "add" && !auth.accounts.iter().any(|account| Some(account.login.as_str()) == requested_account) {
        return Err("That GitHub account is no longer authenticated. Refresh the account list and try again.".into());
    }
    let gh = platform::find_on_path("gh").ok_or_else(|| "GitHub CLI (gh) was not found on PATH. Install GitHub CLI, then restart Mochi.".to_string())?;
    let wt = platform::find_on_path("wt");
    // --wait keeps a process handle until the user closes the terminal tab,
    // allowing Mochi to refresh auth state after an interactive CLI session.
    let mut command = github_auth_process(&gh, wt.as_deref(), &args);
    command.env_remove("GH_TOKEN").env_remove("GITHUB_TOKEN");
    for key in ["GEMINI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY"] {
        command.env_remove(key);
    }
    let mut child = command.spawn().map_err(|error| format!("Could not launch GitHub CLI in a visible terminal: {error}"))?;
    std::thread::spawn(move || {
        let status = child.wait();
        let (mut success, exit_code) = match status { Ok(status) => (status.success(), status.code()), Err(_) => (false, None) };
        let mut error = None;
        if success && action == "logout" {
            if let Err(credential_error) = secrets::clear("github-token") {
                error = Some(format!("The GitHub CLI disconnected the account, but Mochi could not clear its older saved credential: {credential_error}"));
                success = false;
            }
        }
        if success { integrations::github_token_changed(&app); }
        let _ = app.emit_to(island::WINDOW_LABEL, "github-auth-result", serde_json::json!({
            "action": action, "success": success, "exitCode": exit_code, "error": error
        }));
    });
    Ok(())
}
#[tauri::command]
fn account_auth(app: AppHandle, provider: String, account: Option<String>) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        if matches!(provider.as_str(), "github" | "github_add" | "github_switch" | "github_logout") {
            return launch_github_auth(app, &provider, account.as_deref());
        }
        let binary = match provider.as_str() {
            
            // `&` runs the login flow even when there was no previous account
            // to log out (cmd.exe's `&&` would stop at that first failure).
            "claude_account" => "claude auth logout & claude auth login",
            
            _ => return Err("This account is connected through its own desktop app or browser.".into()),
        };
        let executable = match provider.as_str() {
            
            "claude_account" => "claude",
            
            _ => unreachable!(),
        };
        if platform::find_on_path(executable).is_none() {
            return Err(format!("{executable} is not installed. Install the official CLI before connecting this account."));
        }
        let mut command = Command::new("cmd.exe");
        command.args(["/K", binary]);
        command.creation_flags(0x00000010); // CREATE_NEW_CONSOLE
        for key in ["GEMINI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY"] {
            command.env_remove(key);
        }
        command.spawn().map(|_| ()).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                format!("{} is not installed. Install the official CLI first.", binary)
            } else { format!("Could not open {binary}: {e}") }
        })
    }
    #[cfg(not(windows))]
    { let _ = (app, provider, account); Err("Account sign-in from Mochi is currently supported on Windows only.".into()) }
}

/// Settings → Local models → Connect: does the server answer, and with which models?
#[tauri::command]
async fn local_connect(provider: String, url: String) -> Result<local_chat::Connected, String> {
    local_chat::connect(&provider, &url).await
}

/// Stores the custom server's key for the address typed next to it; it is only
/// ever sent to that address.
#[tauri::command]
fn local_set_key(url: String, key: String) -> Result<(), String> {
    local_chat::set_custom_key(&url, &key)
}

#[tauri::command]
fn chat_reset(chat: State<Chat>) {
    chat.reset();
}

/// Copies a dropped file into the inbox and reports its name back.
#[tauri::command]
fn ingest_file(path: String) -> Result<DroppedFile, String> {
    files::ingest(&path)
}

/// The island may only ask whether a key exists — never read it.
#[tauri::command]
fn secret_present(key: String) -> bool {
    if key == "github-token" {
        return integrations::github_token().is_some();
    }
    secrets::present(&key)
}

#[tauri::command]
fn secret_set(app: AppHandle, key: String, value: String) -> Result<(), String> {
    // Bound to its server's address: only local_set_key may store it.
    if key == local_chat::CUSTOM_KEY {
        return Err("use local_set_key".into());
    }
    let before = (key == "github-token").then(|| secrets::get(&key));
    secrets::set(&key, &value)?;
    if let Some(before) = before {
        if secrets::get(&key) != before {
            integrations::github_token_changed(&app);
        }
    }
    Ok(())
}

#[tauri::command]
fn secret_clear(app: AppHandle, key: String) -> Result<(), String> {
    let had = key == "github-token" && secrets::present(&key);
    secrets::clear(&key)?;
    if had {
        integrations::github_token_changed(&app);
    }
    Ok(())
}

/// Opens the configured n8n instance — the URL lives in the Credential Manager.
#[tauri::command]
fn open_n8n() {
    if let Some(url) = secrets::get("n8n-url") {
        open_url(url);
    }
}

/// Refresh buttons in the integration cards.
#[tauri::command]
async fn refresh_integration(app: AppHandle, id: String) {
    integrations::poll_once(app, &id).await;
}

/// The GitHub card was opened: refetch its `section` ("pulse" or "activity")
/// if it is stale. The pollers still decline while the pill is off or paused.
#[tauri::command]
fn github_refresh(section: String) {
    integrations::github_refresh_if_stale(&section);
}

#[tauri::command]
async fn github_refresh_now(app: AppHandle) {
    integrations::github_refresh_now(&app).await;
}

/// Lets the island write to the same log as the Rust side.
#[tauri::command]
fn log_line(message: String) {
    log::line(format!("ui  {message}"));
}

// ── Global shortcuts ──────────────────────────────────────────────────────────

/// How each global shortcut went: registered, taken by another app, and so on.
#[tauri::command]
fn shortcuts_status(app: AppHandle) -> shortcuts::Report {
    shortcuts::status(&app)
}

/// Settings is recording a new combination: let go of ours meanwhile, so the
/// keys reach the recorder instead of running an action. `false` takes them back.
#[tauri::command]
fn shortcuts_suspend(app: AppHandle, shared: State<Shared>, suspended: bool) {
    if suspended {
        shortcuts::suspend(&app);
    } else {
        let stored = shared.settings.lock().unwrap().shortcuts.clone();
        shortcuts::apply(&app, &stored);
        // Taking the stored shortcuts back must not cost us the visibility one.
        visibility::register(&app);
    }
}

// ── Settings window ───────────────────────────────────────────────────────────

/// WebView2 allows exactly one browser environment per app, and its options are
/// fixed by whichever webview is created first. Every window must therefore ask
/// for the *same* arguments as the island (see `additionalBrowserArgs` in
/// tauri.conf.json) — a mismatch makes the second window come up blank, with no
/// error anywhere.
pub(crate) const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";

/// In a dev build the pages are served by Vite, so the second window needs the
/// absolute dev URL; a bundled build resolves it inside the app bundle.
fn settings_page_url(app: &AppHandle) -> WebviewUrl {
    #[cfg(dev)]
    if let Some(mut base) = app.config().build.dev_url.clone() {
        base.set_path("/settings.html");
        return WebviewUrl::External(base);
    }
    let _ = app;
    WebviewUrl::App("settings.html".into())
}

/// The settings window is created hidden at launch and only ever shown and
/// hidden afterwards. A WebView2 window created later — on the main thread or
/// not — silently comes up blank in this app, so the window that works is the
/// one that exists before the island's webview does.
fn create_settings_window(app: &AppHandle) {
    let url = settings_page_url(app);
    match WebviewWindowBuilder::new(app, "settings", url)
        .additional_browser_args(BROWSER_ARGS)
        .title(i18n::t("Settings — Coucou"))
        .inner_size(560.0, 680.0)
        .min_inner_size(460.0, 480.0)
        .resizable(true)
        .visible(false)
        .center()
        .build()
    {
        Ok(win) => {
            // Closing it must only hide it, or it could never be reopened.
            let hidden = win.clone();
            win.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = hidden.hide();
                }
            });
        }
        Err(err) => log::line(format!("settings window failed: {err}")),
    }
}

pub fn show_settings_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window("settings") else {
        log::line("settings window missing");
        return;
    };
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
}

#[tauri::command]
fn open_settings_window(app: AppHandle) {
    show_settings_window(&app);
}

pub fn run() {
    platform::prepare_environment();
    let loaded = settings::load();
    i18n::set_picked(&loaded.language);
    let gate = Arc::new(PollGate::new());

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // `coucou --shortcut <action>`: what a desktop's own keyboard
            // settings run where we can't listen for keys ourselves (Wayland).
            match shortcuts::from_args(&argv) {
                Some(action) => shortcuts::dispatch(app, action),
                None => {
                    let _ = app.emit_to(island::WINDOW_LABEL, "tray", "open".to_string());
                }
            }
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None));
    // Where no global shortcut can work, the plugin isn't even started.
    if platform::global_shortcuts_blocked().is_none() {
        builder = builder.plugin(shortcuts::plugin());
    }

    builder
        .manage(Shared {
            settings: Mutex::new(loaded.clone()),
            gate: gate.clone(),
        })
        .manage(Pending::default())
        .manage(Chat::default())
        .manage(shortcuts::Registry::default())
        .manage(recap::load())
        .invoke_handler(tauri::generate_handler![
            boot,
            save_settings,
            set_system_languages,
            set_collapsed,
            set_island_rect,
            set_extra_rect,
            focus_window,
            reposition,
            list_monitors,
            open_url,
            open_in_vscode,
            open_session,
            open_claude_desktop,
            open_file_in_vscode,
            quit_app,
            hooks_status,
            agent_hooks_status,
            hooks_preview,
            hooks_apply,
            agent_hooks_list,
            agent_hooks_preview,
            agent_hooks_apply,
            status_line_preview,
            status_line_apply,
            codex_plan_usage,
            approval_decision,
            approval_answer,
            approval_ack,
            approval_decline,
            log_line,
            chat_send,
            github_auth_accounts,
            account_auth,
            local_connect,
            local_set_key,
            chat_reset,
            ingest_file,
            secret_present,
            secret_set,
            secret_clear,
            refresh_integration,
            github_refresh,
            github_refresh_now,
            open_n8n,
                        open_settings_window,
            
            set_paused,
            shortcuts_status,
            shortcuts_suspend,
            voice::voice_transcribe,
            recap::recap_history,
            recap::recap_prefs,
            recap::recap_set_enabled,
            recap::recap_set_hide_projects,
            recap::recap_mark_shown,
            recap::recap_clear,
            recap::recap_save_png,
            recap::recap_reveal_saved,
            desktop::desktop_mochi_info,
            desktop::desktop_mochi_pick_up,
            desktop::desktop_mochi_carry,
            desktop::desktop_mochi_carry_end,
            desktop::desktop_mochi_drag_begin,
            desktop::desktop_mochi_drag_move,
            desktop::desktop_mochi_drag_end,
            desktop::desktop_mochi_fly_out,
            desktop::desktop_mochi_fly_home,
            desktop::desktop_mochi_set_asleep,
            sounds::custom_sounds,
            sounds::custom_sound,
            sounds::reveal_sounds_folder,
            sounds::reload_sounds,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            tray::build(&handle)?;
            // Before the island: see create_settings_window.
            create_settings_window(&handle);
                        
            // Same rule for Mochi's desktop window.
            desktop::setup(&handle);

            if let Some(win) = island::window(&handle) {
                // Where Tauri takes the drop itself (Linux), its paths are the
                // ones ingest_file may copy (files.rs).
                win.on_window_event(|event| {
                    if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                        files::allow_dropped(paths.iter().map(|p| p.to_string_lossy().to_string()));
                    }
                });
                platform::make_non_activating(&win);
                #[cfg(windows)]
                webview_drop::install(&handle);
                island::apply_geometry(&handle, &loaded.screen, false);
                let _ = win.show();
            }
            // At boot the desktop can still be settling (taskbar, display layout),
            // and a window shown that early may be left hidden, minimised or sized
            // for a display that then changed. Show it again once things have
            // calmed down, unless the user has hidden Mochi themselves meanwhile.
            let settle = handle.clone();
            std::thread::spawn(move || {
                for wait_ms in [800u64, 1700, 3500] {
                    std::thread::sleep(std::time::Duration::from_millis(wait_ms));
                    if visibility::user_hid() {
                        return;
                    }
                    let app = settle.clone();
                    let _ = settle.run_on_main_thread(move || {
                        if let Some(shared) = app.try_state::<Shared>() {
                            let pref = shared.settings.lock().unwrap().screen.clone();
                            let collapsed = shared.gate.collapsed.load(Ordering::Relaxed);
                            island::apply_geometry(&app, &pref, collapsed);
                        }
                        if let Some(win) = island::window(&app) {
                            let _ = win.unminimize();
                            let _ = win.show();
                            let _ = win.set_always_on_top(true);
                        }
                    });
                }
            });
            gate.collapsed.store(false, Ordering::Relaxed);
            // Nothing drawn yet, so nothing takes the mouse until the page
            // reports the island's shape.
            if !platform::CURSOR_POLL {
                island::refresh_click_through(&handle, &gate);
            }
            gate.set_active(true);
            island::spawn_cursor_poll(handle.clone(), gate.clone());

            log::line(format!("--- Coucou {} started ---", env!("CARGO_PKG_VERSION")));
            hooks::ensure_hook_exe(&handle);
            pipe::start(handle.clone());
            integrations::start(handle.clone());
            shortcuts::apply(&handle, &loaded.shortcuts);
            // After the other shortcuts, so applying them can't undo ours.
            visibility::register(&handle);

            // Launch with the computer, every time: no console window, the island
            // is the whole UI. enable() is idempotent and rewrites the entry, so
            // it also follows the exe if it was moved.
            if let Err(err) = handle.autolaunch().enable() {
                log::line(format!("autostart: {err}"));
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Coucou");
}

#[cfg(test)]
mod tests {
    use super::{diff_file, github_auth_cli_args};
    #[cfg(windows)]
    use super::{github_auth_process, GITHUB_AUTH_CREATE_NEW_CONSOLE};

    #[test]
    fn github_account_actions_use_explicit_safe_cli_arguments() {
        assert_eq!(github_auth_cli_args("github_add", None).unwrap(), ("add", vec!["auth", "login", "--hostname", "github.com"].into_iter().map(str::to_owned).collect()));
        assert_eq!(github_auth_cli_args("github_switch", Some("octo-user")).unwrap(), ("switch", vec!["auth", "switch", "--hostname", "github.com", "--user", "octo-user"].into_iter().map(str::to_owned).collect()));
        assert_eq!(github_auth_cli_args("github_logout", Some("octo-user")).unwrap(), ("logout", vec!["auth", "logout", "--hostname", "github.com", "--user", "octo-user"].into_iter().map(str::to_owned).collect()));
        assert!(github_auth_cli_args("github_switch", None).is_err());
        assert!(github_auth_cli_args("github_logout", Some("octo & whoami")).is_err());
        assert!(github_auth_cli_args("claude_account", None).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn github_auth_uses_a_visible_interactive_windows_console() {
        assert_eq!(GITHUB_AUTH_CREATE_NEW_CONSOLE, 0x10);
        let (_, args) = github_auth_cli_args("github_add", None).unwrap();
        let gh = std::path::Path::new(r"C:\Program Files\GitHub CLI\gh.exe");
        let wt = std::path::Path::new(r"C:\Program Files\Windows Terminal\wt.exe");
        let terminal = github_auth_process(gh, Some(wt), &args);
        let terminal_args: Vec<String> = terminal.get_args().map(|arg| arg.to_string_lossy().into_owned()).collect();
        assert_eq!(terminal.get_program(), wt.as_os_str());
        assert_eq!(&terminal_args[..6], ["--wait", "-w", "new", "new-tab", "--title", "Mochi GitHub"]);
        assert_eq!(terminal_args[6], gh.to_string_lossy());
        assert_eq!(&terminal_args[7..], args.iter().map(String::as_str).collect::<Vec<_>>());

        let fallback = github_auth_process(gh, None, &args);
        let fallback_args: Vec<String> = fallback.get_args().map(|arg| arg.to_string_lossy().into_owned()).collect();
        assert_eq!(fallback.get_program(), gh.as_os_str());
        assert_eq!(fallback_args, args);
    }

    #[test]
    fn only_an_existing_file_by_its_full_path_reaches_the_editor() {
        let dir = std::env::temp_dir().join(format!("coucou-diff-file-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("edited.ts");
        std::fs::write(&file, "x").unwrap();

        assert!(diff_file(&file.to_string_lossy()).is_some());
        // A folder, a missing file, a relative path or an option never pass.
        assert!(diff_file(&dir.to_string_lossy()).is_none());
        assert!(diff_file(&dir.join("missing.ts").to_string_lossy()).is_none());
        assert!(diff_file("edited.ts").is_none());
        assert!(diff_file("--help").is_none());
        assert!(diff_file("").is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
