// GitHub CLI account controls shared by the idle and live GitHub cards.

import type { GitHubAccount } from "../core/state";
import { Bridge } from "../core/bridge";
import { State } from "../core/state";
import { h, svg } from "./dom";
import { tl, type Msg } from "../i18n/i18n";
import { ICONS } from "./icons";

type GitHubAction = "github_add" | "github_switch" | "github_logout";

function showError(error: unknown) {
  State.noteMessage = String(error).replace(/^Error:\s*/, "");
  State.view = "note";
  State.notify();
}

function run(action: GitHubAction, account?: string) {
  void Bridge.accountAuth(action, account).catch(showError);
}

function accountPicker(accounts: GitHubAccount[], mode: "switch" | "logout") {
  const overlay = h("div", { class: "gh-account-overlay", role: "presentation" });
  const close = () => overlay.remove();
  const title = mode === "switch" ? tl("Choose GitHub account") : tl("Disconnect GitHub account");
  const panel = h("section", { class: "gh-account-dialog", role: "dialog", "aria-modal": "true" },
    h("div", { class: "gh-account-dialog-title", text: title }),
    ...accounts.map((account) => {
      const current = tl("Current account");
      const switchTo = tl("Switch to {login}", { login: `@${account.login}` });
      const accountName = account.active ? `@${account.login} · ${current}` : `@${account.login}`;
      const action = mode === "switch"
        ? h("button", {
            class: "gh-account-action",
            text: account.active ? current : switchTo,
            disabled: account.active,
            onclick: () => { if (!account.active) { close(); run("github_switch", account.login); } },
          })
        : h("button", {
            class: "gh-account-action gh-account-danger",
            text: tl("Log out"),
            onclick: () => {
              if (window.confirm(String(tl("Log out of {login}? This removes its GitHub CLI credentials.", { login: `@${account.login}` })))) {
                close(); run("github_logout", account.login);
              }
            },
          });
      return h("div", { class: "gh-account-choice" },
        h("span", { class: "gh-account-choice-name", text: accountName }), action,
      );
    }),
    h("button", { class: "gh-account-dialog-close", text: tl("Cancel"), onclick: close }),
  );
  overlay.append(panel);
  overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
  document.body.append(overlay);
}

function accountButton(label: Msg, action: GitHubAction, account?: string, disabled = false, onClick?: () => void): HTMLButtonElement {
  return h("button", {
    class: "gh-account-action",
    text: label,
    title: label,
    "aria-label": label,
    disabled,
    onclick: () => {
      if (!disabled) (onClick ?? (() => run(action, account)))();
    },
  }) as HTMLButtonElement;
}

/** In live mode these actions occupy the former PR and review rows. */
function accountRow(
  action: "add" | "switch",
  color: string,
  activeLogin?: string,
  disabled = false,
): HTMLButtonElement {
  const add = action === "add";
  const label = add ? tl("Add account") : tl("Switch account");
  return h("button", {
    class: "int-stat gh-stat gh-account-stat",
    disabled,
    onclick: () => {
      if (!disabled) {
        if (add) run("github_add");
        else githubSwitchAccounts(State.integrations.integration_github?.githubAccounts ?? []);
      }
    },
  },
  h("i", { class: "int-stat-icon", style: `color:${color}` },
    svg(add ? ICONS.plus : ICONS.arrowClockwise, 11, { stroke: 2.2 })),
  h("span", { class: "int-stat-label", text: label }),
  h("span", { class: "int-stat-value gh-account-value", text: add ? "" : activeLogin ? `@${activeLogin}` : "" }),
  ) as HTMLButtonElement;
}

export function githubAddAccountRow(color: string): HTMLButtonElement {
  return accountRow("add", color);
}

export function githubSwitchAccountRow(color: string, activeLogin?: string, disabled = false): HTMLButtonElement {
  return accountRow("switch", color, activeLogin, disabled);
}

export function githubSwitchAccounts(accounts: GitHubAccount[]): void {
  if (accounts.length > 1) accountPicker(accounts, "switch");
}

export function githubLogoutButton(accounts: GitHubAccount[] = []): HTMLButtonElement {
  return h("button", {
    class: "gh-logout",
    text: tl("Log out"),
    title: tl("Disconnect a GitHub account"),
    "aria-label": tl("Disconnect a GitHub account"),
    onclick: () => accountPicker(accounts, "logout"),
  }) as HTMLButtonElement;
}

/** Compact text controls for the GitHub idle card. */
export function githubAccountActions(
  configured: boolean,
  accounts: GitHubAccount[],
  _color: string,
): HTMLElement {
  const actions = h("div", { class: "gh-account-actions" },
    accountButton(tl("Add account"), "github_add"),
  );
  if (configured) {
    actions.append(
      accountButton(tl("Switch account"), "github_switch", undefined, accounts.length < 2, () => accountPicker(accounts, "switch")),
      accountButton(tl("Log out"), "github_logout", undefined, accounts.length === 0, () => accountPicker(accounts, "logout")),
    );
  }
  return actions;
}

export function showGitHubAuthError(message: string) {
  showError(message);
}
