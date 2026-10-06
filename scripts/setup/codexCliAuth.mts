// Scripts never import src/** or a product package: the setup wizard's one-shot container has neither.
// Port of agent-core `providers/openai-codex/oauth/externalAuth.ts`, pinned by `__tests__/codexCliAuthDrift.test.mts`.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type ImportedCodexAuth = {
  blob: {
    access: string;
    refresh: string;
    expires: number;
    accountId: string;
    planType?: string;
    isFedramp: boolean;
    lastRefresh: number;
    provenance?: 'codex-cli-import';
    importedAt?: string;
  };
  sourcePath: string;
};

type CodexCliAuthFile = {
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
};

export async function readCodexCliAuth(
  codexHome = process.env.CODEX_HOME || join(process.env.HOME || '/root', '.codex'),
): Promise<ImportedCodexAuth | null> {
  const sourcePath = join(codexHome, 'auth.json');
  if (!existsSync(sourcePath)) return null;
  const raw = await readFile(sourcePath, 'utf-8');
  const parsed = JSON.parse(raw) as CodexCliAuthFile;
  const access = parsed.tokens?.access_token ?? '';
  const refresh = parsed.tokens?.refresh_token ?? '';
  if (!access || !refresh) return null;

  const accessPayload = parseJwtPayload(access);
  const idPayload = parsed.tokens?.id_token ? parseJwtPayload(parsed.tokens.id_token) : null;
  const authClaims = readAuthClaims(accessPayload) ?? readAuthClaims(idPayload);
  const accountId = typeof parsed.tokens?.account_id === 'string'
    ? parsed.tokens.account_id
    : typeof authClaims?.chatgpt_account_id === 'string'
      ? authClaims.chatgpt_account_id
      : '';
  if (!accountId) return null;

  const exp = typeof accessPayload?.exp === 'number' ? accessPayload.exp : null;
  if (!exp) return null;

  return {
    blob: {
      access,
      refresh,
      expires: exp,
      accountId,
      planType: typeof authClaims?.chatgpt_plan_type === 'string' ? authClaims.chatgpt_plan_type : undefined,
      isFedramp: authClaims?.chatgpt_account_is_fedramp === true,
      lastRefresh: parsed.last_refresh ? Date.parse(parsed.last_refresh) || Date.now() : Date.now(),
      provenance: 'codex-cli-import',
      importedAt: new Date().toISOString(),
    },
    sourcePath,
  };
}

function parseJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readAuthClaims(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!payload) return null;
  const auth = payload['https://api.openai.com/auth'];
  return auth && typeof auth === 'object' ? auth as Record<string, unknown> : null;
}
