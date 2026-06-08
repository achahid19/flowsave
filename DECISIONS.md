# Flowsave — Architecture Decisions Log

Decisions made after the spec was written, or clarifications that resolve ambiguity in the spec.
Claude Code must read this file before implementing anything.

---

## 2026-06-08 — Folder creation uses n8n internal API (v1 only)

**Decision:** `POST /rest/folders` (n8n's internal, undocumented API) is used for folder creation during restore and migrate in v1.

**Reason:** The n8n public REST API (`/api/v1/`) does not yet expose a folder creation endpoint. This is an open feature request in the n8n community (April 2025, still unresolved as of mid-2026). The internal route is what the n8n UI uses and works reliably today.

**Risk:** This endpoint is undocumented and can break on any n8n update without notice.

**Required implementation:** Wrap every call to `POST /rest/folders` in a try/catch. On failure, fall back to restoring all workflows flat (to root) and emit a clear warning to the user.

**Swap trigger:** As soon as `POST /api/v1/folders` appears in the [n8n release notes](https://docs.n8n.io/release-notes/), replace the internal call. Monitor the [feature request thread](https://community.n8n.io/t/create-folders-in-n8n-using-n8n-public-api/96778).

**Affected modules:** `packages/core/src/n8nClient.ts`, `packages/core/src/restore.ts`, `packages/core/src/migrate.ts`

---

## 2026-06-08 — CLI distribution is npm only, no binary compilation

**Decision:** `npm install -g flowsave` is the only user-facing install method. No binary compilation (no bun, no pkg, no executables).

**Reason:** Target users are n8n self-hosters who already have Node.js installed — it is a hard n8n requirement. A self-contained binary solves a problem this audience does not have. The secondary install path for users who prefer source is: `git clone → npm install → npm run build → node dist/index.js`.

**Affected modules:** `packages/cli/package.json`, `.github/workflows/release.yml`

---

## 2026-06-08 — Credential backup uses docker exec, not REST API

**Decision:** Credential export/import uses `docker exec <container> n8n export:credentials --all --decrypted` and `docker exec <container> n8n import:credentials`, not the n8n REST API.

**Reason:** The n8n public REST API redacts all sensitive credential fields by design — `GET /api/v1/credentials` returns only metadata (name, type, ID), never the actual secret values. The only way to get plaintext credential data is via the n8n CLI run inside the container.

**Security requirements:**
- Plaintext credential JSON must never be written to a persistent path — only to a temp file with a random name
- The temp file must be deleted in a `finally` block, guaranteed regardless of success or failure
- The passphrase used for AES-256-GCM encryption never leaves the user's machine/server

**Affected modules:** `packages/core/src/credentials.ts`, `packages/agent/docker-compose.snippet.yml` (requires `docker.sock` mount)

---

## 2026-06-08 — Agent polling interval is 10 seconds

**Decision:** The agent polls `GET /api/agent/poll` every 10 seconds (configurable via `FLOWSAVE_POLL_INTERVAL_MS`).

**Reason:** 10s gives ~5s average latency for manual "backup now" triggers while remaining trivially cheap on server infrastructure (1,000 agents = 100 req/s). 60s was the original value but was too slow for on-demand actions.

**v2 note:** Persistent outbound WebSocket is the planned upgrade once scale justifies stateful infrastructure. The polling architecture is designed to be non-breaking: `/api/agent/poll` stays as fallback, job payload contract stays identical.

**Affected modules:** `packages/agent/src/poller.ts`
