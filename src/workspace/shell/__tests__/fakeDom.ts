/**
 * A minimal DOM for the host suite's EFFECT rows. The host suite has no DOM
 * library (`react-dom/server` renders no effects and keeps no state), yet a
 * remount, an effect-held feed or a confirm that disarms itself only exist in
 * a mounted tree. This is just enough of the DOM for `react-dom/client` to
 * mount, update and unmount a tree in node — elements, text, attributes, a
 * `[data-x]`/tag `querySelectorAll`, zero-size rects — plus helpers that find
 * an element and call its React handler directly (no event dispatch).
 *
 * Install it BEFORE importing `react-dom/client` or any module that reads
 * `window` at import time.
 *
 * The workspace precedent is jsdom (an agent-core / brain-core devDependency,
 * selected per file with `// @vitest-environment jsdom`); this module exists
 * only because the host has no jsdom devDependency yet.
 */

import type { Root } from 'react-dom/client';

type Listener = (event: unknown) => void;

export class FakeNode {
  nodeType: number;
  nodeName: string;
  tagName: string;
  ownerDocument: FakeNode | null;
  namespaceURI = 'http://www.w3.org/1999/xhtml';
  childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  attributes: Record<string, string> = {};
  nodeValue: string | null = null;
  style: Record<string, unknown> & { setProperty: (k: string, v: string) => void; removeProperty: (k: string) => void };
  private text: string | null = null;
  private listeners: Record<string, Listener[]> = {};
  [key: string]: unknown;

  constructor(nodeType: number, name: string, doc: FakeNode | null) {
    this.nodeType = nodeType;
    this.nodeName = name;
    this.tagName = name;
    this.ownerDocument = doc;
    const style: Record<string, unknown> = {};
    this.style = Object.assign(style, {
      setProperty: (k: string, v: string) => { style[k] = v; },
      removeProperty: (k: string) => { delete style[k]; },
    });
  }

