/**
 * `maturity.json` — the published maturity labels, and the two host pages that repeat them.
 *
 * The JSON is the one source; `README.md` (the public repository page) and `DOCKERHUB.md` (the
 * image page) have identical bodies and a `## Maturity` table that repeats every displayed cell
 * subject. Reads only files under `neuralis/`, so it holds in the public clone too.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const hostRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

interface Subject {
  id: string;
  kind: string;
  title: string;
  label: string;
  score: number;
  gates: string[];
  summary: string;
  limits: string[];
}

interface Maturity {
  method: { weights: Record<string, number>; factors: Record<string, number>; bands: unknown[]; gates: Array<{ id: string }> };
  asOf: string;
  pages: Record<string, { form: string; ids?: string[] }>;
  subjects: Subject[];
}

const LABELS = ['stable', 'beta', 'preview', 'experimental', 'not available'];
const maturity = JSON.parse(readFileSync(join(hostRoot, 'maturity.json'), 'utf8')) as Maturity;

/** The body rows of the first table under `## Maturity`, as trimmed cells. */
function maturityRows(file: string): string[][] {
  const lines = readFileSync(join(hostRoot, file), 'utf8').split('\n');
  const start = lines.findIndex((l) => l.trim() === '## Maturity');
  expect(start, `${file} has a "## Maturity" section`).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  const table = lines.slice(start + 1, end < 0 ? undefined : end).filter((l) => l.startsWith('|'));
  return table.slice(2).map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));
}

describe('maturity.json', () => {
  it('keeps both authored host introductions byte-identical', () => {
    expect(readFileSync(join(hostRoot, 'README.md'), 'utf8')).toBe(readFileSync(join(hostRoot, 'DOCKERHUB.md'), 'utf8'));
  });
  it('has the published shape', () => {
    expect(maturity.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(maturity.method.weights).toEqual({ promise: 1, roadmap: 1, vision: 0.25 });
    expect(maturity.method.factors).toEqual({ works: 1, partial: 0.5, planned: 0 });
    expect(maturity.method.gates.map((g) => g.id)).toEqual(['G-a', 'G-b', 'G-c', 'G-d']);
    const ids = maturity.subjects.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of maturity.subjects) {
      expect(['package', 'topic']).toContain(s.kind);
      expect(LABELS).toContain(s.label);
      expect(Number.isInteger(s.score) && s.score % 5 === 0 && s.score >= 0 && s.score <= 100).toBe(true);
      expect(s.summary.length).toBeGreaterThan(0);
      expect(Array.isArray(s.limits) && s.limits.every((l) => typeof l === 'string' && l.length > 0)).toBe(true);
      expect(s.limits.length, `${s.id} limits`).toBeGreaterThanOrEqual(1);
      expect(s.limits.length, `${s.id} limits`).toBeLessThanOrEqual(4);
      for (const g of s.gates) expect(['G-a', 'G-b', 'G-c', 'G-d']).toContain(g);
    }
    for (const [page, spec] of Object.entries(maturity.pages)) {
      expect(['table', 'callout'], page).toContain(spec.form);
      for (const id of spec.ids ?? []) expect(ids, `${page} names ${id}`).toContain(id);
    }
  });

  for (const file of ['README.md', 'DOCKERHUB.md']) {
    it(`${file} repeats every subject in order, including its main limit and date`, () => {
      const rows = maturityRows(file);
      expect(rows).toHaveLength(maturity.subjects.length);
      expect(readFileSync(join(hostRoot, file), 'utf8')).toContain(`As of ${maturity.asOf}.`);
      for (const [index, s] of maturity.subjects.entries()) {
        expect(rows[index], `${file} row ${index}`).toEqual([s.title, s.label, s.score === null ? '—' : String(s.score), s.limits[0]]);
      }
    });
  }
});
