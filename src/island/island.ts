// The island: DOM shell, sizing animation, Mochi placement, mouse handling.
// Mirrors IslandRootView.swift + IslandWindowController.swift.

import { invoke } from "@tauri-apps/api/core";
import { Tracked, Spring, clamp } from "../core/anim";
import { Bridge, IS_TAURI, onDragDrop } from "../core/bridge";
import {
  EXPANDED_CORNER, EXPANDED_W, NOTCH_W, PANEL_H, PANEL_W,
  ROUNDED_CORNER, VIEW_LAYOUTS, botGlowColor, botGlowOpacity, botPosition, chatPromptHeight,
  islandSize,
  QUESTION_PICKER_H,
  type BotEmoteName, type IslandMode, type IslandViewName,
} from "../core/layout";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { BotEngine, hexToRGB } from "../mochi/engine";
import { Greeting } from "../mochi/greeting";
import { createMiniBot, pruneMiniBots, syncMiniBotStates, tickMiniBots } from "../mochi/minibots";
import { SeasonCache, parseOutfit } from "../mochi/wardrobe";
import { UploadCanvas } from "../upload/canvas";
import { USC, UploadSeq } from "../upload/sequence";
import { closePlanCard, openPlanColor, planCardOpen } from "../views/usage";
import { buildHeader, buildViews, type ViewActions, type ViewHost } from "../views/views";
import { h } from "../views/dom";
import { IslandStateMachine } from "./fsm";
import { refreshHookPills } from "./integrations";
import { DesktopLink } from "./desktop";
import type { ViewCommand } from "./shortcuts";
import { DRAG_THRESHOLD } from "../mochi/desktop-logic";

type TodoTask = { text: string; done: boolean };

const BOT_OVERHANG = 40;
const CLAUDE_DESKTOP_ID = "agent_claude-desktop";
const BOT_SIDE = 24;
const HIT_MARGIN = 14;
const TODO_GAP = 12;
const TODO_STORAGE_KEY = "mochi.todo-tasks.v1";

const UPLOAD_VIEWS: ReadonlySet<IslandViewName> = new Set(["upload", "uploading", "choose"]);
const PRE_PROGRESS = USC.T_PROG_START - USC.T_DROP;
const modeOrder = (m: IslandMode) => (m === "hidden" ? 0 : m === "compact" ? 1 : 2);

export class Island {
  readonly fsm = new IslandStateMachine();
  readonly desktop: DesktopLink;

  private root: HTMLElement;
  private islandEl!: HTMLElement;
  private clipEl!: HTMLElement;
  private contentEl!: HTMLElement;
  private viewsEl!: HTMLElement;
  private botCanvas!: HTMLCanvasElement;
  private botGlow!: HTMLElement;
  private greetingCanvas!: HTMLCanvasElement;
  private miniGrid!: HTMLElement;
  private countdown!: HTMLElement;
  private wakeStrip!: HTMLElement;

  private todoEl!: HTMLElement;
  private todoListEl!: HTMLElement;
  private todoOpen = false;
  private todoTasks: TodoTask[] = this.loadTodos();

  private header!: ViewHost;
  private views!: Map<IslandViewName, ViewHost>;
  private uploadCanvas!: UploadCanvas;

  private width = new Tracked(NOTCH_W);
  private height = new Tracked(0);
  private radius = new Tracked(ROUNDED_CORNER);
  private botCx = new Spring(46);
  private botCy = new Spring(16);
  private botSize = new Spring(10);

  private engine = new BotEngine();
  private greeting = new Greeting();
  private greetingShown = false;
  private seasons = new SeasonCache();

  private running = false;
  private lastFrame = 0;
  private dirty = true;
  private canvasPx = 0;

  private collapsed = false;
  private collapseTimer: number | null = null;
  private wasInIsland = false;
  private pushedRect = { x: -1, y: -1, w: -1, h: -1 };

  private botHovering = false;
  private botHoverTimer: number | null = null;
  private lastLoveTime = 0;
  private botHoverStart = { x: 0, y: 0 };

  private confusedRecovery: number | null = null;
  private prevViewBeforeConfused: IslandViewName = "overview";
  private lastSyncedView: IslandViewName | null = null;

  onGreetingDone: (() => void) | null = null;
  onWake: (() => void) | null = null;

