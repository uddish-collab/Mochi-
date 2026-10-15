// The pill catalog (src/core/pills.ts) and the declared pills in the app state.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MAIN_PILL, MAX_DECLARED, PILL_CATALOG, PILL_CATEGORIES, availablePills, chooseMainPill,
  isComingSoon, isHookPill, mainPillChoices, orderPills, pillDefinition, sanitizeDeclared, sessionSubtitle,
  toggleDeclared,
} from "../src/core/pills.ts";
import { DEFAULT_SETTINGS, State } from "../src/core/state.ts";

// ── The catalog itself ────────────────────────────────────────────────────────

test("the catalog contains only Windows-supported integrations", () => {
  assert.ok(PILL_CATALOG.length > 0);
  assert.equal(new Set(PILL_CATALOG.map((p) => p.id)).size, PILL_CATALOG.length);
  assert.ok(!PILL_CATALOG.some((p) => ["integration_spotify", "integration_music"].includes(p.id)));
  assert.ok(PILL_CATALOG.every((p) => p.support !== "linux" && p.support !== "no"));
  assert.deepEqual(PILL_CATEGORIES.map((c) => c.title), ["Where you code", "Agents", "AI for the chat", "Services"]);
});

test("Windows always offers its shipped pills", () => {
  const ids = availablePills().map((p) => p.id);
  for (const id of ["integration_claude", "integration_github", "agent_claude-desktop", "ai_ollama"]) assert.ok(ids.includes(id), id);
  assert.ok(!ids.some((id) => id.includes("spotify") || id.includes("music")));
});

test("Windows is the only supported host", () => {
  assert.equal(pillDefinition("agent_claude-desktop").support, "windows");
  assert.ok(availablePills().some((p) => p.id === "agent_claude-desktop"));
});

test("no chat provider that works here says Coming soon", () => {
  for (const id of ["ai_anthropic", "ai_google", "ai_openai", "ai_ollama", "ai_lmstudio"]) {
    assert.ok(!isComingSoon(id), id);
  }
  // The local servers are connected through Settings → Local models, not a key.
  assert.deepEqual(pillDefinition("ai_ollama").connect, { kind: "server", field: "ollamaUrl" });
  assert.deepEqual(pillDefinition("ai_lmstudio").connect, { kind: "server", field: "lmstudioUrl" });
  assert.equal(pillDefinition("ai_google").connect.key, "google-api-key");
});

test("the main pill is a workspace tool that works here", () => {
  assert.deepEqual(mainPillChoices("windows").map((p) => p.id), [
    "integration_claude", "agent_cursor", "agent_antigravity", "agent_codex",
  ]);
  assert.equal(DEFAULT_MAIN_PILL, "integration_claude");
});

test("hook-driven pills are the workspace tools and the agents with hooks", () => {
  for (const id of ["integration_claude", "agent_cursor", "agent_codex", "agent_gemini", "agent_copilot", "agent_muse", "agent_antigravity", "agent_opencode", "agent_amp", "agent_hermes"]) {
    assert.ok(isHookPill(id), id);
  }
  for (const id of ["agent_claude-desktop", "ai_anthropic", "integration_stripe", "agent_unknown"]) {
    assert.ok(!isHookPill(id), id);
  }
});

test("a live session names its tool next to the project", () => {
  assert.equal(sessionSubtitle("integration_claude"), "Claude Code");
  assert.equal(sessionSubtitle("agent_cursor"), "Cursor");
  assert.equal(sessionSubtitle("agent_claude-desktop"), "Claude Desktop");
  assert.equal(sessionSubtitle("agent_gemini"), "Agent");
  assert.equal(sessionSubtitle("agent_whatever"), "Agent");
});

// ── Declaring pills ──────────────────────────────────────────────────────────

test("a declaration from an older or edited settings file is made usable", () => {
  assert.deepEqual(
    sanitizeDeclared({ mainPill: "integration_stripe", activeIntegrations: ["integration_claude", "x"] }, "windows"),
    { mainPill: "integration_claude", activeIntegrations: [] },
  );
  assert.deepEqual(
    sanitizeDeclared({ mainPill: "agent_cursor", activeIntegrations: ["agent_cursor", "integration_n8n", "integration_n8n", "integration_spotify"] }, "windows"),
    { mainPill: "agent_cursor", activeIntegrations: ["integration_n8n"] },
  );
  // No mainPill at all: a settings.json from before this version.
  assert.deepEqual(
    sanitizeDeclared({ activeIntegrations: ["integration_github"] }, "windows"),
    { mainPill: "integration_claude", activeIntegrations: ["integration_github"] },
  );
  assert.equal(sanitizeDeclared({ mainPill: "agent_claude-desktop", activeIntegrations: [] }, "windows").mainPill,
    "integration_claude");
});

test("up to four pills next to the main one, never the main one itself", () => {
  const d = {
    mainPill: "integration_claude",
    activeIntegrations: ["integration_n8n", "integration_github", "integration_stripe"],
  };
  const four = toggleDeclared(d, "agent_gemini", "windows");
  assert.equal(four.length, MAX_DECLARED);
  assert.equal(toggleDeclared({ ...d, activeIntegrations: four }, "ai_anthropic", "windows"), null);
  assert.equal(toggleDeclared(d, "integration_claude", "windows"), null);
  assert.equal(toggleDeclared(d, "integration_spotify", "windows"), null);
  assert.ok(toggleDeclared(d, "agent_claude-desktop", "windows").includes("agent_claude-desktop"));
  assert.deepEqual(toggleDeclared(d, "integration_github", "windows"), ["integration_n8n", "integration_stripe"]);
  // Every chat provider can be declared now that the chat talks to it.
  assert.ok(toggleDeclared(d, "ai_google", "windows").includes("ai_google"));
  assert.ok(toggleDeclared(d, "ai_ollama", "windows").includes("ai_ollama"));
});

