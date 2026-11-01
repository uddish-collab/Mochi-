import test from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { Island } from "../src/island/island.ts";
import { State } from "../src/core/state.ts";

test("settings panel: keep drop position while open and reset after close", () => {
  const dom = installFakeDom();
  const root = dom.root();
  globalThis.window = {
    innerWidth: 1920,
    innerHeight: 1080,
    addEventListener: () => {},
    removeEventListener: () => {},
    clearTimeout: () => {},
    setTimeout: (fn) => fn(),
  };

  const island = new Island(root);
  const panel = root.childNodes.find((n) => n.id === "mochi-settings-panel");
  assert.ok(panel, "settings panel element exists");
  assert.equal(panel.style.display, "none", "panel starts closed");

  // Open settings panel
  island.toggleSettingsPanel();
  assert.equal(panel.style.display, "block", "panel opens on toggle");
  const initialLeft = parseInt(panel.style.left, 10);
  const initialTop = parseInt(panel.style.top, 10);
  assert.ok(!isNaN(initialLeft), "left position is numeric");
  assert.ok(!isNaN(initialTop), "top position is numeric");

  // Close via toggle
  island.toggleSettingsPanel();
  assert.equal(panel.style.display, "none", "panel closes on toggle");

  // Reopen: position should match initial position
  island.toggleSettingsPanel();
  assert.equal(panel.style.display, "block", "panel reopens");
  assert.equal(parseInt(panel.style.left, 10), initialLeft, "initial position preserved");
  assert.equal(parseInt(panel.style.top, 10), initialTop, "initial top preserved");

  // Simulate dragging header
  const header = panel.childNodes.find((n) => n.id === "settings-panel-header");
  assert.ok(header, "header exists and is identified");
  assert.equal(header.style.cursor, "grab", "header cursor is grab");

  // Drag to (400, 300)
  panel.getBoundingClientRect = () => ({ left: initialLeft, top: initialTop, width: 260, height: 300 });
  const moveListeners = [];
  const upListeners = [];
  globalThis.window.addEventListener = (type, fn) => {
    if (type === "pointermove") moveListeners.push(fn);
    if (type === "pointerup") upListeners.push(fn);
  };
  globalThis.window.removeEventListener = (type, fn) => {
    if (type === "pointermove") {
      const idx = moveListeners.indexOf(fn);
      if (idx !== -1) moveListeners.splice(idx, 1);
    }
    if (type === "pointerup") {
      const idx = upListeners.indexOf(fn);
      if (idx !== -1) upListeners.splice(idx, 1);
    }
  };

  header.listeners.get("pointerdown")[0]({
    button: 0,
    clientX: initialLeft + 50,
    clientY: initialTop + 10,
    preventDefault: () => {},
    stopPropagation: () => {},
    target: header,
  });

  // Move by dx = +200, dy = +150
  moveListeners[0]({
    clientX: initialLeft + 250,
    clientY: initialTop + 160,
  });

  assert.equal(parseInt(panel.style.left, 10), initialLeft + 200, "panel moved horizontally");
  assert.equal(parseInt(panel.style.top, 10), initialTop + 150, "panel moved vertically");

  // Release leaves Settings at the exact drop position while it stays open.
  upListeners[0]();
  assert.equal(moveListeners.length, 0, "move listeners cleaned up");
  assert.equal(upListeners.length, 0, "up listeners cleaned up");
  assert.equal(parseInt(panel.style.left, 10), initialLeft + 200, "dropped left is retained");
  assert.equal(parseInt(panel.style.top, 10), initialTop + 150, "dropped top is retained");

  // Closing resets position state; reopening recomputes the default position.
  island.closeSettingsPanel();
  assert.equal(panel.style.display, "none", "panel closed");

  island.openSettingsPanel();
  assert.equal(panel.style.display, "block", "panel reopened");
  assert.equal(parseInt(panel.style.left, 10), initialLeft, "default left restored");
  assert.equal(parseInt(panel.style.top, 10), initialTop, "default top restored");
});

test("to-do note drag uses the Settings hand cursor", () => {
  const dom = installFakeDom();
  const root = dom.root();
  globalThis.window = {
    innerWidth: 1920,
    innerHeight: 1080,
    addEventListener: () => {},
    removeEventListener: () => {},
    clearTimeout: () => {},
    setTimeout: (fn) => fn(),
  };

  const island = new Island(root);
  island.toggleTodo();
  const widget = root.childNodes.find((n) => n.id === "todo-widget");
  const header = widget.childNodes[0];
  assert.equal(header.style.cursor, "grab", "idle header uses the open hand");

  header.hasPointerCapture = () => false;
  header.releasePointerCapture = () => {};
  header.listeners.get("pointerdown")[0]({
    pointerId: 1,
    clientX: 40,
    clientY: 40,
    preventDefault: () => {},
    stopPropagation: () => {},
  });
  assert.equal(header.style.cursor, "grabbing", "drag uses the closed hand");

  header.listeners.get("pointerup")[0]({ pointerId: 1 });
  assert.equal(header.style.cursor, "grab", "release restores the open hand");
});

test("settings panel: interactive controls do not initiate drag", () => {
  const dom = installFakeDom();
  const root = dom.root();
  globalThis.window = {
    innerWidth: 1920,
    innerHeight: 1080,
    addEventListener: () => {},
    removeEventListener: () => {},
    clearTimeout: () => {},
    setTimeout: (fn) => fn(),
  };

  const island = new Island(root);
  island.openSettingsPanel();
  const panel = root.childNodes.find((n) => n.id === "mochi-settings-panel");
  const header = panel.childNodes.find((n) => n.id === "settings-panel-header");

  let dragStarted = false;
  globalThis.window.addEventListener = (type) => {
    if (type === "pointermove") dragStarted = true;
  };

  // Click on close button (interactive)
  const closeBtn = header.childNodes.find((n) => n.tagName === "BUTTON");
  header.listeners.get("pointerdown")[0]({
    button: 0,
    clientX: 100,
    clientY: 20,
    preventDefault: () => {},
    stopPropagation: () => {},
    target: closeBtn,
  });

  assert.equal(dragStarted, false, "button click did not start drag");
});
