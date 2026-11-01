// Windows pill catalog: stable IDs, labels, colors, categories, and connection rules.

import type { AgentSource } from "./state";
import { N_ } from "../i18n/i18n";

export type PillCategory = "workspace" | "agent" | "ai" | "service";

/** Section titles (English keys, shown with `t()`), in display order. */
export const PILL_CATEGORIES: { id: PillCategory; title: string }[] = [
  { id: "workspace", title: N_("Where you code") },
  { id: "service", title: N_("Services") },
];

export type PillSupport = "yes" | "windows" | "soon";

/** What makes the pill connected. */
export type PillConnect =
  /** Hook events: connected once the hooks are installed (Mac #183). */
  | { kind: "hooks" }
  /** A key in the credential store. */
  | { kind: "key"; key: string }
  /** A model server the chat is connected to (Settings → Local models). */
  | { kind: "server"; field: "ollamaUrl" | "lmstudioUrl" }
  /** An account-backed website or installed desktop tool. */
  | { kind: "account"; url: string }
  /** Nothing to set up. */
  | { kind: "none" };

export interface PillDefinition {
  id: string;
  name: string;
  color: string;
  category: PillCategory;
  /** Label next to the pill name in the idle card header (an English key, shown with `t()`). */
  subtitle: string;
  source: AgentSource;
  support: PillSupport;
  connect: PillConnect;
}

export type HostOs = "windows";

export const PILL_CATALOG: readonly PillDefinition[] = [
  // ── Where you code ─────────────────────────────────────────────────────────
  {
    id: "integration_vscode",
    name: "VS Code",
    color: "#007ACC",
    category: "workspace",
    subtitle: N_("Workspace"),
    source: "agent",
    support: "yes",
    connect: { kind: "account", url: "https://code.visualstudio.com/" },
  },
  // ── Services / Account ─────────────────────────────────────────────────────
  {
    id: "integration_github",
    name: "GitHub",
    color: "#F4505E",
    category: "service",
    subtitle: N_("Integration"),
    source: "n8n",
    support: "yes",
    connect: { kind: "account", url: "https://github.com/" },
  },
];

/** The always-on pill unless the user picks another workspace tool. */
export const DEFAULT_MAIN_PILL = "integration_vscode";

/** How many declared pills may sit next to the main one. */
export const MAX_DECLARED = 1;

/** The OS this page runs on. Only the Windows webview says "Windows". */
export const HOST_OS: HostOs = "windows";

export function pillDefinition(id: string): PillDefinition | undefined {
  return PILL_CATALOG.find((p) => p.id === id);
}

function offeredOn(def: PillDefinition, os: HostOs): boolean {
  return def.support === "yes" || def.support === "soon" || (os === "windows" && def.support === "windows");
}

/** The pills this build offers, in catalog order. */
export function availablePills(os: HostOs = HOST_OS): PillDefinition[] {
  return PILL_CATALOG.filter((p) => offeredOn(p, os));
}

export function isComingSoon(id: string): boolean {
  return pillDefinition(id)?.support === "soon";
}

/** True for pills whose sessions arrive as hook events (Mac #183). */
export function isHookPill(id: string): boolean {
  return pillDefinition(id)?.connect.kind === "hooks";
}

/** Workspace tools that can be the main pill. */
export function mainPillChoices(os: HostOs = HOST_OS): PillDefinition[] {
  return availablePills(os).filter((p) => p.category === "workspace" && p.support !== "soon");
}

/** PillDefinition.sessionSubtitle — next to the name in a live session's card. */
export function sessionSubtitle(id: string): string {
  switch (id) {
    case "integration_vscode": return "VS Code";
    case "integration_github": return "GitHub";
    default: return N_("Agent");
  }
}

export interface Declared {
  mainPill: string;
  activeIntegrations: string[];
}

/**
 * The declaration as it may be used: a main pill this build can run (else the
 * default), and declared pills this build offers, without duplicates and
 * without the main pill, which never takes a slot.
 */
export function sanitizeDeclared(d: Declared, os: HostOs = HOST_OS): Declared {
  const mains = new Set(mainPillChoices(os).map((p) => p.id));
  const mainPill = mains.has(d.mainPill) ? d.mainPill : DEFAULT_MAIN_PILL;
  const offered = new Set(availablePills(os).map((p) => p.id));
  const activeIntegrations: string[] = [];
  for (const id of d.activeIntegrations ?? []) {
    if (offered.has(id) && id !== mainPill && !activeIntegrations.includes(id)) {
      activeIntegrations.push(id);
    }
  }
  if (d.activeIntegrations == null && offered.has("integration_github") && mainPill !== "integration_github") {
    activeIntegrations.push("integration_github");
  }
  return { mainPill, activeIntegrations };
}

/**
 * Declares or undeclares a pill. Returns the new list, or null when the click
 * changes nothing.
 */
export function toggleDeclared(d: Declared, id: string, os: HostOs = HOST_OS): string[] | null {
  if (!availablePills(os).some((p) => p.id === id)) return null;
  if (id === d.mainPill) return null;
  if (d.activeIntegrations.includes(id)) return d.activeIntegrations.filter((x) => x !== id);
  if (d.activeIntegrations.length >= MAX_DECLARED) return null;
  return [...d.activeIntegrations, id];
}

/**
 * Picks a new main pill.
 */
export function chooseMainPill(d: Declared, id: string, os: HostOs = HOST_OS): Declared | null {
  if (!mainPillChoices(os).some((p) => p.id === id)) return null;
  const activeIntegrations = d.activeIntegrations.filter((x) => x !== id);
  return { mainPill: id, activeIntegrations };
}

/**
 * Pill order: the main pill first, then other catalog pills in catalog order.
 */
export function orderPills<T extends { id: string }>(tasks: T[], mainPill: string): T[] {
  const index = new Map(PILL_CATALOG.map((p, i) => [p.id, i]));
  const rank = (t: T) => (t.id === mainPill ? -2 : index.has(t.id) ? index.get(t.id)! : 0);
  return tasks
    .map((t, i) => ({ t, i }))
    .sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i)
    .map(({ t }) => t);
}