  get firstChild(): FakeNode | null { return this.childNodes[0] ?? null; }
  get lastChild(): FakeNode | null { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get nextSibling(): FakeNode | null {
    const parent = this.parentNode;
    return parent ? parent.childNodes[parent.childNodes.indexOf(this) + 1] ?? null : null;
  }

  appendChild(child: FakeNode): FakeNode {
    child.parentNode?.removeChild(child);
    this.childNodes.push(child);
    child.parentNode = this;
    this.text = null;
    return child;
  }

  insertBefore(child: FakeNode, ref: FakeNode | null): FakeNode {
    if (!ref) return this.appendChild(child);
    child.parentNode?.removeChild(child);
    this.childNodes.splice(this.childNodes.indexOf(ref), 0, child);
    child.parentNode = this;
    return child;
  }

  removeChild(child: FakeNode): FakeNode {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  setAttribute(name: string, value: unknown): void { this.attributes[name] = String(value); }
  removeAttribute(name: string): void { delete this.attributes[name]; }
  getAttribute(name: string): string | null { return this.attributes[name] ?? null; }
  hasAttribute(name: string): boolean { return name in this.attributes; }
  addEventListener(type: string, fn: Listener): void { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l !== fn);
  }
  get dataset(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(this.attributes)) {
      if (name.startsWith('data-')) out[name.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = value;
    }
    return out;
  }
  getBoundingClientRect(): { top: number; left: number; right: number; bottom: number; width: number; height: number; x: number; y: number } {
    return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
  }
  focus(): void { /* no focus model */ }
  blur(): void { /* no focus model */ }
  contains(other: FakeNode | null): boolean {
    for (let node = other; node; node = node.parentNode) if (node === this) return true;
    return false;
  }

  set textContent(value: string) {
    this.childNodes = [];
    this.text = value;
  }
  get textContent(): string {
    if (this.nodeType === 3) return this.nodeValue ?? '';
    if (this.text !== null) return this.text;
    return this.childNodes.map((child) => child.textContent).join('');
  }

  /** `tag`, `[attr]` or `[attr="value"]` — one simple selector, or a comma list of them. */
  querySelectorAll(selector: string): FakeNode[] {
    const tests = selector.split(',').map((part) => simpleSelector(part.trim()));
    return descendants(this).filter((node) => tests.some((test) => test(node)));
  }
  querySelector(selector: string): FakeNode | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

function simpleSelector(selector: string): (node: FakeNode) => boolean {
  const attr = /^\[([^\]=]+)(?:="([^"]*)")?\]$/.exec(selector);
  if (attr) {
    const [, name, value] = attr;
    return (node) => node.nodeType === 1 && name! in node.attributes && (value === undefined || node.attributes[name!] === value);
  }
  const tag = selector.toUpperCase();
  return (node) => node.nodeType === 1 && node.tagName === tag;
}

function descendants(root: FakeNode): FakeNode[] {
  const out: FakeNode[] = [];
  const walk = (node: FakeNode): void => {
    for (const child of node.childNodes) {
      out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

export type FakeDom = { document: FakeNode; container: FakeNode };

/** Install the fake DOM on `globalThis` (window = globalThis) with a working `localStorage`. */
export function installFakeDom(): FakeDom {
  const doc = new FakeNode(9, '#document', null);
  const make = (name: string): FakeNode => new FakeNode(1, name.toUpperCase(), doc);
  Object.assign(doc, {
    createElement: make,
    createElementNS: (_ns: string, name: string) => make(name),
    createTextNode: (value: string) => {
      const node = new FakeNode(3, '#text', doc);
      node.nodeValue = value;
      return node;
    },
    createComment: (value: string) => {
      const node = new FakeNode(8, '#comment', doc);
      node.nodeValue = value;
      return node;
    },
    defaultView: globalThis,
    activeElement: null,
  });
  const html = doc.appendChild(make('html'));
  const head = html.appendChild(make('head'));
  const body = html.appendChild(make('body'));
  Object.assign(doc, { documentElement: html, head, body });

  const store = new Map<string, string>();
  const g = globalThis as Record<string, unknown>;
  g.document = doc;
  g.window = globalThis;
  g.HTMLElement = FakeNode;
  g.HTMLIFrameElement = class {};
  g.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
  };
  const windowTarget = new EventTarget();
  g.addEventListener ??= windowTarget.addEventListener.bind(windowTarget);
  g.removeEventListener ??= windowTarget.removeEventListener.bind(windowTarget);
  g.dispatchEvent ??= windowTarget.dispatchEvent.bind(windowTarget);
  g.ResizeObserver ??= class { observe(): void {} unobserve(): void {} disconnect(): void {} };
  g.MutationObserver ??= class { observe(): void {} disconnect(): void {} takeRecords(): unknown[] { return []; } };
  g.requestAnimationFrame ??= (fn: (t: number) => void) => setTimeout(() => fn(Date.now()), 0);
  g.cancelAnimationFrame ??= (id: ReturnType<typeof setTimeout>) => clearTimeout(id);
  g.IS_REACT_ACT_ENVIRONMENT = true;
  const container = body.appendChild(make('div'));
  return { document: doc, container };
}

/** Every element under `root` whose own text (descendants included) is exactly `text`, innermost first. */
export function findByText(root: FakeNode, text: string, tag = 'BUTTON'): FakeNode[] {
  return root.querySelectorAll(tag).filter((node) => node.textContent.trim() === text);
}

/** Call an element's React `onClick` handler directly. */
export function click(node: FakeNode | undefined): void {
  if (!node) throw new Error('click: no element');
  const key = Object.keys(node).find((k) => k.startsWith('__reactProps$'));
  const props = key ? (node[key] as { onClick?: (event: unknown) => void }) : undefined;
  if (!props?.onClick) throw new Error(`click: <${node.tagName}> has no onClick`);
  props.onClick({ stopPropagation: () => undefined, preventDefault: () => undefined, currentTarget: node, target: node });
}

export type { Root };
