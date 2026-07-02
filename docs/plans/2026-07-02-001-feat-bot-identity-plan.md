---
title: Bot Identity - Plan
type: feat
date: 2026-07-02
topic: bot-identity
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: ce-brainstorm
execution: code
---

# Bot Identity - Plan

## Goal Capsule

- **Objective:** Give each cloned install one configurable bot identity — display name plus avatar — with a clean shipped default, so a fresh clone never shows Slack's generic app icon and an operator can make the bot look like their own.
- **Product authority:** Operator of a cloned install (they own their own Slack app).
- **Open blockers:** None blocking planning. One accepted manual step (icon upload to the Slack app console) and one deferred extension (an admin UI) are recorded below.

## Product Contract

### Summary

Introduce a first-class, config-backed **bot identity** — a single display name and avatar shared across the entire install — with a clean default shipped in the repo and a guided setup that applies it to the operator's Slack app. Parity with a polished app (clean icon on hover card, About, DM header, and messages) comes from setting the real Slack app identity, not from per-message overrides.

### Problem Frame

Each customer runs their own clone of this repo against their own Slack app. Out of the box, the bot posts under Slack's default app icon (the generic notebook-and-ruler placeholder), which reads as broken or unfinished next to a properly branded app. There is no designated place in the repo to set the bot's name or avatar, and the message-posting path (`src/slack/web-client-presenter.ts`) sends no identity information at all. The cost lands at first impression: every new install looks unpolished until the operator figures out, unaided, that identity is configured entirely in Slack's app console.

### Key Decisions

- **One identity per install, shared everywhere.** A single name + avatar applies across all channels, agents, and routing bundles. Per-channel, per-agent, and per-workspace distinct identities are out of scope.
- **Parity comes from the app identity, not per-message overrides.** Full parity (hover card, About, DM header, *and* messages) requires the actual Slack app identity to be set. Per-message `username`/`icon_url` overrides are rejected: they cannot change the hover card or About page, and they likely do not apply to the primary `chat.startStream` delivery path anyway.
- **The avatar upload is an accepted manual step.** Slack exposes no API to set an app's display icon; it is uploaded once in the app console. The feature's job is to make that step obvious and verifiable, not to automate it.
- **Ship a clean default identity.** A fresh clone gets a good-enough default name and placeholder avatar so it never renders as the generic Slack icon. Final default assets are a later design pass; v1 ships basic placeholders.

### Requirements

**Configuration**
- R1. The bot's display name is set in one obvious place in `src/config/`, shared across the whole install.
- R2. The bot's avatar has a designated asset location in the repo, shared across the whole install.
- R3. The repo ships a clean default name and a basic placeholder avatar so a fresh clone never shows Slack's generic app icon. Placeholders are acceptable for v1; polished assets come later.

**Setup and application**
- R4. A guided setup path gets the configured identity into the operator's Slack app: the display name and the avatar upload.
- R5. Setup surfaces the one-time icon upload as an explicit, verifiable step — the operator can tell whether the bot's real identity has been applied versus still on the default.
- R6. Documentation frames bot identity as a first-class setup step, not an afterthought.

### Acceptance Examples

- AE1. **Covers R3.** **Given** a fresh clone with no operator changes, **when** the bot posts its first message, **then** it shows the clean default name and placeholder avatar — never Slack's generic notebook icon.
- AE2. **Covers R1, R2, R4.** **Given** the operator sets a custom name and avatar in the repo and completes the guided setup, **then** the bot shows that identity on messages *and* on the hover card, About page, and DM header.
- AE3. **Covers R5.** **Given** the operator has set config but not yet uploaded the icon, **when** they run the guided setup, **then** the unfinished icon-upload step is called out so the gap is visible rather than silent.

### Scope Boundaries

**Outside this feature**
- Per-channel, per-agent, or per-workspace distinct identities — the model is explicitly one identity per install.
- Per-message `username`/`icon_url` overrides via `chat:write.customize`.
- Automating the avatar upload — impossible via Slack API; it stays a documented manual step.

**Deferred for later**
- A live admin UI ("C later") — a small authenticated route to edit the name, preview/download the avatar, and show an "icon uploaded?" status. Recorded in Outstanding Questions.
- Final polished default avatar and name assets — v1 ships basic placeholders.

### Dependencies / Assumptions

- The operator owns and can access their Slack app's console (required for the icon upload). Assumed true from the deployment model (each customer clones and stands up their own app).
- **Verify at plan time:** whether Slack's app-manifest API can push the display name automatically (needs an app config token), and confirm the icon cannot be set via API. If name automation is viable it is a nice-to-have; the console-documented path is the v1 baseline.

### Outstanding Questions

**Deferred to Planning**
- Automate the display name via the manifest API (app config token) vs. document it as a manual console step alongside the icon. Leaning: document both as console steps for v1, keep name automation as an optional enhancement.
- Exact config shape and avatar asset location within `src/config/` — an implementation decision.

**Deferred (future extension)**
- The admin UI (C): a small authenticated Hono route to edit the name, preview/download the avatar, and display icon-upload status. Not part of v1; the config + guided-setup spine is designed so this can layer on top later.

### Sources / Research

- `src/slack/web-client-presenter.ts` — message delivery via `chat.postMessage` and `chat.startStream`; currently passes no identity fields.
- `src/config/` (`types.ts`, `seed.ts`, `resolver.ts`) — existing config layer this feature extends; no bot-identity field exists today.
- No admin/web UI surface exists in the repo today (`src/app.ts` is a Hono app routing Slack events only) — the admin-page extension would be net-new.
