// The pill catalog (src/core/pills.ts) and the declared pills in the app state.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MAIN_PILL, MAX_DECLARED, PILL_CATALOG, PILL_CATEGORIES, availablePills, chooseMainPill,
  mainPillChoices, orderPills, pillDefinition, sanitizeDeclared, sessionSubtitle,
  toggleDeclared,
} from "../src/core/pills.ts";
import { DEFAULT_SETTINGS, State } from "../src/core/state.ts";

// ── The catalog itself ────────────────────────────────────────────────────────

test("the catalog contains only Windows-supported integrations (exactly VS Code and GitHub)", () => {
  assert.equal(PILL_CATALOG.length, 2);
  assert.deepEqual(PILL_CATALOG.map((p) => p.id), ["integration_vscode", "integration_github"]);
  assert.ok(PILL_CATALOG.every((p) => p.support === "yes"));
  assert.deepEqual(PILL_CATEGORIES.map((c) => c.title), ["Where you code", "Services"]);
});

test("Windows always offers its shipped pills (VS Code and GitHub)", () => {
  const ids = availablePills().map((p) => p.id);
  assert.deepEqual(ids, ["integration_vscode", "integration_github"]);
});

test("the main pill is a workspace tool that works here", () => {
  assert.deepEqual(mainPillChoices("windows").map((p) => p.id), ["integration_vscode"]);
  assert.equal(DEFAULT_MAIN_PILL, "integration_vscode");
});

test("a live session names its tool next to the project", () => {
  assert.equal(sessionSubtitle("integration_vscode"), "VS Code");
  assert.equal(sessionSubtitle("integration_github"), "GitHub");
});

// ── Declaring pills ──────────────────────────────────────────────────────────

test("a declaration from an older or edited settings file is made usable", () => {
  assert.deepEqual(
    sanitizeDeclared({ mainPill: "integration_vscode", activeIntegrations: ["integration_github"] }, "windows"),
    { mainPill: "integration_vscode", activeIntegrations: ["integration_github"] },
  );
  assert.deepEqual(
    sanitizeDeclared({ mainPill: "integration_stripe", activeIntegrations: [] }, "windows"),
    { mainPill: "integration_vscode", activeIntegrations: [] },
  );
  assert.deepEqual(
    sanitizeDeclared({ activeIntegrations: undefined }, "windows"),
    { mainPill: "integration_vscode", activeIntegrations: ["integration_github"] },
  );
});

test("declaring pills: max 1 next to the main one, never the main one itself", () => {
  const d = {
    mainPill: "integration_vscode",
    activeIntegrations: [],
  };
  const one = toggleDeclared(d, "integration_github", "windows");
  assert.equal(one.length, MAX_DECLARED);
  assert.deepEqual(one, ["integration_github"]);
  assert.equal(toggleDeclared(d, "integration_vscode", "windows"), null);
  assert.equal(toggleDeclared(d, "unknown_pill", "windows"), null);
  assert.deepEqual(toggleDeclared({ ...d, activeIntegrations: one }, "integration_github", "windows"), []);
});

test("picking a main pill", () => {
  const d = { mainPill: "integration_vscode", activeIntegrations: ["integration_github"] };
  assert.deepEqual(chooseMainPill(d, "integration_vscode", "windows"), {
    mainPill: "integration_vscode", activeIntegrations: ["integration_github"],
  });
  assert.equal(chooseMainPill(d, "integration_github", "windows"), null);
});

test("pills are ordered main first, then the catalog's order", () => {
  const ids = (list) => list.map((t) => t.id);
  const tasks = [{ id: "integration_github" }, { id: "integration_vscode" }];
  assert.deepEqual(ids(orderPills(tasks, "integration_vscode")), [
    "integration_vscode", "integration_github",
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
  State.settings.mainPill = "integration_vscode";
  State.settings.activeIntegrations = ["integration_github"];
  State.loadIntegrationTasks();
  assert.deepEqual(ids(), ["integration_vscode", "integration_github"]);
  assert.equal(State.focusId, "integration_vscode");
  assert.equal(State.tasks[0].name, "VS Code");
  assert.equal(State.tasks[1].name, "GitHub");
});

test("an old settings file gets VS Code as its main pill and keeps its integrations", () => {
  State.settings = { ...DEFAULT_SETTINGS, mainPill: undefined };
  State.loadIntegrationTasks();
  assert.deepEqual(ids(), ["integration_vscode", "integration_github"]);
  assert.equal(State.settings.mainPill, "integration_vscode");
});

test("a pill in the middle of a session stays until the session ends", () => {
  State.loadIntegrationTasks();
  State.tasks[0].state = "working";
  State.removeTask("integration_vscode");
  assert.ok(ids().includes("integration_vscode"));
});

test("the end of a session puts a kept pill back as it was, and removes any other", () => {
  State.settings.activeIntegrations = ["integration_github"];
  State.loadIntegrationTasks();
  const github = State.tasks.find((t) => t.id === "integration_github");
  Object.assign(github, { name: "proj", state: "finished", steps: ["a"], pillBadge: "finished" });
  State.removeTask("integration_github");
  assert.deepEqual(
    [github.name, github.state, github.steps, github.pillBadge],
    ["GitHub", "idle", [], null],
  );
});

test("a session gets its pill even when it is not loaded", () => {
  State.settings.activeIntegrations = [];
  State.loadIntegrationTasks();
  const t = State.upsertWorkspacePill("integration_vscode", "proj", "/p");
  assert.equal(t.name, "proj");
  assert.equal(t.sessionCwd, "/p");
  assert.equal(State.upsertWorkspacePill("not_a_pill", "x", ""), null);
});

test("toggling declares up to one pill and never the main one", () => {
  State.settings.activeIntegrations = [];
  State.loadIntegrationTasks();
  State.toggleIntegration("integration_github");
  assert.deepEqual(State.settings.activeIntegrations, ["integration_github"]);
  State.toggleIntegration("integration_vscode");
  assert.deepEqual(State.settings.activeIntegrations, ["integration_github"]);
  State.toggleIntegration("integration_github");
  assert.deepEqual(State.settings.activeIntegrations, []);
});
