import { test } from "node:test";
import assert from "node:assert/strict";
import { calls, emit, sent } from "./tauri.mjs";
import { installFakeDom } from "./fakedom.mjs";
import {
  githubAccountActions, githubAddAccountRow, githubSwitchAccountRow, githubLogoutButton,
} from "../src/views/github-auth.ts";
import { State } from "../src/core/state.ts";
import { registerIntegrationHandlers } from "../src/island/integrations.ts";

installFakeDom();

const action = (root, label) => root.find(".gh-account-action").find((button) => button.textContent === label);

test("disconnected GitHub offers adding an account", async () => {
  const root = githubAccountActions(false, [], "#fff");
  assert.equal(root.find(".gh-account-action").length, 1);
  action(root, "Add account").fire("click");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sent("account_auth").at(-1).provider, "github_add");
});

test("connected GitHub offers distinct add, switch and logout actions", async () => {
  const oneAccount = githubAccountActions(true, [{ login: "octo", active: true }], "#fff");
  assert.equal(oneAccount.find(".gh-account-action").length, 3);
  assert.equal(action(oneAccount, "Switch account").getAttribute("disabled"), "");
  const switchRow = githubSwitchAccountRow("#fff", "octo", true);
  assert.equal(switchRow.getAttribute("disabled"), "");
  assert.equal(switchRow.textContent.includes("@octo"), true);
  assert.equal(githubAddAccountRow("#fff").textContent.includes("Add account"), true);

  const twoAccounts = githubAccountActions(true, [
    { login: "octo", active: true }, { login: "mochi", active: false },
  ], "#fff");
  action(twoAccounts, "Add account").fire("click");
  action(twoAccounts, "Switch account").fire("click");
  document.body.find(".gh-account-overlay").at(-1).find(".gh-account-action")
    .find((button) => button.textContent === "Switch to @mochi").fire("click");
  githubLogoutButton([
    { login: "octo", active: true }, { login: "mochi", active: false },
  ]).fire("click");
  globalThis.confirm = () => true;
  document.body.find(".gh-account-overlay").at(-1).find(".gh-account-danger").at(-1).fire("click");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(sent("account_auth").slice(-3).map((args) => [args.provider, args.account]), [
    ["github_add", null], ["github_switch", "mochi"], ["github_logout", "mochi"],
  ]);
});

test("disconnect asks first and leaves credentials alone when the user cancels", () => {
  const originalConfirm = globalThis.confirm;
  const before = sent("account_auth").length;
  globalThis.confirm = () => false;
  try {
    githubLogoutButton([{ login: "octo", active: true }]).fire("click");
    document.body.find(".gh-account-overlay").at(-1).find(".gh-account-danger").at(-1).fire("click");
    assert.equal(sent("account_auth").length, before);
  } finally {
    globalThis.confirm = originalConfirm;
  }
});

test("GitHub account command failures are shown in Mochi", async () => {
  const before = calls.length;
  const originalInvoke = globalThis.__TAURI_INTERNALS__.invoke;
  globalThis.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
    if (cmd === "account_auth") throw new Error("GitHub CLI was not found");
    return originalInvoke(cmd, args);
  };
  try {
    const root = githubAccountActions(false, [], "#fff");
    action(root, "Add account").fire("click");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.match(State.noteMessage, /GitHub CLI was not found/);
    assert.equal(State.view, "note");
    assert.equal(calls.slice(before).some(([cmd]) => cmd === "account_auth"), false);
  } finally {
    globalThis.__TAURI_INTERNALS__.invoke = originalInvoke;
  }
});

test("a failed interactive GitHub CLI process reports its exit code", async () => {
  registerIntegrationHandlers({});
  emit("github-auth-result", { action: "switch", success: false, exitCode: 1 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(State.noteMessage, /Switch account failed \(exit code 1\)/);
  assert.equal(State.view, "note");
});

test("a cancelled GitHub CLI process gets a retry message", async () => {
  registerIntegrationHandlers({});
  emit("github-auth-result", { action: "add", success: false, exitCode: -1073741510 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(State.noteMessage, /setup was cancelled/i);
});
