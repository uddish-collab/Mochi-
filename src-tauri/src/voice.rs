// Push-to-talk: the global shortcut, and turning a recording into text.
// Author: Uddish.
//
// The page records, converts the recording to a WAV and calls `voice_transcribe`;
// Gemini returns what was said. The API key stays on this side, never in the page.

use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// Edit this one line to change the push-to-talk key.
pub const PUSH_TO_TALK: &str = "Ctrl+Shift+Space";

/// The Gemini model that turns speech into text. Edit if Google retires it.
const TRANSCRIBE_MODEL: &str = "gemini-2.5-flash";

/// Names the Google / Gemini API key may be stored under in the keychain. The
/// first one found wins. GEMINI_API_KEY in the environment is tried before them.
const KEY_NAMES: [&str; 6] = [
    "google",
    "gemini",
    "google-api-key",
    "gemini-api-key",
    "google-key",
    "gemini-key",
];

/// A recording this large (as base64) is refused: about 9 MB of audio, far more
/// than the page's 60 seconds, and under Gemini's inline-data limit.
const MAX_AUDIO_BASE64: usize = 12_000_000;

/// Registers push-to-talk. Safe to call again: it drops its own registration first.
pub fn register(app: &AppHandle) {
    if crate::platform::global_shortcuts_blocked().is_some() {
        return;
    }
    let gs = app.global_shortcut();
    let _ = gs.unregister(PUSH_TO_TALK);
    let result = gs.on_shortcut(PUSH_TO_TALK, |app, _shortcut, event| {
        if event.state() == ShortcutState::Pressed {
            let _ = app.emit_to(crate::island::WINDOW_LABEL, "voice-toggle", ());
        }
    });
    if let Err(err) = result {
        crate::log::line(format!("push-to-talk shortcut failed: {err}"));
    }
}

fn api_key() -> Option<String> {
    if let Ok(key) = std::env::var("GEMINI_API_KEY") {
        if !key.trim().is_empty() {
            return Some(key.trim().to_string());
        }
    }
    KEY_NAMES
        .iter()
        .filter_map(|name| crate::secrets::get(name))
        .map(|key| key.trim().to_string())
        .find(|key| !key.is_empty())
}

/// The text Gemini put in its first answer.
fn answer_text(reply: &Value) -> String {
    reply["candidates"][0]["content"]["parts"]
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| part["text"].as_str())
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default()
        .trim()
        .to_string()
}

/// What was said in a recording: `audio_base64` is the audio file, base64 only
/// (no `data:` prefix), and `mime_type` its type, "audio/wav" from the page.
#[tauri::command]
pub async fn voice_transcribe(audio_base64: String, mime_type: String) -> Result<String, String> {
    if audio_base64.is_empty() {
        return Err("there is no audio".into());
    }
    if audio_base64.len() > MAX_AUDIO_BASE64 {
        return Err("the recording is too long".into());
    }
    if !mime_type.starts_with("audio/") {
        return Err("that is not audio".into());
    }
    let key = api_key().ok_or_else(|| {
        "no Gemini API key found: save one for Google in Settings, or set GEMINI_API_KEY".to_string()
    })?;

    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{TRANSCRIBE_MODEL}:generateContent"
    );
    let body = json!({
        "contents": [{
            "parts": [
                { "text": "Transcribe this audio recording exactly as spoken. Reply with only the transcript: no quotes, no commentary. If there is no speech, reply with nothing." },
                { "inline_data": { "mime_type": mime_type, "data": audio_base64 } }
            ]
        }],
        "generationConfig": { "temperature": 0 }
    });

    let response = reqwest::Client::new()
        .post(&url)
        .header("x-goog-api-key", key)
        .timeout(Duration::from_secs(60))
        .json(&body)
        .send()
        .await
        .map_err(|err| format!("could not reach Gemini: {err}"))?;
    let status = response.status();
    let reply: Value = response
        .json()
        .await
        .map_err(|err| format!("Gemini's answer could not be read: {err}"))?;
    if !status.is_success() {
        let message = reply["error"]["message"].as_str().unwrap_or("no details");
        return Err(format!("Gemini refused ({status}): {message}"));
    }
    Ok(answer_text(&reply))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_text_of_the_first_answer_is_taken() {
        let reply = json!({ "candidates": [{ "content": { "parts": [{ "text": " hello " }, { "text": "there" }] } }] });
        assert_eq!(answer_text(&reply), "hello there");
    }

    #[test]
    fn an_answer_with_no_text_is_empty() {
        assert_eq!(answer_text(&json!({})), "");
        assert_eq!(answer_text(&json!({ "candidates": [{ "content": { "parts": [] } }] })), "");
    }
}