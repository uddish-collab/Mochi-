// Mochi's voice assistant, push-to-talk. Author: Uddish.
//
// Press the shortcut (see src-tauri/src/voice.rs) and talk; press it again to
// stop. The recording is turned into a 16 kHz WAV, sent to Rust to be turned into
// text (Gemini), the text goes to the chat through Bridge.chatSend, and the
// answer is read aloud with speechSynthesis.
//
// Pressing the shortcut while Mochi is talking cuts him off.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Bridge } from "./bridge";
import { Sound } from "./sound";

// ── Settings ─────────────────────────────────────────────────────────────────

/// The recording stops by itself after this long.
const MAX_RECORDING_MS = 60_000;
/// Anything shorter is a mis-press, not a request.
const MIN_RECORDING_MS = 500;
/// Gemini hears 16 kHz mono; sending more only makes the upload bigger.
const TARGET_RATE = 16_000;
/// Chrome cuts long utterances off: speak in pieces of about this many characters.
const SPEECH_CHUNK = 220;

const log = (message: string) => void Bridge.log(`voice: ${message}`);

export type VoiceState = "idle" | "recording" | "thinking" | "speaking";

// ── Text helpers ─────────────────────────────────────────────────────────────

/// The text of whatever chatSend returned: a string, or an object holding one.
function replyText(reply: unknown): string {
  if (typeof reply === "string") return reply;
  if (reply && typeof reply === "object") {
    const fields = reply as Record<string, unknown>;
    for (const key of ["text", "reply", "answer", "content", "message"]) {
      const value = fields[key];
      if (typeof value === "string") return value;
    }
  }
  return "";
}

/// Markdown in, plain speakable text out: no *, _, # or ``` for the voice to
/// read out. Code blocks are left out entirely, since code is no good to hear.
export function stripMarkdown(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[-+*]\s+/gm, "")
    .replace(/\|/g, " ")
    .replace(/[*_#`~]/g, "")
    .replace(/([^.!?:;\s])[ \t]*\n+\s*/g, "$1. ")
    .replace(/\s+/g, " ")
    .trim();
}

/// Cuts `text` at sentence ends into pieces of at most about `max` characters.
function chunk(text: string, max: number): string[] {
  const sentences = text.match(/[^.!?]+[.!?]*\s*/g) ?? [text];
  const pieces: string[] = [];
  let current = "";
  const flush = () => {
    if (current.trim()) pieces.push(current.trim());
    current = "";
  };
  for (let sentence of sentences) {
    // One endless sentence: break it at spaces.
    while (sentence.length > max * 1.5) {
      const cut = sentence.lastIndexOf(" ", max);
      const at = cut > 0 ? cut : max;
      if (current) flush();
      pieces.push(sentence.slice(0, at).trim());
      sentence = sentence.slice(at);
    }
    if (current && (current + sentence).length > max) flush();
    current += sentence;
  }
  flush();
  return pieces;
}

/// Reads `text` aloud and resolves when it is done (or was cut off).
function speak(text: string, lang: string): Promise<void> {
  const synth = window.speechSynthesis;
  synth.cancel();
  const pieces = chunk(text, SPEECH_CHUNK);
  return new Promise((resolve) => {
    let next = 0;
    const sayNext = () => {
      if (next >= pieces.length) {
        resolve();
        return;
      }
      const utterance = new SpeechSynthesisUtterance(pieces[next++]);
      utterance.lang = lang;
      utterance.onend = sayNext;
      utterance.onerror = () => resolve();
      synth.speak(utterance);
    };
    sayNext();
  });
}

// ── Audio helpers ────────────────────────────────────────────────────────────

/// 16-bit mono PCM in a WAV container.
function encodeWav(samples: Float32Array, rate: number): Blob {
  const bytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + bytes);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + bytes, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true); // size of this block
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // bytes per second
  view.setUint16(32, 2, true); // bytes per frame
  view.setUint16(34, 16, true); // bits per sample
  text(36, "data");
  view.setUint32(40, bytes, true);
  let offset = 44;
  for (const sample of samples) {
    const clipped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/// What MediaRecorder produced (WebM/Opus in WebView2) as a 16 kHz mono WAV.
async function toWav16k(recording: Blob): Promise<Blob> {
  const Context =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const context = new Context();
  try {
    const decoded = await context.decodeAudioData(await recording.arrayBuffer());
    const frames = Math.max(1, Math.ceil(decoded.duration * TARGET_RATE));
    // Rendering into a 1-channel, 16 kHz context mixes down and resamples.
    const offline = new OfflineAudioContext(1, frames, TARGET_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return encodeWav(rendered.getChannelData(0), TARGET_RATE);
  } finally {
    void context.close();
  }
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("could not read the recording"));
    reader.readAsDataURL(blob);
  });
}

