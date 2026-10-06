/**
 * The two appearance editors render the kernel `IconPicker` (the ONE picker —
 * no host icon vocabulary left), the project editor sends ONLY its identity
 * keys, and the pencil shows only where the PATCH's owner-strength floor
 * would pass. Rendered with `react-dom/server`: the host suite has no DOM, and
 * the kernel suite has no `react-dom` — this is where the picker's render rows live.
 */

import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IconPicker } from '@neuralis/package-system/client';
import { UserProfileEditor } from '../UserProfilePopup';
import { ProjectEditForm, canEditProjectIdentity, projectEditBody } from '../ProjectEditPopup';
import { AppearanceAvatar, appearanceImageUrl } from '../UserAvatar';
import type { AppearanceDraft } from '../appearanceEditor';

function draft(overrides: Partial<AppearanceDraft['value']> = {}): AppearanceDraft {
  const value = { iconName: 'Rocket', color: '#224466', image: null, ...overrides };
  return {
    value,
    onChange: () => undefined,
    background: 'filled',
    onBackground: () => undefined,
    imageSlot: { maxBytes: 262144, onUpload: () => undefined, onClear: () => undefined },
    preview: { iconName: value.iconName, color: value.color, imageUrl: value.image?.url ?? null },
    payload: async () => ({ iconName: value.iconName, color: value.color, background: 'filled' }),
  };
}

describe('the kernel IconPicker renders host-side', () => {
  it('search, category tabs, a listbox with the selected icon, swatches and the picture slot', () => {
    const html = renderToStaticMarkup(
      createElement(IconPicker, {
        value: { iconName: 'chart-line', color: '#224466', image: null },
        onChange: () => undefined,
        imageSlot: { maxBytes: 1024, onUpload: () => undefined, onClear: () => undefined },
      }),
    );
    expect(html).toContain('aria-label="Search icons"');
    expect(html).toContain('role="tablist"');
    expect(html).toContain('role="listbox"');
    // The kebab spelling is selected under its library name.
    expect(html).toMatch(/data-icon="ChartLine"[^>]*aria-selected="true"/);
    expect(html).toContain('Upload picture');
    expect(html).toContain('role="radiogroup"');
  });

  it('a stored picture previews `contain`-ed on the colour; compact hides preview and slot', () => {
    const withPicture = renderToStaticMarkup(
      createElement(IconPicker, {
        value: { iconName: 'Star', color: '#123456', image: { url: '/api/appearance/user/u/abc' } },
        onChange: () => undefined,
        imageSlot: { maxBytes: 1024, onUpload: () => undefined, onClear: () => undefined },
      }),
    );
    expect(withPicture).toContain('object-contain');
    expect(withPicture).toContain('background-color:#123456');
    expect(withPicture).toContain('Replace picture');
    const compact = renderToStaticMarkup(
      createElement(IconPicker, { value: { iconName: 'Star', color: null }, onChange: () => undefined, compact: true }),
    );
    expect(compact).not.toContain('Upload picture');
  });
});

