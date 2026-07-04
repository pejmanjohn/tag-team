# /admin UI implementation evidence

Status: implemented and command-verified, except browser screenshot capture was blocked by this sandbox.

Scope:

- `GET /admin` serves one self-contained Hono HTML document with inline CSS/JS.
- `/admin` and `/admin/api/*` fail closed behind `FLUE_ADMIN_TOKEN`.
- Admin auth accepts `Authorization: Bearer <token>` and one-time `?token=` login that sets an HttpOnly `flue_admin` cookie.
- The page manages profiles, channel assignments, channel addendum text, and a read-only Access summary.
- The Access summary is read from `/admin/api/effective-config`, which uses the same runtime effective-config resolver consumed by the Slack thread agent.
- Provider credentials remain read-only status; no provider credential UI was added.

Verification run on 2026-07-03:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH \
FLUE_NODE_BIN=/opt/homebrew/opt/node@24/bin/node \
node --test --import tsx tests/admin-routes.test.ts
```

Result: 15/15 passed. Covered unset token 404, wrong token 401, bearer success, query-token cookie login, CRUD, free-text model acceptance, model suggestions, and effective-config addendum resolution.

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH \
FLUE_NODE_BIN=/opt/homebrew/opt/node@24/bin/node \
npm run verify:admin-ui
```

Result: 6/6 passed. The script mounted the real admin routes against SQLite, created a profile, created an addendum-bearing assignment, read effective config, edited the addendum, and confirmed the effective config changed in the same process without remounting routes.

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH \
FLUE_NODE_BIN=/opt/homebrew/opt/node@24/bin/node \
npm test
```

Result: green in this sandbox: 45 passed, 29 skipped, 0 failed. Skipped tests are listener-only fake-Slack/Lane-B tests guarded by `loopbackListenSkipReason()` because this environment denies `listen(127.0.0.1)` with `EPERM`; they still run in environments where loopback listening is available.

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH \
FLUE_NODE_BIN=/opt/homebrew/opt/node@24/bin/node \
npm run flue:build
```

Result: built `dist/server.mjs` for the Node target.

```bash
git diff --check
```

Result: clean.

Screenshot capture note:

- A preview HTML was generated at `tmp/admin-ui-preview.html` from the real `/admin` HTML and JSON responses from the real admin route module.
- Screenshot capture could not be completed in this sandbox:
  - Playwright MCP call was rejected by the environment.
  - Chrome and Brave headless exited `134` before writing screenshots.
  - `qlmanage` failed with `sandbox initialization failed`.
  - Chrome DevTools MCP timed out.
- Stage 4 live Slack/tunnel proof was intentionally skipped per the kickoff instruction; the human dress rehearsal owns that proof.
