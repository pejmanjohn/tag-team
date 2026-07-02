import { defineConfig } from '@flue/cli/config';

export default defineConfig({
  // Node target (Stage 4): file-backed persistence via `src/db.ts` is only
  // supported on Node — the Cloudflare target rejects a custom db.ts (it uses
  // Durable Object SQLite automatically).
  target: 'node',
});
