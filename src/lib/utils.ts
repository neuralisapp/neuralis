import { randomUUID } from 'crypto';

export function generateId(): string {
  return randomUUID();
}

export function nowISO(): string {
  return new Date().toISOString();
}

export function slugify(text: string): string {
  return text
    // Decompose accented letters and drop the marks, so `Ügyfél` keeps its
    // letters (`ugyfel`) instead of losing them to the charset filter below.
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * The ONE derivation of a new project's base id, shared by the app and the setup
 * wizard. A name made only of characters the slug drops (`日本`) still yields a
 * usable id. Called at creation only: an existing project's id is never
 * re-derived from its name.
 */
export function projectIdFromName(name: string): string {
  return slugify(name) || 'project';
}
