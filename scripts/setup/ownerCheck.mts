/**
 * The credential gate of the destructive operator commands (`reset:vector`,
 * `neuralis:qdrant-upgrade`): a registered user's email and password, checked
 * against the bcrypt hash on disk. It runs on the host, before the app is
 * reachable (both commands exist for the moments it may not be), so it reads
 * the user records directly rather than asking the platform.
 *
 * It is a CONSENT check, not an authorization gate: any registered user's
 * credentials pass it, and no platform role is consulted. The boundary is the
 * host shell itself — whoever runs these commands can already read `.env` and
 * the storage. A platform-tier gate would be an owner decision.
 */

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import bcrypt from 'bcryptjs';
import { CliExit } from '../cli/registry.mts';
import { spell } from '../cli/spelling.mts';

export type OwnerRecord = {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
};

/** Throws with an operator-readable reason on any mismatch. */
export async function verifyOwnerCredentials(neuralisHome: string, email: string, password: string): Promise<OwnerRecord> {
  const dir = join(neuralisHome, 'app', 'users');
  if (!existsSync(dir)) {
    throw new Error(`No users directory at ${dir}. Run \`${spell('setup')}\` first.`);
  }
  const wanted = email.trim().toLowerCase();
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    const rec = JSON.parse(await readFile(join(dir, f), 'utf-8')) as OwnerRecord;
    if (rec.email?.toLowerCase() === wanted) {
      if (!(await bcrypt.compare(password, rec.passwordHash))) throw new Error('Invalid password.');
      return rec;
    }
  }
  throw new Error(`No user found with email ${wanted}.`);
}

/** The terminal these prompts talk to; tests pass their own streams. */
export type PromptIo = {
  input: NodeJS.ReadableStream & { isRaw?: boolean; setRawMode?: (mode: boolean) => unknown };
  output: NodeJS.WritableStream;
  terminal: boolean;
};

function defaultIo(): PromptIo {
  return { input: stdin, output: stdout, terminal: Boolean(stdin.isTTY) };
}

/**
 * One visible answer. The readline interface lives only for this question:
 * an interface left open on stdin keeps echoing every keystroke — including
 * the next, HIDDEN, answer — whatever `pause()` says. An input that ENDS with
 * no answer (a closed stdin, a pipe) answers `''`, so every consent gate built
 * on this refuses by default — `rl.question` alone never settles then.
 */
export async function askLine(prompt: string, io: PromptIo = defaultIo()): Promise<string> {
  const rl = createInterface({ input: io.input, output: io.output, terminal: io.terminal });
  const ended = new Promise<string>((resolve) => rl.once('close', () => resolve('')));
  try {
    return (await Promise.race([rl.question(`  ${prompt}: `), ended])).trim();
  } finally {
    rl.close();
  }
}

/**
 * Hidden terminal input: raw mode, one `*` per keystroke, Ctrl-C aborts the command. It
 * owns the input while it reads; no readline interface may be open on it. An input that
 * ENDS before Enter answers `''`, like `askLine`, so the gate refuses instead of hanging.
 */
export async function askHidden(prompt: string, io: PromptIo = defaultIo()): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const input = io.input;
    let value = '';
    const wasRaw = input.isRaw ?? false;
    // Raw mode BEFORE the prompt: a byte typed the moment the prompt appears must
    // never meet the terminal's cooked-mode echo.
    if (typeof input.setRawMode === 'function') input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    io.output.write(`  ${prompt}: `);
    const release = (): void => {
      if (typeof input.setRawMode === 'function') input.setRawMode(wasRaw);
      input.pause();
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
    };
    const onEnd = (): void => {
      release();
      io.output.write('\n');
      resolve('');
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\n' || ch === '\r' || ch === '\u0004') {
          release();
          io.output.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          release();
          reject(new CliExit(130, 'Interrupted.'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          if (value.length > 0) { value = value.slice(0, -1); io.output.write('\b \b'); }
        } else {
          value += ch;
          io.output.write('*');
        }
      }
    };
    input.on('data', onData);
    input.once('end', onEnd);
  });
}

/** Email (visible) then password (hidden), for the destructive commands' consent gate. */
export async function promptOwnerCredentials(io: PromptIo = defaultIo()): Promise<{ email: string; password: string }> {
  const email = await askLine('Owner email', io);
  const password = await askHidden('Owner password', io);
  return { email, password };
}
