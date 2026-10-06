import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  // `tsconfig.json` keeps `jsx: "preserve"` because Next compiles the JSX. The
  // test transform (Vite's Oxc) follows that setting unless told otherwise and
  // then cannot parse a `.tsx` module, so it compiles JSX itself here.
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    // `scripts/**` is in the DEFAULT run deliberately. `rebuild.test.mts` sat
    // outside the include for months and nothing ran it — green by absence, over
    // the wrapper whose bounded cleanup is what keeps the build cache off the
    // disk. An opt-in `test:scripts` reproduces that failure mode one level up,
    // so the suite runs where it cannot be forgotten. It is hermetic: a fake
    // `docker` on a temp PATH, a mkdtemp sandbox, no daemon contact.
    include: ['src/**/__tests__/**/*.test.ts', 'scripts/**/__tests__/**/*.test.mts'],
    clearMocks: true,
    restoreMocks: true,
  },
});
