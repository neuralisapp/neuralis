/**
 * The consent prompt of the destructive operator commands must never print
 * the password. A readline interface left open on the terminal echoes every
 * keystroke of the hidden answer that follows it, so each visible question
 * owns its interface only for its own answer.
 */

import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { promptOwnerCredentials, type PromptIo } from '../setup/ownerCheck.mts';

/** A fake TTY: raw mode is a no-op switch, the output is captured. */
function fakeTerminal(): { io: PromptIo; typed: (text: string) => void; screen: () => string } {
  const input = Object.assign(new PassThrough(), {
    isRaw: false,
    isTTY: true,
    setRawMode(mode: boolean) { input.isRaw = mode; return input; },
  });
  const output = new PassThrough();
  let screen = '';
  output.on('data', (d: Buffer) => { screen += d.toString(); });
  return {
    io: { input, output, terminal: true },
    typed: (text) => { input.write(text); },
    screen: () => screen,
  };
}

async function until(read: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !read(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(read()).toBe(true);
}

describe('the owner credential prompt', () => {
  it('echoes the email, and not one character of the password — only a mask', async () => {
    const term = fakeTerminal();
    const answer = promptOwnerCredentials(term.io);
    await until(() => term.screen().includes('Owner email'));
    term.typed('member@test.local\r');
    await until(() => term.screen().includes('Owner password'));
    const password = 'QZ9%qz7#';
    for (const ch of password) term.typed(ch);
    term.typed('\r');
    expect(await answer).toEqual({ email: 'member@test.local', password });
    const afterPrompt = term.screen().slice(term.screen().indexOf('Owner password'));
    for (const ch of password) expect(afterPrompt, `echoed ${ch}`).not.toContain(ch);
    expect(afterPrompt).toContain('*'.repeat(password.length));
  });
});