  private botPress: { x: number; y: number } | null = null;
  // Where the island sits inside the full-display window, relative to its
  // default top-centre spot. Dragging changes this; the window never moves.
  private islandOffset = { x: 0, y: 0 };
  private islandPress: { x: number; y: number; ox: number; oy: number } | null = null;
  private islandDragging = false;
  private silentReveal = false;
  private uploadTens = 0;
  private uploadDone = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.fillWindow();
    this.desktop = new DesktopLink({
      reveal: () => this.reveal(),
      wardrobeFromDesktop: () => this.wardrobeFromDesktop(),
      dizzyFromDesktop: () => this.handleDizzy(),
    });
    this.build();
    this.wireFsm();
    this.wireInput();
    this.engine.onDizzy = () => this.handleDizzy();
    this.greeting.onComplete = () => {
      this.fsm.greetComplete();
      this.onGreetingDone?.();
    };
    State.subscribe(() => {
      this.dirty = true;
      this.ensureRunning();
    });
  }

  // ── Full-display window ─────────────────────────────────────────────────────

  /// The native window now covers the whole display, so the page fills it with
  /// nothing painted: the island is centred in it, and Rust lets every click
  /// outside the drawn shapes through.
  private fillWindow() {
    const html = document.documentElement.style;
    const body = document.body.style;
    html.background = "transparent";
    html.width = "100%";
    html.height = "100%";
    body.background = "transparent";
    body.margin = "0";
    body.width = "100%";
    body.height = "100%";
    body.overflow = "hidden";
    const r = this.root.style;
    r.position = "fixed";
    r.left = "0";
    r.top = "0";
    r.width = "100vw";
    r.height = "100vh";
    r.overflow = "hidden";
    r.background = "transparent";
  }

  /// Width of the window the island is centred in.
  private viewW(): number {
    return window.innerWidth || PANEL_W;
  }

  // ── To-do List widget ───────────────────────────────────────────────────────

  private buildTodo() {
    this.todoEl = h("div", {
      id: "todo-widget",
      style:
        "position:fixed;left:0;top:0;width:220px;box-sizing:border-box;" +
        "background:rgba(18,18,18,0.95);backdrop-filter:blur(12px);" +
        "border:1px solid rgba(255,255,255,0.15);border-radius:10px;padding:10px;" +
        "z-index:30;display:none;box-shadow:0 8px 24px rgba(0,0,0,0.5);color:#fff;",
    });

    const head = h(
      "div",
      {
        style:
          "display:flex;align-items:center;margin-bottom:6px;padding-bottom:4px;" +
          "border-bottom:1px solid rgba(255,255,255,0.1);cursor:move;user-select:none;touch-action:none;",
      },
      h(
        "span",
        {
          style:
            "font-weight:bold;font-size:11px;color:#aaa;text-transform:uppercase;letter-spacing:0.5px;",
        },
        "To-do List",
      ),
    );

    this.todoListEl = h("ul", {
      style: "list-style:none;padding:0;margin:0;font-size:12px;max-height:140px;overflow-y:auto;",
    });

    const input = h("input", {
      type: "text",
      style:
        "background:rgba(0,0,0,0.5);border:1px solid rgba(255,255,255,0.15);color:#fff;" +
        "border-radius:6px;padding:5px 8px;width:100%;margin-top:8px;font-size:11px;" +
        "outline:none;box-sizing:border-box;",
    }) as HTMLInputElement;
    input.addEventListener("focus", () => void Bridge.focusWindow(true));
    input.addEventListener("blur", () => void Bridge.focusWindow(false));
    input.addEventListener("keydown", (e) => {
      // Typing here must not reach the island's own keys (Escape collapses it).
      e.stopPropagation();
      if (e.key === "Enter" && input.value.trim()) {
        this.todoTasks.push({ text: input.value.trim(), done: false });
        input.value = "";
        Sound.play("pop");
        this.saveTodos();
        this.renderTodoItems();
      }
    });

    // Drag: pointer capture keeps the drag alive anywhere on the screen.
    let dragging = false;
    let dx = 0;
    let dy = 0;
    head.addEventListener("pointerdown", (e) => {
      dragging = true;
      dx = e.clientX - this.todoEl.offsetLeft;
      dy = e.clientY - this.todoEl.offsetTop;
      head.setPointerCapture(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
    });
    head.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const maxX = Math.max(0, window.innerWidth - this.todoEl.offsetWidth);
      const maxY = Math.max(0, window.innerHeight - this.todoEl.offsetHeight);
      this.todoEl.style.left = `${clamp(e.clientX - dx, 0, maxX)}px`;
      this.todoEl.style.top = `${clamp(e.clientY - dy, 0, maxY)}px`;
      this.pushTodoRect();
    });
    const endDrag = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      if (head.hasPointerCapture(e.pointerId)) head.releasePointerCapture(e.pointerId);
      this.pushTodoRect();
    };
    head.addEventListener("pointerup", endDrag);
    head.addEventListener("pointercancel", endDrag);

    this.todoEl.append(head, this.todoListEl, input);
    this.renderTodoItems();
  }

  /// Tasks live in the webview's localStorage, so they survive restarts. Storage
  /// can be missing or throw (cleared data, a locked profile): then the list
  /// simply starts empty and works in memory.
  private loadTodos(): TodoTask[] {
    try {
      const raw = localStorage.getItem(TODO_STORAGE_KEY);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((t): t is { text: string; done?: unknown } => !!t && typeof t.text === "string")
        .map((t) => ({ text: t.text, done: t.done === true }));
    } catch {
      return [];
    }
  }

  private saveTodos() {
    try {
      localStorage.setItem(TODO_STORAGE_KEY, JSON.stringify(this.todoTasks));
    } catch {
      /* in-memory only */
    }
  }

  private renderTodoItems() {
    this.todoListEl.replaceChildren();
    this.todoTasks.forEach((task, index) => {
      const text = h(
        "span",
        {
          style:
            `flex:1;word-break:break-all;cursor:pointer;color:${task.done ? "#777" : "#fff"};` +
            `text-decoration:${task.done ? "line-through" : "none"};`,
        },
        task.text,
      );
      text.onclick = () => {
        task.done = !task.done;
        Sound.play(task.done ? "approve" : "blip");
        this.saveTodos();
        this.renderTodoItems();
      };

      const del = h(
        "button",
        {
          style:
            "cursor:pointer;background:none;border:none;color:#ff5555;margin-left:8px;" +
            "font-weight:bold;font-size:12px;",
        },
        "✕",
      );
      del.onclick = () => {
        this.todoTasks.splice(index, 1);
        Sound.play("blip");
        this.saveTodos();
        this.renderTodoItems();
      };

      this.todoListEl.append(
        h(
          "li",
          { style: "display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;" },
          text,
          del,
        ),
      );
    });
    // The list grew or shrank, and so did the widget the mouse has to find.
    this.pushTodoRect();
  }

  /// Tells Rust where the widget is, so it takes the mouse there and nowhere else.
  private pushTodoRect() {
    if (!IS_TAURI) return;
    let x = 0, y = 0, w = 0, hh = 0;
    if (this.todoOpen) {
      const r = this.todoEl.getBoundingClientRect();
      x = r.left;
      y = r.top;
      w = r.width;
      hh = r.height;
    }
    void invoke("set_extra_rect", { x, y, width: w, height: hh }).catch(() => {});
  }

  private openTodo() {
    this.todoOpen = true;
    // Directly to the right of the island, kept inside the display.
    const r = this.islandRect();
    const maxX = Math.max(0, window.innerWidth - 220);
    this.todoEl.style.display = "block";
    const maxY = Math.max(0, window.innerHeight - this.todoEl.offsetHeight);
    this.todoEl.style.left = `${clamp(r.x + r.w + TODO_GAP, 0, maxX)}px`;
    this.todoEl.style.top = `${clamp(r.y + TODO_GAP, 0, maxY)}px`;
    Sound.play("blip");
    this.pushTodoRect();
  }

  private closeTodo() {
    if (!this.todoOpen) return;
    this.todoOpen = false;
    this.todoEl.style.display = "none";
    this.pushTodoRect();
  }

  private toggleTodo() {
    if (this.todoOpen) {
      Sound.play("blip");
      this.closeTodo();
    } else {
      this.openTodo();
    }
  }

  // ── Approvals ───────────────────────────────────────────────────────────────

  private closeApproval() {
    State.endApproval();
    this.fsm.pinned = false;
    this.setView(State.defaultView());
  }

  foldApproval() {
    if (!State.pendingApproval || State.mode !== "expanded") return;
    State.isPinned = true;
    this.fsm.pinned = true;
    this.fsm.forcePetit();
  }

  // ── DOM ─────────────────────────────────────────────────────────────────────

  private build() {
    const actions: ViewActions = {
      setView: (v) => this.setView(v),
      cancelDrop: () => this.discardDrop(),
      collapse: () => this.collapse(),
      foldApproval: () => this.foldApproval(),
      setFocus: (id) => {
        State.setFocus(id);
        Sound.play("blip");
        const accountChats: Record<string, string> = {
          agent_gemini: "gemini_account",
          integration_claude: "claude_account",
          integration_chatgpt: "chatgpt_account",
          agent_codex: "codex_account",
        };
        const chatProvider = accountChats[id];
        if (chatProvider) {
          State.settings = { ...State.settings, chatProvider: chatProvider as typeof State.settings.chatProvider };
          void Bridge.saveSettings(State.settings);
          this.setView("prompt");
          return;
        }
        if (id === "integration_vscode") {
          void Bridge.openInVSCode(null);
          return;
        }
        if (id === "integration_github" && !State.integrations.integration_github?.configured) {
          void Bridge.accountAuth("github").catch((err) => {
            State.noteMessage = String(err).replace(/^Error:\s*/, "");
            State.view = "note";
            State.notify();
          });
          return;
        }
        const req = State.pendingApproval;
        if (req?.pillId === id) this.setView(req.questions ? "question" : "approval");
      },
      openTerminal: () => {
        const task = State.focusTask;
        if (task?.id === CLAUDE_DESKTOP_ID) void Bridge.openClaudeDesktop();
        else void Bridge.openSession(task?.sessionId ?? null, task?.sessionCwd ?? null);
      },
      openTarget: () => {
        const task = State.focusTask;
        if (!task) return;
        const urls: Record<string, string> = {
          integration_resend: "https://resend.com/emails",
          integration_vercel: "https://vercel.com/dashboard",
          integration_github: "https://github.com/pulls",
          integration_stripe: "https://dashboard.stripe.com/payments",
          integration_notion: "https://notion.so",
          integration_calcom: "https://app.cal.com/bookings",
        };
        if (task.id === CLAUDE_DESKTOP_ID) void Bridge.openClaudeDesktop();
        else if (task.id === "integration_claude" || task.sessionId) {
          void Bridge.openSession(task.sessionId ?? null, task.sessionCwd ?? null);
        } else if (task.id === "integration_n8n") void Bridge.openN8n();
        else if (urls[task.id]) void Bridge.openUrl(urls[task.id]);
      },
      openUrl: (url) => {
        if (url) void Bridge.openUrl(url);
      },
      decide: (d) => {
        const req = State.pendingApproval;
        if (!req) return;
        Sound.play(d === "deny" ? "blip" : "approve");
        void Bridge.approvalDecision(req.requestId, d);
        this.closeApproval();
      },
      answer: (answers) => {
        const req = State.pendingApproval;
        if (!req) return;
        Sound.play("approve");
        void Bridge.approvalAnswer(req.requestId, answers);
        this.closeApproval();
      },
      answerInTerminal: () => {
        const req = State.pendingApproval;
        if (!req) return;
        Sound.play("blip");
        void Bridge.approvalDecline(req.requestId);
        this.closeApproval();
      },
      toggleSound: () => {
        State.settings.soundEnabled = !State.settings.soundEnabled;
        Sound.setEnabled(State.settings.soundEnabled);
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      setVolume: (v) => {
        State.settings.soundVolume = v;
        Sound.setVolume(v);
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      openSettingsWindow: () => void Bridge.openSettingsWindow(),
      blip: () => Sound.play("blip"),
      chooseOutfit: (selection) => {
        const mochiId = State.focusedMochiId;
        if (parseOutfit(State.focusedMochiOutfit) === selection) return;
        State.settings.mochiOutfits = { ...State.settings.mochiOutfits, [mochiId]: selection };
        void Bridge.saveSettings(State.settings);
        Sound.play("pop");
        this.engine.triggerEmote("proud");
        State.notify();
      },
      previewOutfit: (outfit) => {
        State.wardrobePreview = outfit;
        State.notify();
      },
    };

    this.wakeStrip = h("div", { id: "wake-strip" });
    this.botGlow = h("div", { id: "bot-glow" });
    this.botCanvas = h("canvas", { id: "bot-canvas" });
    this.greetingCanvas = h("canvas", { id: "greeting-canvas" });
    this.miniGrid = h("div", { id: "mini-grid" });
    this.countdown = h("div", { id: "countdown" });

    this.buildTodo();

    this.header = buildHeader(actions);

    // The toggle takes its class from a native top-bar button, so its size,
    // circular background, padding and hover state are the island's own, and it
    // sits right after the plus button.
    const buttons = Array.from(this.header.el.querySelectorAll("button"));
    const plusBtn =
      buttons.find((b) => /^\s*\+\s*$/.test(b.textContent ?? "")) ??
      buttons.find((b) =>
        /\b(add|new|plus)\b/i.test(`${b.title} ${b.getAttribute("aria-label") ?? ""} ${b.id}`),
      ) ??
      buttons[0];
    const todoBtn = h("button", { title: "To-do List" }) as HTMLButtonElement;
    // Same icon box as the native icon next to it; stroke follows the button's colour.
    const refSvg = plusBtn?.querySelector("svg");
    const iconPx = refSvg?.getAttribute("width") ?? "14";
    todoBtn.innerHTML =
      `<svg viewBox="0 0 24 24" width="${iconPx}" height="${iconPx}" fill="none" ` +
      `stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ` +
      `aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/>` +
      `<path d="M14 3v5h5"/><path d="M9 13h6"/><path d="M9 17h4"/></svg>`;
    if (plusBtn) {
      todoBtn.className = plusBtn.className;
      plusBtn.after(todoBtn);
    } else {
      this.header.el.append(todoBtn);
    }
    todoBtn.onclick = (e) => {
      e.stopPropagation();
      this.toggleTodo();
    };

    this.views = buildViews(actions, () => this.animateGeometry(false));
    this.viewsEl = h("div", { id: "views" });
    for (const v of this.views.values()) this.viewsEl.append(v.el);
    this.contentEl = h("div", { id: "content" }, this.header.el, this.viewsEl);

    this.uploadCanvas = new UploadCanvas({
      ask: () => {
        State.promptContext = State.droppedFile
          ? { kind: "file", name: State.droppedFile.name, path: State.droppedFile.path }
          : null;
        this.setView("prompt");
      },
      cancel: () => this.discardDrop(),
    });

    this.clipEl = h(
      "div",
      { id: "island-clip" },
      this.greetingCanvas,
      this.uploadCanvas.el,
      this.contentEl,
    );
    this.islandEl = h(
      "div",
      { id: "island" },
      this.clipEl,
      this.botGlow,
      this.botCanvas,
      this.miniGrid,
      this.countdown,
    );

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.greetingCanvas.width = Math.round(EXPANDED_W * dpr);
    this.greetingCanvas.height = Math.round(150 * dpr);
    this.greetingCanvas.style.width = `${EXPANDED_W}px`;
    this.greetingCanvas.style.height = "150px";

    // The widget lives on the root, not in the island: the island is transformed
    // and clipped, which would pin the widget to it.
    this.root.append(this.wakeStrip, this.islandEl, this.todoEl);
    this.applyGeometry();
  }

  private wireFsm() {
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    this.fsm.openOnHover = State.settings.openOnHover;
    this.fsm.onTransition = (from, to) => {
      if (from === "coucou" && to !== "coucou") this.desktop.launch();
      switch (to) {
        case "hidden":
          this.setMode("hidden");
          break;
        case "petit":
          if (from === "coucou") this.greeting.interrupt();
          else if (from === "hidden" && !this.silentReveal) Sound.play("peek");
          this.setMode("compact");
          if (from === "coucou") State.view = State.defaultView();
          if (!this.wasInIsland) this.fsm.mouseLeft();
          break;
        case "home":
          this.expand(State.defaultView());
          if (!this.wasInIsland) this.fsm.mouseLeft();
          void refreshHookPills();
          break;
        case "coucou":
          this.expand("greeting");
          this.greeting.start();
          break;
      }
      State.notify();
      if (from === "hidden") this.onWake?.();
    };
  }

  launch() {
    this.fsm.launch();
  }

  private setMode(mode: IslandMode) {
    const prev = State.mode;
    if (mode === prev) return;
    State.mode = mode;
    if (mode === "expanded") Sound.play("open");
    if (prev === "expanded") {
      Sound.play("close");
      if (!State.pendingApproval) State.isPinned = false;
      void Bridge.focusWindow(false);
    }
    if (mode !== "expanded") {
      closePlanCard();
      this.engine.resetMorph();
      UploadSeq.deactivate();
    }
    // A hidden island shrinks the window to the wake strip: nothing of the
    // widget could be seen or reached any more.
    if (mode === "hidden") {
      this.closeTodo();
      // The wake strip is always top-centre: so is the island when it comes back.
      this.islandOffset = { x: 0, y: 0 };
      this.islandPress = null;
      this.islandDragging = false;
    }
    this.updateWindowCollapsed();
    this.animateGeometry(modeOrder(mode) < modeOrder(prev));
    State.notify();
  }

  private get uploadActive(): boolean {
    return State.mode === "expanded" && UploadSeq.isActive && UPLOAD_VIEWS.has(State.view);
  }

  private stopSequenceIfLeaving(view: IslandViewName) {
    if (UploadSeq.isActive && !UPLOAD_VIEWS.has(view)) UploadSeq.deactivate();
  }

  expand(view: IslandViewName) {
    this.stopSequenceIfLeaving(view);
    if (view !== "overview") closePlanCard();
    State.view = view;
    if (State.mode !== "expanded") this.setMode("expanded");
    else this.animateGeometry(false);
    State.lastActivity = performance.now();
    State.notify();
  }

  setView(view: IslandViewName) {
    this.stopSequenceIfLeaving(view);
    if (view !== "overview") closePlanCard();
    if (State.mode !== "expanded") {
      this.fsm.forceHome();
      State.view = view;
      this.animateGeometry(false);
      State.notify();
      return;
    }
    const grew = VIEW_LAYOUTS[view].height >= VIEW_LAYOUTS[State.view].height;
    State.view = view;
    State.lastActivity = performance.now();
    this.animateGeometry(!grew);
    State.notify();
  }

  collapse() {
    if (State.pendingApproval) {
      this.foldApproval();
      return;
    }
    State.isPinned = false;
    this.fsm.pinned = false;
    this.fsm.forcePetit();
  }

  alert(view: IslandViewName) {
    this.fsm.pinned = State.isPinned;
    this.fsm.forceHome();
    this.expand(view);
  }

  reveal() {
    this.fsm.reveal();
  }

  revealSilently() {
    this.silentReveal = true;
    this.fsm.reveal();
    this.silentReveal = false;
  }

  toggleWardrobe() {
    if (State.paused || State.mode === "hidden") return;
    if (State.mode === "expanded" && (State.view === "greeting" || this.uploadActive)) return;
    if (State.mode === "expanded" && State.view === "wardrobe") this.setView(State.defaultView());
    else this.setView("wardrobe");
  }

  wardrobeFromDesktop() {
    this.wardrobeAnywhere();
  }

  wardrobeAnywhere() {
    if (State.mode === "expanded" && State.view === "wardrobe") {
      this.setView(State.defaultView());
      return;
    }
    if (State.paused) return;
    this.alert("wardrobe");
  }

  dropPin() {
    this.fsm.pinned = false;
    if (!this.wasInIsland) this.fsm.mouseLeft();
  }

  emote(name: BotEmoteName) {
    this.engine.triggerEmote(name);
    this.ensureRunning();
  }

  setPinned(on: boolean) {
    State.isPinned = on;
    this.fsm.pinned = on;
    if (on) {
      this.fsm.cancelTimers();
    } else if (!this.wasInIsland && this.fsm.state === "home") {
      this.fsm.mouseLeft();
    }
    State.notify();
  }

  takeKeyboard() {
    void Bridge.focusWindow(true);
  }

  canLeaveIsland(): boolean {
    return this.desktop.supported;
  }

  flyOutOrHome() {
    const busy = State.mode === "expanded" && (State.view === "greeting" || this.uploadActive);
    if (busy && !State.mochiOnDesktop) return;
    this.desktop.flyOutOrHome();
  }

  viewCommand(command: ViewCommand) {
    this.views.get(State.view)?.command?.(command);
  }

  private onDragDrop(e: { type: string; paths?: string[] }) {
    if (e.type !== "over") void Bridge.log(`drag ${e.type} ${e.paths?.length ?? 0} file(s)`);
    if (State.paused) return;
    switch (e.type) {
      case "enter":
      case "over": {
        if (State.fileDragOver) return;
        State.fileDragOver = true;
        this.engine.animateMorph(1);
        UploadSeq.enterZone(State.mouseInIsland.x, State.mouseInIsland.y);
        this.alert("upload");
        break;
      }
      case "leave": {
        if (!State.fileDragOver) return;
        State.fileDragOver = false;
        this.engine.animateMorph(0);
        UploadSeq.exitZone();
        State.notify();
        break;
      }
      case "drop": {
        State.fileDragOver = false;
        const path = e.paths?.[0];
        if (!path) {
          this.engine.animateMorph(0);
          this.setView(State.defaultView());
          return;
        }
        this.swallow(path);
        break;
      }
    }
  }

  private swallow(path: string) {
    const name = path.split(/[\\/]/).pop() || "file";
    State.droppedFile = { name, path };
    State.promptContext = { kind: "file", name, path };
    State.chatHistory = [];
    void Bridge.chatReset();

    UploadSeq.performDrop(State.uploadDuration);
    this.uploadTens = 0;
    this.uploadDone = false;

    this.engine.gulp();
    Sound.play("approve");
    this.engine.triggerEmote("happy");
    this.engine.animateMorph(0);

    State.uploadProgress = 0;
    this.setView("uploading");
    this.ensureRunning();

    void Bridge.ingestFile(path)
      .then((file) => {
        if (State.droppedFile?.path !== path) return;
        State.droppedFile = { name: file.name, path: file.path };
        State.promptContext = { kind: "file", name: file.name, path: file.path };
        State.notify();
      })
      .catch((err) => {
        if (State.droppedFile?.path !== path) return;
        UploadSeq.deactivate();
        State.noteMessage = String(err).replace(/^Error:\s*/, "");
        this.engine.animateMorph(0);
        this.setView("note");
        Sound.play("error");
        window.setTimeout(() => this.setView(State.defaultView()), 2400);
      });
  }

  private discardDrop() {
    State.droppedFile = null;
    State.promptContext = null;
    this.setView(State.defaultView());
  }

  private stepSequence() {
    const since = UploadSeq.sinceDrop();
    if (since == null) return;
    const dur = State.uploadDuration;
    const p = Math.max(0, Math.min(1, (since - PRE_PROGRESS) / dur));

    const tens = Math.floor(p * 10);
    if (tens > this.uploadTens && tens < 10) {
      this.uploadTens = tens;
      Sound.play("tick");
    }

    if (!this.uploadDone && since >= PRE_PROGRESS + dur) {
      this.uploadDone = true;
      Sound.play("approve");
      this.engine.triggerEmote("happy");
    }
    if (since >= PRE_PROGRESS + dur + 1 && State.view === "uploading") {
      this.setView("choose");
    }
  }

  private targetSize(): { w: number; h: number; r: number } {
    let { w, h } = islandSize(State.mode, State.view, State.chatHistory.length);
    if (State.mode === "expanded" && State.view === "question" && State.pendingApproval?.questions) {
      h = QUESTION_PICKER_H;
    }
    const r = State.mode === "expanded" ? EXPANDED_CORNER : ROUNDED_CORNER;
    return { w, h, r };
  }

  private animateGeometry(shrinking: boolean) {
    const { w, h, r } = this.targetSize();
    if (shrinking) {
      this.width.curveTowards(w);
      this.height.curveTowards(h);
      this.radius.curveTowards(r);
    } else {
      this.width.springTo(w);
      this.height.springTo(h);
      this.radius.springTo(r);
    }
    this.ensureRunning();
  }

  private applyGeometry() {
    const w = this.width.value;
    const hh = this.height.value;
    const r = this.radius.value;
    this.islandEl.style.width = `${w}px`;
    this.islandEl.style.height = `${hh}px`;
    this.islandEl.style.borderRadius = `0 0 ${r}px ${r}px`;
    this.clampIslandOffset(w, hh);
    this.islandEl.style.left = `calc(50% + ${this.islandOffset.x}px)`;
    this.islandEl.style.top = `${this.islandOffset.y}px`;
    this.islandEl.style.transform = `translateX(-50%)`;
    this.miniGrid.style.left = `${w - 40 - 14.5}px`;
    this.miniGrid.style.top = `${hh / 2 - 14.5}px`;
    this.greetingCanvas.style.left = `${(w - EXPANDED_W) / 2}px`;
    this.uploadCanvas.el.style.left = `${(w - EXPANDED_W) / 2}px`;

    const rect = this.islandRect();
    const p = this.pushedRect;
    if (
      Math.abs(p.x - rect.x) > 0.5 || Math.abs(p.y - rect.y) > 0.5 ||
      Math.abs(p.w - rect.w) > 0.5 || Math.abs(p.h - rect.h) > 0.5
    ) {
      this.pushedRect = rect;
      void Bridge.setIslandRect(rect.x, rect.y, rect.w, rect.h);
    }
  }

  private islandRect(): { x: number; y: number; w: number; h: number } {
    const w = this.width.value;
    const hh = this.height.value;
    return {
      x: (this.viewW() - w) / 2 + this.islandOffset.x,
      y: this.islandOffset.y,
      w,
      h: hh,
    };
  }

  /// Keeps the whole island on the display, whatever its size right now.
  private clampIslandOffset(w: number, hh: number) {
    const maxX = Math.max(0, (this.viewW() - w) / 2);
    const maxY = Math.max(0, (window.innerHeight || PANEL_H) - hh);
    this.islandOffset = {
      x: clamp(this.islandOffset.x, -maxX, maxX),
      y: clamp(this.islandOffset.y, 0, maxY),
    };
  }

  private canDragIsland(): boolean {
    if (State.mode === "hidden") return false;
    return !(State.mode === "expanded" && (State.view === "greeting" || this.uploadActive));
  }

  private updateWindowCollapsed() {
    if (this.collapseTimer != null) {
      window.clearTimeout(this.collapseTimer);
      this.collapseTimer = null;
    }
    if (State.mode === "hidden") {
      this.collapseTimer = window.setTimeout(() => {
        this.collapseTimer = null;
        if (State.mode !== "hidden") return;
        this.collapsed = true;
        void Bridge.setCollapsed(true);
      }, 420);
    } else if (this.collapsed) {
      this.collapsed = false;
      void Bridge.setCollapsed(false);
    }
  }

  private wireInput() {
    this.wakeStrip.addEventListener("mouseenter", () => {
      Sound.resume();
      if (State.mode === "hidden") this.fsm.mouseEntered();
    });

    // The window changes size between the wake strip and the whole display: the
    // island's place in it moves with it, so Rust is told again.
    window.addEventListener("resize", () => {
      this.pushedRect = { x: -1, y: -1, w: -1, h: -1 };
      this.pushTodoRect();
      this.dirty = true;
      this.ensureRunning();
    });

    this.islandEl.addEventListener("mousedown", (e) => {
      Sound.resume();
      State.lastActivity = performance.now();
      this.fsm.userInteracted();
      if (e.button === 0 && this.isBotHit(e.clientX, e.clientY)) {
        this.botPress = { x: e.clientX, y: e.clientY };
      }
      // Empty island space (not a control, not Mochi) drags the whole island.
      const target = e.target as HTMLElement | null;
      if (
        e.button === 0 &&
        this.canDragIsland() &&
        !this.isBotHit(e.clientX, e.clientY) &&
        !target?.closest("button, input, textarea, select, a, [contenteditable], [data-nodrag]")
      ) {
        this.islandPress = {
          x: e.clientX,
          y: e.clientY,
          ox: this.islandOffset.x,
          oy: this.islandOffset.y,
        };
      }
      if (e.button === 2 && this.isBotHit(e.clientX, e.clientY)) {
        this.cancelBotHover();
        this.toggleWardrobe();
        return;
      }
      if (State.mode !== "expanded") {
        this.fsm.click();
        return;
      }
      if (this.isBotHit(e.clientX, e.clientY)) {
        this.cancelBotHover();
        this.engine.slap();
      }
    });

    this.islandEl.addEventListener("contextmenu", (e) => {
      if (this.isBotHit(e.clientX, e.clientY)) e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (this.desktop.carrying) {
        this.desktop.carry(e.clientX, e.clientY);
        return;
      }
      const grab = this.islandPress;
      if (grab) {
        if (!(e.buttons & 1)) {
          this.islandPress = null;
          this.islandDragging = false;
        } else if (
          this.islandDragging ||
          Math.hypot(e.clientX - grab.x, e.clientY - grab.y) > DRAG_THRESHOLD
        ) {
          this.islandDragging = true;
          this.islandOffset = { x: grab.ox + e.clientX - grab.x, y: grab.oy + e.clientY - grab.y };
          this.applyGeometry();
          this.ensureRunning();
          return;
        }
      }
      const press = this.botPress;
      if (!press) return;
      if (!(e.buttons & 1)) {
        this.botPress = null;
        return;
      }
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) <= DRAG_THRESHOLD) return;
      this.botPress = null;
      if (!this.canDragOut()) return;
      this.cancelBotHover();
      this.desktop.pickUp(e.clientX, e.clientY);
    });
    window.addEventListener("mouseup", (e) => {
      this.botPress = null;
      this.islandPress = null;
      if (this.islandDragging) {
        this.islandDragging = false;
        // The release that ends a drag is not a click on whatever is underneath.
        const swallowClick = (ev: Event) => ev.stopPropagation();
        window.addEventListener("click", swallowClick, { capture: true, once: true });
        window.setTimeout(() => window.removeEventListener("click", swallowClick, true), 0);
      }
      if (this.desktop.carrying) this.desktop.carryEnd(e.clientX, e.clientY);
    });

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && State.mode === "expanded") {
        if (State.pendingApproval) this.foldApproval();
        else if (!State.isPinned) this.collapse();
      }
      State.lastActivity = performance.now();
    });

    void onDragDrop((e) => this.onDragDrop(e));

    if (!IS_TAURI) this.followPageCursor();
  }

  followPageCursor() {
    window.addEventListener("mousemove", (e) => this.onCursor(e.clientX, e.clientY));
    window.addEventListener("mouseout", (e) => {
      if (e.relatedTarget == null) this.onCursor(-10_000, -10_000);
    });
  }

  private pointerInside: boolean | null = null;

  setPointerInside(inside: boolean) {
    this.pointerInside = inside;
  }

  onCursor(x: number, y: number) {
    if (this.pointerInside === false) {
      x = -10_000;
      y = -10_000;
    }
    State.mouse = { x, y };
    const rect = this.islandRect();
    State.mouseInIsland = { x: x - rect.x, y: y - rect.y };

    if (UploadSeq.isActive && !UploadSeq.dropped) {
      UploadSeq.updateCursor(State.mouseInIsland.x, State.mouseInIsland.y);
    }

    const inIsland =
      x >= rect.x - HIT_MARGIN && x <= rect.x + rect.w + HIT_MARGIN &&
      y >= rect.y - HIT_MARGIN && y <= rect.y + rect.h + HIT_MARGIN;

    const wasIn = this.wasInIsland;
    this.wasInIsland = inIsland;
    if (inIsland && !wasIn) {
      if (this.fsm.state === "coucou") this.greeting.hover();
      this.fsm.mouseEntered();
    }
    if (!inIsland && wasIn) {
      this.fsm.mouseLeft();
    }

    const overBot = State.mode === "expanded" && State.stateOverride == null && this.isBotHit(x, y);
    if (overBot && !this.botHovering) this.botHoverIn(x, y);
    if (!overBot && this.botHovering) this.cancelBotHover();
    this.botHovering = overBot;
    if (this.botHovering) {
      const d = Math.hypot(x - this.botHoverStart.x, y - this.botHoverStart.y);
      if (d > 40) {
        this.botHoverStart = { x, y };
        this.scheduleLove();
      }
    }

    this.ensureRunning();
  }

  private canDragOut(): boolean {
    if (State.mode === "hidden" || !this.desktop.canPickUp()) return false;
    return !(State.mode === "expanded" && (State.view === "greeting" || this.uploadActive));
  }

  private isBotHit(x: number, y: number): boolean {
    if (State.mochiOnDesktop) return false;
    const rect = this.islandRect();
    const cx = rect.x + this.botCx.value;
    const cy = rect.y + this.botCy.value;
    const radius = this.botSize.value / 2;
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
  }

  private botHoverIn(x: number, y: number) {
    if (performance.now() / 1000 - this.lastLoveTime < 6) return;
    this.botHoverStart = { x, y };
    this.engine.blink();
    this.engine.tgEs = 1.08;
    Sound.play("hover");
    this.scheduleLove();
  }

  private scheduleLove() {
    if (this.botHoverTimer != null) window.clearTimeout(this.botHoverTimer);
    this.botHoverTimer = window.setTimeout(() => {
      this.botHoverTimer = null;
      if (!this.botHovering || State.stateOverride != null) return;
      if (performance.now() / 1000 - this.lastLoveTime < 6) return;
      this.lastLoveTime = performance.now() / 1000;
      this.engine.triggerEmote("love");
      Sound.play("love");
    }, 1900);
  }

  private cancelBotHover() {
    if (this.botHoverTimer != null) window.clearTimeout(this.botHoverTimer);
    this.botHoverTimer = null;
    this.engine.tgEs = 1;
  }

  handleDizzy() {
    this.prevViewBeforeConfused = State.view;
    State.stateOverride = "dizzy";
    this.engine.setState("dizzy");
    Sound.play("dizzy");
    this.alert("confused");
    if (this.confusedRecovery != null) window.clearTimeout(this.confusedRecovery);
    this.confusedRecovery = window.setTimeout(() => {
      this.confusedRecovery = null;
      State.stateOverride = null;
      this.engine.setState(State.effectiveState);
      if (State.view === "confused") {
        const fallback = State.defaultView();
        this.setView(this.prevViewBeforeConfused === "confused" ? fallback : this.prevViewBeforeConfused);
      }
      this.engine.triggerEmote("happy");
    }, 3300);
  }

  ensureRunning() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    requestAnimationFrame(this.frame);
  }

  private frame = (nowMs: number) => {
    const dt = Math.min(0.05, (nowMs - this.lastFrame) / 1000);
    this.lastFrame = nowMs;

    this.width.step(dt, nowMs);
    this.height.step(dt, nowMs);
    this.radius.step(dt, nowMs);
    this.applyGeometry();

    if (this.dirty) {
      this.dirty = false;
      this.syncDom();
    }

    this.updateBotTargets();
    this.botCx.step(dt);
    this.botCy.step(dt);
    this.botSize.step(dt);

    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    if (greetingActive) {
      const gctx = this.greetingCanvas.getContext("2d");
      if (gctx) {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.greeting.draw(gctx);
      }
    } else {
      this.drawBot(dt);
    }

    const uploadActive = this.uploadActive;
    if (uploadActive) this.uploadCanvas.draw(UploadSeq.frame(), nowMs / 1000);
    this.uploadCanvas.el.classList.toggle("on", uploadActive);
    this.viewsEl.classList.toggle("hidden-by-upload", uploadActive);

    tickMiniBots(dt);
    const viewAnimating = this.views.get(State.view)?.tick?.(nowMs) === true;
    if (UploadSeq.isActive) this.stepSequence();
    this.updateCountdown(nowMs);

    const settling =
      this.width.animating || this.height.animating || this.radius.animating;
    const busy = State.mode === "hidden"
      ? settling
      : settling ||
        !this.botCx.settled || !this.botCy.settled || !this.botSize.settled ||
        greetingActive || this.engine.busy || UploadSeq.isActive || viewAnimating;

    if (busy) {
      requestAnimationFrame(this.frame);
    } else {
      this.running = false;
      Sound.idle();
    }
  };

  private updateBotTargets() {
    const p = botPosition(State.mode, State.view, this.height.value, State.uploadProgress);
    this.botCx.target = p.cx;
    this.botCy.target = p.cy;
    this.botSize.target = p.diameter / 0.6;

    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    const away = State.mochiOnDesktop;
    const visible = p.opacity > 0 && !greetingActive && !this.uploadActive && !away;
    this.botCanvas.style.opacity = visible ? "1" : "0";

    if (State.mode === "expanded" && State.view !== "uploading" && !greetingActive && !this.uploadActive && !away) {
      const d = p.diameter;
      const color = botGlowColor(State.effectiveState);
      this.botGlow.style.display = "block";
      this.botGlow.style.width = `${d * 2.2}px`;
      this.botGlow.style.height = `${d * 2.2}px`;
      this.botGlow.style.left = `${this.botCx.value - d * 1.1}px`;
      this.botGlow.style.top = `${this.botCy.value - d * 1.1}px`;
      this.botGlow.style.background = `radial-gradient(circle, ${color} 0%, transparent 62%)`;
      this.botGlow.style.opacity = String(botGlowOpacity(State.effectiveState));
    } else {
      this.botGlow.style.display = "none";
    }
  }

  private drawBot(dt: number) {
    const size = this.botSize.value;
    const w = Math.max(1, Math.round(size));
    const hCss = w + BOT_OVERHANG;
    const wCss = w + BOT_SIDE * 2;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.canvasPx !== w) {
      this.canvasPx = w;
      this.botCanvas.width = Math.round(wCss * dpr);
      this.botCanvas.height = Math.round(hCss * dpr);
      this.botCanvas.style.width = `${wCss}px`;
      this.botCanvas.style.height = `${hCss}px`;
    }
    this.botCanvas.style.left = `${this.botCx.value - wCss / 2}px`;
    this.botCanvas.style.top = `${this.botCy.value - BOT_OVERHANG / 2 - hCss / 2}px`;

    const ctx = this.botCanvas.getContext("2d");
    if (!ctx) return;

    const focus = State.focusTask;
    this.engine.bodyColor = planCardOpen()
      ? hexToRGB(openPlanColor())
      : focus?.isIntegration && focus.id !== "integration_vscode"
        ? hexToRGB(focus.color)
        : null;
    this.engine.particleOverhang = BOT_OVERHANG;
    this.engine.lookX = this.lookX();
    this.engine.lookY = this.lookY();
    if (this.engine.morph > 0.3) {
      this.engine.slotHTarget = State.fileDragOver ? 0.2 : 0;
    } else {
      this.engine.slotHTarget = 0;
      if (this.engine.morph < 0.05) {
        this.engine.slotH = 0;
        this.engine.slotHVel = 0;
      }
    }
    const inWardrobe = State.mode === "expanded" && State.view === "wardrobe";
    const outfit = State.wardrobePreview ?? this.seasons.get(parseOutfit(State.focusedMochiOutfit));
    this.engine.setOutfit(outfit, !inWardrobe);
    this.engine.update(dt);
    ctx.setTransform(dpr, 0, 0, dpr, BOT_SIDE * dpr, 0);
    ctx.clearRect(-BOT_SIDE, 0, wCss, hCss);
    ctx.save();
    this.engine.draw(ctx, w, hCss);
    ctx.restore();
  }

  private lookX(): number {
    const rect = this.islandRect();
    const botScreenX = rect.x + this.botCx.value;
    return Math.tanh((State.mouse.x - botScreenX) / 260);
  }

  private lookY(): number {
    return -Math.tanh((State.mouse.y - (this.islandRect().y + this.botCy.value)) / 200);
  }

  private updateCountdown(nowMs: number) {
    const dueAt = this.fsm.homeCollapseDueAt;
    if (State.mode !== "expanded" || State.isPinned || dueAt == null) {
      this.countdown.style.width = "0px";
      return;
    }
    const autoClose = this.fsm.homeToPetitDelay;
    const windowS = Math.min(10, autoClose * 0.6);
    const remaining = (dueAt - nowMs) / 1000;
    this.countdown.style.width =
      remaining < windowS ? `${Math.max(0, clamp(remaining / windowS, 0, 1) * 160)}px` : "0px";
  }

  private syncDom() {
    const expanded = State.mode === "expanded";
    const greetingActive = expanded && State.view === "greeting";

    const live = expanded && !greetingActive;
    this.contentEl.style.opacity = live ? "1" : "0";
    this.contentEl.style.pointerEvents = live && !this.uploadActive ? "auto" : "none";
    this.header.el.style.pointerEvents = live ? "auto" : "none";
    this.greetingCanvas.style.display = greetingActive ? "block" : "none";

    if (this.greetingShown && !greetingActive) this.greeting.leave();
    this.greetingShown = greetingActive;
    if (State.wardrobePreview && !(expanded && State.view === "wardrobe")) State.wardrobePreview = null;

    this.header.sync();
    for (const [name, view] of this.views) {
      const on = name === State.view;
      view.el.classList.toggle("on", on);
      if (on) view.sync();
    }

    if (this.lastSyncedView !== State.view) {
      const wasChat = this.lastSyncedView === "prompt";
      this.lastSyncedView = State.view;
      if (State.view === "prompt") {
        void Bridge.focusWindow(true);
        window.setTimeout(() => this.views.get("prompt")?.focus?.(), 120);
      } else if (wasChat) {
        void Bridge.focusWindow(false);
      }
    }

    const showGrid = State.mode === "compact";
    this.miniGrid.style.opacity = showGrid ? "1" : "0";
    if (showGrid) {
      const others = State.tasks.slice(0, 4);
      const key = others.map((t) => t.id).join("|");
      if (this.miniGrid.dataset.key !== key) {
        this.miniGrid.dataset.key = key;
        this.miniGrid.replaceChildren();
        for (const t of others) {
          this.miniGrid.append(createMiniBot(t, 13));
        }
        pruneMiniBots();
      }
    }

    syncMiniBotStates(State.tasks);
    this.engine.setState(State.effectiveState);
  }

  applySettings() {
    Sound.setEnabled(true);
    Sound.setVolume(0.6);
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    this.fsm.openOnHover = State.settings.openOnHover;
    State.notify();
  }

  get panelSize() {
    return { w: this.viewW(), h: window.innerHeight || PANEL_H };
  }

  get chatHeight() {
    return chatPromptHeight(State.chatHistory.length);
  }
}