function recorderType(): string | undefined {
  return ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"].find((type) =>
    MediaRecorder.isTypeSupported(type),
  );
}

// ── The assistant ────────────────────────────────────────────────────────────

export class VoiceAssistant {
  /// Told at every change, for an indicator or an emote.
  onState: ((state: VoiceState) => void) | null = null;

  private current: VoiceState = "idle";
  private opening = false;
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private limitTimer: number | null = null;
  private unlisten: (() => void) | null = null;
  private started = false;

  constructor(private readonly lang: string = navigator.language || "en-US") {}

  get state(): VoiceState {
    return this.current;
  }

  /// Whether this webview can record and speak at all.
  get supported(): boolean {
    return (
      !!navigator.mediaDevices?.getUserMedia &&
      typeof MediaRecorder !== "undefined" &&
      "speechSynthesis" in window
    );
  }

  /// Starts answering the push-to-talk shortcut. Returns false when it can't.
  start(): boolean {
    if (this.started) return true;
    if (!this.supported) {
      log("recording or speech is not available in this webview");
      return false;
    }
    this.started = true;
    listen("voice-toggle", () => void this.toggle())
      .then((unlisten) => {
        if (this.started) this.unlisten = unlisten;
        else unlisten();
      })
      .catch((err) => log(`could not listen for the shortcut: ${String(err)}`));
    return true;
  }

  /// Stops answering the shortcut and drops whatever is going on.
  stop() {
    this.started = false;
    this.unlisten?.();
    this.unlisten = null;
    this.discardRecording();
    window.speechSynthesis?.cancel();
    this.setState("idle");
  }

  /// What one press of the shortcut does.
  async toggle() {
    switch (this.current) {
      case "idle":
        await this.beginRecording();
        break;
      case "recording":
        this.finishRecording();
        break;
      case "speaking":
        // Cuts Mochi off; the answer's own code then returns to idle.
        window.speechSynthesis.cancel();
        break;
      case "thinking":
        break;
    }
  }

  private setState(state: VoiceState) {
    if (state === this.current) return;
    this.current = state;
    this.onState?.(state);
  }

  private async beginRecording() {
    if (this.opening) return;
    this.opening = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      const type = recorderType();
      const recorder = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream);
      this.stream = stream;
      this.recorder = recorder;
      this.chunks = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) this.chunks.push(event.data);
      };
      recorder.onstop = () => {
        const held = Date.now() - this.startedAt;
        const recording = new Blob(this.chunks, { type: recorder.mimeType });
        this.releaseStream();
        void this.process(recording, held);
      };
      this.startedAt = Date.now();
      recorder.start();
      this.limitTimer = window.setTimeout(() => this.finishRecording(), MAX_RECORDING_MS);
      Sound.play("blip");
      this.setState("recording");
    } catch (err) {
      log(`could not start recording: ${String(err)}`);
      Sound.play("error");
      this.releaseStream();
    } finally {
      this.opening = false;
    }
  }

  private finishRecording() {
    if (this.limitTimer != null) window.clearTimeout(this.limitTimer);
    this.limitTimer = null;
    const recorder = this.recorder;
    if (!recorder || recorder.state !== "recording") return;
    Sound.play("pop");
    this.setState("thinking");
    recorder.stop();
  }

  private discardRecording() {
    if (this.limitTimer != null) window.clearTimeout(this.limitTimer);
    this.limitTimer = null;
    const recorder = this.recorder;
    if (recorder) {
      recorder.onstop = null;
      recorder.ondataavailable = null;
      if (recorder.state !== "inactive") recorder.stop();
    }
    this.recorder = null;
    this.chunks = [];
    this.releaseStream();
  }

  private releaseStream() {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.recorder = null;
  }

  private async process(recording: Blob, heldMs: number) {
    try {
      if (heldMs < MIN_RECORDING_MS || recording.size === 0) {
        log("recording too short, ignored");
        return;
      }
      const wav = await toWav16k(recording);
      const heard = await invoke<string>("voice_transcribe", {
        audioBase64: await toBase64(wav),
        mimeType: "audio/wav",
      });
      const request = heard.trim();
      if (!request) {
        await this.say("I didn't catch that.");
        return;
      }
      const reply = await Bridge.chatSend(request, null);
      const spoken = stripMarkdown(replyText(reply));
      if (spoken) await this.say(spoken);
      else log("the chat answered with no text");
    } catch (err) {
      log(`failed: ${String(err)}`);
      Sound.play("error");
    } finally {
      this.setState("idle");
    }
  }

  private async say(text: string) {
    this.setState("speaking");
    await speak(text, this.lang);
  }
}