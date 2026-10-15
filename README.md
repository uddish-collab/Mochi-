# Mochi for Windows

Mochi is a small desktop companion for Windows. It stays at the top of your screen, shows activity from your coding agents, and keeps chat and useful tools close while you work.

![Mochi on Windows](screenshots/overview.png)

## Features

- See live sessions from Claude Code, Codex, Cursor, Gemini CLI, Antigravity, and other supported agents.
- Review Claude Code permission requests and answer questions from the Mochi island.
- Chat with Gemini inside Mochi, inspect code changes, and drop files for context.
- Keep Mochi on the desktop, customize its appearance, and use global shortcuts.
- Connect optional services such as GitHub, Stripe, Vercel, Resend, Notion, Cal.com, and n8n.

## Install

Download the latest Windows installer from [Releases](https://github.com/uddish-collab/Mochi-/releases/latest). The setup executable installs for your Windows account. The MSI may require administrator access.

Mochi keeps its settings and app data in your Windows user profile. Account access stays with your browser or the provider's own CLI.

The default island shows four account Mochis: Claude, Gemini, ChatGPT, and Codex. Turn on VS Code or GitHub from **Settings → Active pills** to add them. Clicking Claude, Gemini, ChatGPT, or Codex opens an in-Mochi chat backed by the provider's official account CLI (Claude Code, Gemini CLI, or Codex CLI). Install the relevant CLI and sign in once; **Switch account** opens its interactive sign-in controls. ChatGPT and Codex use the same signed-in Codex CLI account. VS Code opens the editor, where its own account menu manages sign-in. GitHub CLI powers Mochi's GitHub activity; the GitHub card includes sign-in and account-switch actions. Old saved API keys and service tokens are cleared when the account-only build starts.

## Build from source

Requirements: Windows 10 or later, Node.js 22, Rust with the MSVC toolchain, and Microsoft C++ Build Tools.

```powershell
git clone https://github.com/uddish-collab/Mochi-.git
cd Mochi-
npm ci
npm test
npm run pack
```

The release installers are written to `release/`. To run the app during development:

```powershell
npm run tauri dev
```
