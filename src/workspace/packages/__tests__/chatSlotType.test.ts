/**
 * The host port's chat-collapsed READ and the store's `setChatCollapsed` WRITE
 * must agree on which widget is "the chat": the manifest's `defaultOpen` slot
 * (`getDefaultChatWidgetType`), never a widget-type literal. A literal here is a
 * product name in the host that silently disagrees with the writer the day the
 * owning package renames its widget type — the reader then reports "collapsed"
 * forever while the writer keeps opening the real widget.
 *
 * A comment-stripped SOURCE scan: the reader is a React hook over the store, and
 * this suite runs in a node environment with no renderer.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

describe('the chat slot is the manifest defaultOpen widget, on both sides', () => {
  const port = read('../buildWorkspaceHostPort.ts');
  const store = read('../../store/workspaceStore.ts');

  it('the port reader names no widget type and asks the same helper the writer uses', () => {
    const reader = port.slice(port.indexOf('useChatCollapsed:'), port.indexOf('setChatCollapsed:'));
    expect(reader.length).toBeGreaterThan(0);
    expect(reader).toContain('getDefaultChatWidgetType()');
    expect(reader).not.toMatch(/['"]chat['"]/);
  });

  it('the store writer resolves the slot through the same helper (paired)', () => {
    const writer = store.slice(store.indexOf('setChatCollapsed({'), store.indexOf('exclusiveOpenWidget({'));
    expect(writer.length).toBeGreaterThan(0);
    expect(writer).toContain('getDefaultChatWidgetType()');
  });
});
