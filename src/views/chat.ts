// Chat view — DOM port of PromptView / ChatBubble / TypingDotsView /
// ModelPickerView from IslandViewContent.swift.
//
// Answers are rendered as Markdown (markdown.ts). A local model streams its
// answer: Rust sends `chat-delta` events with the text visible so far. The
// model name above the text field opens the picker: provider chips, then the
// models of the chosen provider, asked for only once it is picked.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { renderMarkdown } from "./markdown";
import { Bridge, onEvent, type ChatContext } from "../core/bridge";
import { Sound } from "../core/sound";
import { State, type ChatMessage } from "../core/state";
import type { ViewHost } from "./views";
import { N_, t, tl } from "../i18n/i18n";

const STRINGS = {
  placeholderFirst: N_("Ask me anything…"),
  placeholderNext: N_("Continue…"),
  send: N_("Send"),
};

let nextId = 1;

function accountSetup(provider: string): string {
  switch (provider) {
    case "gemini_account": return "Gemini needs Gemini CLI. Install it with `npm install -g @google/gemini-cli`, run `gemini`, then choose Sign in with Google. To change accounts later, use `/auth` in Gemini CLI.";
    case "claude_account": return "Claude needs Claude Code. Install it with `npm install -g @anthropic-ai/claude-code`, then run `claude auth login` and sign in with your Claude account.";
    case "chatgpt_account":
    case "codex_account": return "ChatGPT and Codex use the official Codex CLI account. Install it with `npm install -g @openai/codex`, then run `codex` and choose Sign in with ChatGPT.";
    default: return "Install the provider's official sign-in app or CLI, then sign in with your account.";
  }
}

function bubble(message: ChatMessage): HTMLElement {
  if (message.role === "user") {
    return h(
      "div",
      { class: "chat-row user" },
      h("div", { class: "bubble", text: message.content }),
    );
  }
  const reply = h("div", { class: "reply" });
  renderMarkdown(reply, message.content);
  return h("div", { class: "chat-row" }, reply);
}

function typingDots(): HTMLElement {
  return h(
    "div",
    { class: "chat-row" },
    h("div", { class: "typing" }, h("i"), h("i"), h("i")),
  );
}

/** The coloured chip showing what the question is about (a dropped file). */
function contextChip(label: string): HTMLElement {
  const chip = h("div", { class: "chip" }, h("i", { class: "chip-dot" }), h("span", { text: label }));
  requestAnimationFrame(() => chip.classList.add("settled"));
  return chip;
}

// ── View ──────────────────────────────────────────────────────────────────────

export function buildPrompt(onHeightChange: () => void): ViewHost {
  const chipRow = h("div", { class: "chip-row" });
  const log = h("div", { class: "chat-log" });
  const input = h("input", { type: "text", class: "chat-input", placeholder: t(STRINGS.placeholderFirst), spellcheck: "false" }) as HTMLInputElement;
  const send = h("button", { class: "send-btn", title: tl(STRINGS.send) }, svg(ICONS.arrowUp, 11));
  const name = h("span", { class: "model-name", text: "Gemini" });
  const switchAccount = h("button", {
  class: "icon-btn",
  title: "Sign in / switch account",
  });
  switchAccount.setAttribute("aria-label", "Sign in / switch account");
  switchAccount.innerHTML = `
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none"
       stroke="currentColor" stroke-width="1.8"
       stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="8" r="3.5"/>
    <path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6"/>
  </svg>`;
  switchAccount.addEventListener("click", async () => {
    const provider = State.settings.chatProvider;
    try { await Bridge.accountAuth(provider); }
    catch (err) {
      State.noteMessage = `${String(err).replace(/^Error:\s*/, "")}\n\n${accountSetup(provider)}`;
      State.view = "note";
      State.notify();
    }
  });
  const row = h("div", { class: "model-row" }, h("span", { class: "model-btn", style: "cursor:default" }, h("i", { class: "model-dot", style: "background:#4285f4" }), name), switchAccount);
  const body = h("div", { class: "chat-body" }, chipRow, log, row, h("div", { class: "chat-bar" }, input, send));
  const el = h("div", { class: "view" }, h("div", { class: "card wash chat-card" }, body));
  (el.querySelector(".card") as HTMLElement).style.setProperty("--wash", "rgba(66,133,244,0.5)");

  let sending = false;
  let renderedCount = -1;
  let live: HTMLElement | null = null;
  void onEvent<string>("chat-delta", (text) => {
    if (!sending || !text) return;
    if (!live) {
      live = h("div", { class: "reply" });
      log.querySelector(".typing")?.parentElement?.remove();
      log.append(h("div", { class: "chat-row" }, live));
    }
    renderMarkdown(live, text);
    log.scrollTop = log.scrollHeight;
  });

  async function submit() {
    const query = input.value.trim();
    if (!query || sending) return;
    input.value = "";
    sending = true;
    Sound.play("send");
    State.chatHistory.push({ id: nextId++, role: "user", content: query });
    State.stateOverride = "thinking";
    State.notify();
    onHeightChange();
    const file = State.droppedFile;
    const context: ChatContext | null = State.chatHistory.length === 1 && file ? { kind: "file", name: file.name, path: file.path } : null;
    try {
      const reply = await Bridge.chatSend(query, context);
      State.chatHistory.push({ id: nextId++, role: "assistant", content: reply.text });
      State.stateOverride = null;
      Sound.play("finish");
    } catch (err) {
      State.stateOverride = null;
      State.noteMessage = `${String(err).replace(/^Error:\s*/, "")}\n\n${accountSetup(State.settings.chatProvider)}`;
      State.view = "note";
      Sound.play("error");
    } finally {
      sending = false;
      live = null;
      renderedCount = -1;
      State.notify();
      onHeightChange();
      input.focus();
    }
  }
  send.addEventListener("click", () => void submit());
  input.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") { e.preventDefault(); void submit(); }
    e.stopPropagation();
  });

  return {
    el,
    sync() {
      const labels: Record<string, string> = {
        gemini_account: "Gemini", claude_account: "Claude",
        chatgpt_account: "ChatGPT", codex_account: "Codex",
      };
      name.textContent = labels[State.settings.chatProvider] ?? "Gemini";
      const accents: Record<string, string> = {
        gemini_account: "#4285f4", claude_account: "#d97757",
        chatgpt_account: "#10a37f", codex_account: "#2dd4bf",
      };
      const dot = el.querySelector(".model-dot") as HTMLElement | null;
      if (dot) dot.style.background = accents[State.settings.chatProvider] ?? accents.gemini_account;
      const file = State.droppedFile;
      const wantChip = file?.name ?? "";
      if (chipRow.dataset.label !== wantChip) {
        chipRow.dataset.label = wantChip;
        clear(chipRow);
        if (wantChip) chipRow.append(contextChip(wantChip));
      }
      const thinking = State.stateOverride === "thinking";
      const count = State.chatHistory.length + (thinking ? 0.5 : 0);
      if (count !== renderedCount && !live) {
        renderedCount = count;
        clear(log);
        for (const message of State.chatHistory) log.append(bubble(message));
        if (thinking) log.append(typingDots());
        log.scrollTop = log.scrollHeight;
      }
      input.placeholder = t(State.chatHistory.length === 0 ? STRINGS.placeholderFirst : STRINGS.placeholderNext);
      input.disabled = sending;
      send.disabled = sending;
    },
    focus() { input.focus(); input.select(); },
  };

}
