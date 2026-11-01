// Just enough of a DOM for the views' helpers (views/dom.ts) to build nodes in
// Node. Writing `innerHTML` throws: a view that renders untrusted text must
// never parse it as markup, and a test that reaches for it fails loudly.

class FakeText {
  constructor(text) {
    this.nodeType = 3;
    this.data = String(text);
    this.parentNode = null;
  }
  get textContent() {
    return this.data;
  }
}

class FakeElement {
  constructor(tag, ns = null) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.namespaceURI = ns;
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = "";
    this.id = "";
    this.width = 100;
    this.height = 100;
    this.title = "";
    this.dataset = {};
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.style = { setProperty: (k, v) => (this.style[k] = v) };
    const el = this;
    this.classList = {
      add: (c) => (el.className = [...new Set([...el.className.split(" ").filter(Boolean), c])].join(" ")),
      remove: (c) => (el.className = el.className.split(" ").filter((x) => x && x !== c).join(" ")),
      contains: (c) => el.className.split(" ").includes(c),
      toggle: (c, on) => ((on ?? !el.classList.contains(c)) ? el.classList.add(c) : el.classList.remove(c)),
    };
  }
  set innerHTML(_) {
    throw new Error("innerHTML must never be used");
  }
  get innerHTML() {
    throw new Error("innerHTML must never be used");
  }
  set outerHTML(_) {
    throw new Error("outerHTML must never be used");
  }
  insertAdjacentHTML() {
    throw new Error("insertAdjacentHTML must never be used");
  }
  get parentElement() {
    return this.parentNode?.nodeType === 1 ? this.parentNode : null;
  }
  get children() {
    return this.childNodes.filter((n) => n.nodeType === 1);
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  get textContent() {
    return this.childNodes.map((n) => n.textContent).join("");
  }
  set textContent(text) {
    this.childNodes = [];
    if (text !== "") this.append(new FakeText(text));
  }
  setAttribute(k, v) {
    this.attributes.set(k, String(v));
    if (k === "id") this.id = String(v);
    if (k === "style" && typeof v === "string") {
      for (const rule of v.split(";")) {
        const [prop, val] = rule.split(":").map((s) => s.trim());
        if (prop && val) {
          const camel = prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
          this.style[camel] = val;
        }
      }
    }
  }
  getAttribute(k) {
    return this.attributes.get(k) ?? null;
  }
  removeAttribute(k) {
    this.attributes.delete(k);
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
  }
  setPointerCapture() {}
  addEventListener(type, fn) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  /** Calls the listeners of `type` with a minimal event. */
  fire(type) {
    const event = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
    for (const fn of this.listeners.get(type) ?? []) fn(event);
    return event;
  }
  append(...nodes) {
    for (const n of nodes) {
      const node = typeof n === "string" ? new FakeText(n) : n;
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }
  replaceChildren(...nodes) {
    this.childNodes = [];
    this.append(...nodes);
  }
  removeChild(node) {
    this.childNodes = this.childNodes.filter((n) => n !== node);
    return node;
  }
  remove() {
    this.parentNode?.removeChild(this);
  }
  /** `.a.b` class selectors only: the first descendant carrying every class. */
  closest(selector) {
    const tags = selector.split(",").map((s) => s.trim().toUpperCase());
    let curr = this;
    while (curr) {
      if (curr.tagName && tags.includes(curr.tagName)) return curr;
      curr = curr.parentNode;
    }
    return null;
  }
  getContext() {
    return {
      canvas: this,
      clearRect() {},
      fillRect() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      stroke() {},
      fill() {},
      arc() {},
      save() {},
      setTransform() {},
      getTransform() { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; },
      restore() {},
      scale() {},
      translate() {},
      rotate() {},
      drawImage() {},
      measureText() { return { width: 0 }; },
      createLinearGradient() { return { addColorStop() {} }; },
      createRadialGradient() { return { addColorStop() {} }; },
      clip() {},
      arcTo() {},
      closePath() {},
      quadraticCurveTo() {},
      bezierCurveTo() {},
    };
  }
  querySelectorAll(selector) {
    return this.find(selector);
  }
  after(...nodes) {
    if (!this.parentNode) return;
    const idx = this.parentNode.childNodes.indexOf(this);
    if (idx !== -1) {
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        n.parentNode = this.parentNode;
        this.parentNode.childNodes.splice(idx + 1 + i, 0, n);
      }
    }
  }
  querySelector(selector) {
    const wanted = selector.split(".").filter(Boolean);
    return [...this.walk()].find((e) => wanted.every((c) => e.classList.contains(c))) ?? null;
  }
  scrollIntoView() {}
  focus() {}
  select() {}
  /** Every descendant element, depth first. */
  *walk() {
    for (const c of this.children) {
      yield c;
      yield* c.walk();
    }
  }
  /** Descendants by tag name ("A") or class (".md-p"). */
  find(selector) {
    const match = selector.startsWith(".")
      ? (e) => e.classList.contains(selector.slice(1))
      : (e) => e.tagName === selector.toUpperCase();
    return [...this.walk()].filter(match);
  }
}

class FakePath2D {
  arc() {}
  rect() {}
  closePath() {}
  moveTo() {}
  lineTo() {}
  bezierCurveTo() {}
  quadraticCurveTo() {}
}

export function installFakeDom() {
  globalThis.Path2D = FakePath2D;
  globalThis.requestAnimationFrame = (fn) => fn();
  globalThis.document = {
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (ns, tag) => new FakeElement(tag, ns),
    createTextNode: (text) => new FakeText(text),
    documentElement: new FakeElement("html"),
    body: new FakeElement("body"),
  };
  return { root: () => new FakeElement("div") };
}
