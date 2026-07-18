import { defineConfig } from '@flue/cli/config';

export default defineConfig({
  // File-backed persistence via `src/db.ts` is only
  // supported on Node — the Cloudflare target rejects a custom db.ts (it uses
  // Durable Object SQLite automatically).
  target: 'node',
});

export const vite = {
  server: {
    watch: {
      // Default SQLite dev files live in tmp/. Ignore them and their WAL/SHM
      // sidecars so Flue watch mode does not reload on every DB write. Hidden
      // directories are ignored wholesale: they only ever hold local tool
      // state (.wrangler, editor/agent scratch), and a write there would
      // otherwise bounce the dev server.
      ignored: ['**/tmp/**', '**/.*/**'],
    },
  },
};