test("picking a main pill takes it out of the declared ones, and only workspace tools qualify", () => {
  const d = { mainPill: "integration_claude", activeIntegrations: ["agent_cursor", "integration_n8n"] };
  assert.deepEqual(chooseMainPill(d, "agent_cursor", "windows"), {
    mainPill: "agent_cursor", activeIntegrations: ["integration_n8n"],
  });
  assert.equal(chooseMainPill(d, "integration_n8n", "windows"), null);
  assert.equal(chooseMainPill(d, "agent_gemini", "windows"), null);
});

test("pills are ordered main first, then other agents, then the catalog's order", () => {
  const ids = (list) => list.map((t) => t.id);
  const tasks = ["integration_stripe", "agent_mine", "integration_n8n", "agent_cursor", "integration_claude", "agent_gemini"]
    .map((id) => ({ id }));
  assert.deepEqual(ids(orderPills(tasks, "integration_claude")), [
    "integration_claude", "agent_mine", "agent_cursor", "agent_gemini", "integration_n8n", "integration_stripe",
  ]);
  assert.deepEqual(ids(orderPills(tasks, "agent_cursor")).slice(0, 3), [
    "agent_cursor", "agent_mine", "integration_claude",
  ]);
});

// ── In the app state ─────────────────────────────────────────────────────────

beforeEach(() => {
  State.tasks = [];
  State.focusId = null;
  State.os = "windows";
  State.settings = { ...DEFAULT_SETTINGS };
});

const ids = () => State.tasks.map((t) => t.id);

test("the main pill always loads, the declared ones join it, and focus starts on it", () => {
  State.settings.mainPill = "agent_cursor";
  State.settings.activeIntegrations = ["integration_github", "agent_gemini"];
  State.loadIntegrationTasks();
  assert.deepEqual(ids(), ["agent_cursor", "agent_gemini", "integration_github"]);
  assert.equal(State.focusId, "agent_cursor");
  assert.equal(State.tasks[1].name, "Gemini CLI");
  assert.equal(State.tasks[1].color, "#8AB4F8");
});

test("an old settings file gets VS Code as its main pill and keeps its integrations", () => {
  State.settings = { ...DEFAULT_SETTINGS, mainPill: undefined };
  State.loadIntegrationTasks();
  assert.deepEqual(ids(), [
    "integration_claude", "integration_resend", "integration_n8n", "integration_vercel", "integration_github",
  ]);
  assert.equal(State.settings.mainPill, "integration_claude");
});

test("switching the main pill frees its slot and the old main pill goes when idle", () => {
  State.loadIntegrationTasks();
  State.settings.mainPill = "agent_codex";
  State.loadIntegrationTasks();
  assert.equal(ids()[0], "agent_codex");
  assert.ok(!ids().includes("integration_claude"));
  assert.equal(State.focusId, "agent_codex");
});

test("a pill in the middle of a session stays until the session ends", () => {
  State.loadIntegrationTasks();
  State.tasks[0].state = "working";
  State.settings.mainPill = "agent_cursor";
  State.loadIntegrationTasks();
  assert.ok(ids().includes("integration_claude"));
  State.removeTask("integration_claude");
  assert.ok(!ids().includes("integration_claude"));
});

test("the end of a session puts a kept pill back as it was, and removes any other", () => {
  State.settings.activeIntegrations = ["agent_gemini"];
  State.loadIntegrationTasks();
  const gemini = State.tasks.find((t) => t.id === "agent_gemini");
  Object.assign(gemini, { name: "proj", state: "finished", steps: ["a"], pillBadge: "finished" });
  State.removeTask("agent_gemini");
  assert.deepEqual(
    [gemini.name, gemini.state, gemini.steps, gemini.pillBadge],
    ["Gemini CLI", "idle", [], null],
  );
  State.upsertExternalAgent("agent_mine", "mine", "#22C55E");
  State.setFocus("agent_mine");
  State.removeTask("agent_mine");
  assert.ok(!ids().includes("agent_mine"));
  assert.equal(State.focusId, "integration_claude");
});

test("a Claude Code session gets its pill even when it is not loaded", () => {
  State.settings.mainPill = "agent_codex";
  State.loadIntegrationTasks();
  const t = State.upsertWorkspacePill("integration_claude", "proj", "/p");
  assert.equal(ids()[1], "integration_claude");
  assert.equal(t.name, "proj");
  assert.equal(t.sessionCwd, "/p");
  assert.equal(State.upsertWorkspacePill("not_a_pill", "x", ""), null);
});

test("toggling declares up to four pills and never the main one", () => {
  State.settings.activeIntegrations = [];
  State.loadIntegrationTasks();
  for (const id of ["integration_n8n", "agent_gemini", "ai_anthropic", "integration_stripe", "integration_github"]) {
    State.toggleIntegration(id);
  }
  assert.deepEqual(State.settings.activeIntegrations, [
    "integration_n8n", "agent_gemini", "ai_anthropic", "integration_stripe",
  ]);
  State.toggleIntegration("integration_claude");
  assert.ok(ids().includes("integration_claude"));
  State.setFocus("agent_gemini");
  State.toggleIntegration("agent_gemini");
  assert.ok(!ids().includes("agent_gemini"));
  assert.equal(State.focusId, "integration_claude");
});

