# Mochi for Windows

Mochi is a small desktop companion for Windows. It stays at the top of your screen, shows activity from your coding agents, and keeps chat and useful tools close while you work.

![Mochi on Windows](screenshots/overview.png)

## Features

- See live sessions from Claude Code, Codex, Cursor, Gemini CLI, Antigravity, and other supported agents.
- Review Claude Code permission requests and answer questions from the Mochi island.
- Chat with configured AI providers, inspect code changes, and drop files for context.
- Keep Mochi on the desktop, customize its appearance, and use global shortcuts.
- Connect optional services such as GitHub, Stripe, Vercel, Resend, Notion, Cal.com, and n8n.

## Install

Download the latest Windows installer from [Releases](https://github.com/uddish-collab/Mochi-/releases/latest). The setup executable installs for your Windows account. The MSI may require administrator access.

Mochi keeps its settings and app data in your Windows user profile. API keys and service tokens are stored in Windows Credential Manager.

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