describe('UserProfileEditor', () => {
  it('renders the picker with the suggested tab first and the live avatar', () => {
    const html = renderToStaticMarkup(createElement(UserProfileEditor, { userId: 'u1', userName: 'Ada', draft: draft() }));
    expect(html).toContain('aria-label="Search icons"');
    expect(html).toMatch(/role="tab"[^>]*>Suggested</);
    expect(html).toContain('aria-label="Ada"');
  });

  it('the host carries no icon vocabulary of its own any more', () => {
    const source = readFileSync(join(__dirname, '..', 'UserProfilePopup.tsx'), 'utf-8');
    expect(source).not.toMatch(/USER_ICON_KEYS|ICON_MAP\[/);
  });
});

describe('ProjectEditForm + the identity-only body', () => {
  it('renders name, description and the picker', () => {
    const html = renderToStaticMarkup(
      createElement(ProjectEditForm, {
        project: { id: 'p1', name: 'Atlas' },
        name: 'Atlas',
        description: 'Ops',
        onName: () => undefined,
        onDescription: () => undefined,
        draft: draft({ iconName: 'Briefcase' }),
      }),
    );
    expect(html).toContain('value="Atlas"');
    expect(html).toContain('>Ops</textarea>');
    expect(html).toContain('aria-label="Search icons"');
  });

  it('sends ONLY name/description/appearance, and only a changed name or description', () => {
    const project = { name: 'Atlas', description: 'Ops' };
    const body = projectEditBody(project, { name: 'Atlas', description: 'Ops' }, { iconName: 'Star', color: null, background: 'filled' });
    expect(Object.keys(body)).toEqual(['appearance']);
    const renamed = projectEditBody(project, { name: ' Atlas 2 ', description: 'Ops' }, null);
    expect(renamed).toEqual({ name: 'Atlas 2', appearance: null });
    expect(Object.keys(renamed).some((key) => ['members', 'roles', 'limits', 'agentOwnership'].includes(key))).toBe(false);
  });

  it('the pencil follows owner STRENGTH (priority), never the role name or canManageRoles', () => {
    const record = (role: string, priority: number, canManageRoles: boolean) => ({
      members: { u: { role } },
      roles: { [role]: { priority, canManageRoles } },
    }) as never;
    expect(canEditProjectIdentity(record('owner', 1, true), 'u')).toBe(true);
    expect(canEditProjectIdentity(record('founder', 1, false), 'u')).toBe(true);
    expect(canEditProjectIdentity(record('admin', 2, true), 'u')).toBe(false);
    expect(canEditProjectIdentity(record('owner', 1, true), 'someone-else')).toBe(false);
    expect(canEditProjectIdentity(null, 'u')).toBe(false);
  });
});

describe('AppearanceAvatar', () => {
  it('draws the picture contained ON the colour, so a transparent PNG shows the colour', () => {
    const html = renderToStaticMarkup(
      createElement(AppearanceAvatar, {
        appearance: { color: '#ff0000', imageUrl: appearanceImageUrl('project', 'p 1', 'ab') },
        seed: 'p1',
        label: 'Atlas',
      }),
    );
    expect(html).toContain('background-color:#ff0000');
    expect(html).toContain('object-fit:contain');
    expect(html).toContain('src="/api/appearance/project/p%201/ab"');
  });

  it('without a picture it draws the library icon, then the monogram', () => {
    expect(renderToStaticMarkup(createElement(AppearanceAvatar, { appearance: { iconName: 'shield' }, seed: 's', label: 'x' }))).toContain(
      'lucide-shield',
    );
    expect(renderToStaticMarkup(createElement(AppearanceAvatar, { appearance: null, seed: 's', label: 'x', monogram: 'Q' }))).toContain(
      '>Q</span>',
    );
  });
});

describe('the transparent background', () => {
  it('no tile: the icon drawn IN the colour; the default keeps the filled tile', () => {
    const clear = renderToStaticMarkup(
      createElement(AppearanceAvatar, { appearance: { iconName: 'Rocket', color: '#ff0000', background: 'transparent' }, seed: 'p1', label: 'Atlas' }),
    );
    expect(clear).toContain('color:#ff0000');
    expect(clear).not.toContain('background-color');
    expect(clear).not.toContain('text-white');
    const filled = renderToStaticMarkup(
      createElement(AppearanceAvatar, { appearance: { iconName: 'Rocket', color: '#ff0000' }, seed: 'p1', label: 'Atlas' }),
    );
    expect(filled).toContain('background-color:#ff0000');
  });

  it('a transparent picture shows on its own alpha — no colour behind it', () => {
    const html = renderToStaticMarkup(
      createElement(AppearanceAvatar, {
        appearance: { color: '#ff0000', imageUrl: appearanceImageUrl('user', 'u1', 'ab'), background: 'transparent' },
        seed: 'u1',
        label: 'Ada',
      }),
    );
    expect(html).toContain('object-fit:contain');
    expect(html).not.toContain('background-color');
  });

  it('both editors render the Tile / Transparent toggle beside the picker', () => {
    const user = renderToStaticMarkup(createElement(UserProfileEditor, { userId: 'u1', userName: 'Ada', draft: { ...draft(), background: 'transparent' } }));
    expect(user).toContain('aria-label="Background"');
    expect(user).toContain('aria-checked="true" title="No tile — the icon drawn in its colour"');
    expect(user).toContain('aria-checked="false" title="The icon on a tile of its colour"');
    const project = renderToStaticMarkup(
      createElement(ProjectEditForm, {
        project: { id: 'p1', name: 'Atlas' },
        name: 'Atlas',
        description: '',
        onName: () => undefined,
        onDescription: () => undefined,
        draft: draft(),
      }),
    );
    expect(project).toContain('aria-checked="true" title="The icon on a tile of its colour"');
  });
});
