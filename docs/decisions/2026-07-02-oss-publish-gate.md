# OSS Publish Gate Decision

Date: 2026-07-02

Status: public export gated; publish only from a fresh squashed export

## Decision

The public repository must be created as a fresh squashed export, not by pushing
or mirroring this repository.

Mechanism:

1. Start from a clean committed private-repo `HEAD`.
2. Create a scratch tree with `git archive HEAD`.
3. Delete every path marked `exclude` in the export manifest below.
4. Run `npm run verify:oss-export`, which recreates the scratch tree, applies
   the manifest exclusions, runs the leak and binary checks, installs
   dependencies, runs the test suite, and runs the offline verification scripts.
5. Initialize a new public repository from that cleaned tree and create one
   initial commit.

This repository remains private development history and is never pushed to the
public remote. The deleted private seed-pack files existed in early history, so
file deletion in this repository is necessary but not sufficient for publishing.

`package.json` currently uses `git+https://github.com/slack-flue/slack-flue.git`
as the intended public repository URL. Treat that owner/name as a placeholder
until the launch task creates or confirms the real public repository.

`package.json` intentionally contains publish metadata and does not carry
`private:true` so the exported package metadata is correct. To protect the
private development repository, `prepublishOnly` runs
`scripts/guard-fresh-export-publish.mjs`, which refuses npm publish attempts
from any git checkout with more than one commit. A fresh squashed export with a
single initial commit passes that guard.

## Export Manifest

Default rule: keep source, fixtures, tests, package metadata, and runtime code
unless listed here. All current files under `docs/plans` and `docs/decisions`
are excluded from the first public export. They are useful private execution
records, but they are not launch documentation.

`Claude Tag` is an internal Anthropic project name in this repository's planning
history. Any `docs/plans` filename containing `claude-tag` is default-excluded.
Public positioning and comparison wording belong to the README launch task.

| Path | Export | Reason |
| --- | --- | --- |
| `docs/plans/2026-06-29-002-feat-slack-agent-markdown-plan.md` | exclude | Historical plan mentions the private source project name and live workspace proof. |
| `docs/plans/2026-06-29-002-feat-slack-assistant-ux-plan.md` | exclude | References deleted `docs/source` material and live Paperplane Labs canary details. |
| `docs/plans/2026-06-29-003-feat-open-source-claude-tag-workspace-plan.md` | exclude | Filename/title use internal Anthropic project naming and it references deleted `docs/source` material. |
| `docs/plans/2026-06-29-slack-flue-vertical-slice-plan.md` | exclude | Historical seed-pack plan uses private source-project framing. |
| `docs/plans/2026-06-30-001-feat-slack-thread-dm-parity-plan.md` | exclude | Internal parity plan depends on Anthropic product-comparison framing that needs public rewrite. |
| `docs/plans/2026-07-01-improvement-plan.html` | exclude | Internal architecture-review artifact references private charter/source context and old local evidence. |
| `docs/plans/goal-g-port.md` | exclude | Internal goal prompt, not public launch documentation. |
| `docs/decisions/2026-06-29-slack-assistant-ux-decision.md` | exclude | Contains live workspace names, canary details, and deleted screenshot references. |
| `docs/decisions/2026-06-29-slack-flue-vertical-slice-decision.md` | exclude | Contains private source-project comparisons and old provider evidence. |
| `docs/decisions/2026-07-01-g-port-flue-port-record.md` | exclude | Private port record links to internal evidence artifacts that are excluded. |
| `docs/decisions/2026-07-02-oss-publish-gate.md` | exclude | Private publish-process record intentionally names excluded internal source families. |
| `docs/decisions/artifacts/g-port-stage4/durability-run.log` | exclude | Generated local evidence log with private machine paths. |
| `docs/decisions/artifacts/g-port-stage4/durability-transcript.json` | exclude | Generated evidence artifact, not launch documentation. |
| `docs/decisions/artifacts/g-port-stage4/provider-anthropic-reply.md` | exclude | Generated provider evidence artifact, not launch documentation. |
| `docs/decisions/artifacts/g-port-stage4/provider-workers-ai-reply.md` | exclude | Generated provider evidence artifact, not launch documentation. |
| `docs/decisions/artifacts/g-port-stage4/tool-policy-allowed.json` | exclude | Generated tool-policy evidence artifact, not launch documentation. |
| `docs/decisions/artifacts/g-port-stage4/tool-policy-denied.json` | exclude | Generated tool-policy evidence artifact, not launch documentation. |
| `docs/decisions/artifacts/g-port-stage4/workers-ai-cred-check.md` | exclude | Credential-check evidence from a private environment. |

Current source purge:

- `docs/source/` is removed from private `HEAD` and must not exist in the export.
- `docs/START_HERE.md` is removed from private `HEAD` and must not exist in the
  export.
- The two Slack canary screenshots are removed from private `HEAD` and must not
  exist in the export.

## Screenshot Review

Reviewed:

- `docs/slack-assistant-ux-canary-2026-06-29.png`
- `docs/slack-assistant-ux-ephemeral-canary-2026-06-29.png`

Checked for workspace name, member names, member avatars, channel names, email
addresses, browser chrome, and Slack workspace/channel identifiers.

Outcome: deleted both PNGs. They showed the Paperplane Labs workspace name,
the `#all-paperplane-labs` channel, member name/avatar, app name, adjacent
private channel names, Slack workspace/channel identifiers in the browser URL,
and personal browser chrome. No email address was observed, but the visible
workspace/member/channel identity was enough to remove them.

## Dry-Run Gate

The dry run is executable and fail-closed. It operates on committed `HEAD`,
deletes the manifest-excluded paths, verifies post-conditions, scans for denied
terms and unexpected binary/image files, then runs the install/test/offline
verification suite:

```bash
npm run verify:oss-export
```

The executable gate denies these text markers anywhere in the export before
dependencies are installed:

- `skillet`
- `docs/source`
- `/opt/homebrew`
- `claude[- ]?tag`
- `paperplane`
- `magoosh`
- `all-paperplane-labs`
- `/Users/`
- `canary`

It also fails on unexpected binary/image file extensions such as `png`, `jpg`,
`webp`, `gif`, `pdf`, and `mp4`. This is required because the removed Slack
screenshots were the highest-risk leak class and cannot be reviewed by text
grep.

Only after `npm run verify:oss-export` exits 0 may the cleaned export content be
used for the single initial commit in the new public repository.
