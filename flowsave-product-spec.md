# Flowsave — Product Spec & Implementation Roadmap
**v2** — audited and corrected

> **One-sentence pitch:** Flowsave is the backup, restore, and migration layer that n8n never built — packaged as an open-source CLI, a self-hosted agent, and a paid SaaS dashboard.

---

## 1. Problem

n8n self-hosters have no native backup solution. Every workflow, folder structure, and credential set lives entirely in a single Postgres database. One corrupted container, one botched upgrade, or one accidental delete — and everything is gone. There is also no clean way to migrate an instance to a new server, and no diff/history tooling whatsoever. This is a well-known pain point in the n8n Discord and subreddit, with no existing product solving it end-to-end.

---

## 2. Product Architecture — Three Layers

Flowsave ships as **three products that share one open-source monorepo**.

```
flowsave/                          ← open-source (MIT)
  packages/
    core/                          ← shared logic: n8n API, encryption, Git sync
    cli/                           ← CLI npm package, wraps core
    agent/                         ← daemon mode, wraps core + scheduler
  apps/
    dashboard/                     ← closed-source, paid SaaS (Next.js) — includes landing page at /
```

### Product 1 — Flowsave CLI (free, open-source)

A standalone command-line tool. Runs entirely on the user's machine. No account required, no data ever touches Flowsave servers. This is the trust anchor of the entire product.

```bash
flowsave backup               # snapshot all workflows + folders + credentials now
flowsave restore --snap 183   # restore any snapshot to current or new instance
flowsave migrate --to URL     # full migration to a new n8n instance
flowsave diff 181 183         # compare two snapshots, see exactly what changed
flowsave push                 # push latest snapshot to user's own Git remote
flowsave list                 # list all local snapshots with timestamps and sizes
flowsave config init          # interactive setup wizard
flowsave doctor               # check n8n connectivity, config validity, agent status
```

The CLI is genuinely useful on its own — users can run it forever, for free, with no account. This is intentional. Free value drives community adoption and GitHub stars that compound into dashboard conversions.

### Product 2 — Flowsave Agent (open-source Docker sidecar)

The same core packaged as a long-running daemon. Added to `docker-compose.yml` alongside n8n. Connects to the Flowsave Dashboard for scheduling and status. All encryption and credential handling stays on the user's server.

```yaml
services:
  flowsave-agent:
    image: flowsave/agent:latest
    environment:
      - FLOWSAVE_TOKEN=your_dashboard_token        # authenticates with Dashboard
      - N8N_BASE_URL=http://n8n:5678               # internal Docker service URL
      - N8N_API_KEY=your_n8n_api_key               # n8n REST API key
      - N8N_CONTAINER_NAME=n8n                     # for docker exec credential export
      - N8N_ENCRYPTION_KEY=${N8N_ENCRYPTION_KEY}   # for credential vault decryption
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock  # required for credential backup only
    restart: unless-stopped
```

Fully open-source — users can read every line before adding it to their stack. The `docker.sock` mount is required only for credential backup/restore (the agent uses `docker exec` to run `n8n export:credentials` inside the n8n container). Workflow-only backups work without it via the REST API.

### Product 3 — Flowsave Dashboard (closed-source, paid SaaS)

Web UI hosted on Flowsave's servers. Does not touch credential data directly. Receives encrypted bundles from the agent, stores them, and provides the UI for scheduling, history, diffing, and restore. Also serves the public landing page at `/`.

---

## 3. What Lives Where

| What | CLI | Agent | Dashboard |
|---|---|---|---|
| n8n API calls | User's machine | User's server | Never |
| Credential encryption/decryption | User's machine | User's server | Never |
| Scheduling | Manual only | Dashboard triggers | Flowsave servers |
| Backup storage | User's disk | Flowsave encrypted vault (R2) | Flowsave servers |
| Git push | Manual (`flowsave push`) | Auto on each backup (Pro) | Config UI only |
| UI & history | Terminal only | Dashboard | Flowsave servers |

---

## 4. Core Features

### CLI
| Command | What it does |
|---|---|
| `flowsave backup` | Snapshot workflows, folder structure, and credentials |
| `flowsave restore --snap N` | Restore any snapshot by local integer ID |
| `flowsave migrate --to URL --api-key KEY` | Full instance migration: backup source → restore to destination |
| `flowsave diff N1 N2` | Compare two local snapshots by integer ID |
| `flowsave push` | Push latest snapshot to the user's configured Git remote (free) |
| `flowsave list` | List local snapshots with IDs, timestamps, sizes |
| `flowsave config init` | Interactive wizard: sets instanceUrl, apiKey, backupDir, optional gitRemote |
| `flowsave doctor` | Validates config, tests n8n connectivity, checks agent reachability |

### Agent (requires Dashboard subscription)
| Feature | Notes |
|---|---|
| Scheduled backups | Cron-triggered by Dashboard, executes on user's server |
| Webhook-triggered backups | On workflow publish/activate events in n8n |
| Encrypted cloud vault upload | Sends encrypted bundle to Flowsave R2 after each backup |
| Multi-instance support | One agent token per n8n instance |
| Failure alerts | Email/Slack on backup job failure |
| Automated Git push | Auto-commit to user's Git repo on each backup (Pro) |

### Dashboard
| Feature | Notes |
|---|---|
| Backup history UI | Browse, diff, and restore any snapshot |
| Schedule management | Set cron schedules per instance |
| Multi-instance view | Status and health across all instances |
| GitHub / GitLab sync config | Connect repo, choose branch — auto-push handled by agent |
| REST API | For CI/CD integration (Team plan) |
| Team collaboration | Multi-user access + roles (Team plan) |
| Audit log | Who triggered what, when (Team plan) |

---

## 5. Folder-Aware Backup

Mirrors the user's actual n8n folder hierarchy — not a flat JSON dump. Each folder becomes a directory; each workflow is a single `.json` file. Restore re-creates the folder structure exactly.

```
~/.flowsave/backups/
  183/                              ← local integer snapshot ID
    meta.json                       ← instanceUrl, n8n version, timestamp, snapshotId
    index.json                      ← local snapshot registry entry
    DevOps/
      deploy-pipeline.json
      notify-on-fail.json
    Marketing/
      weekly-report.json
    _credentials.enc.json           ← AES-256-GCM encrypted, passphrase-protected
```

**Local snapshot registry** — `~/.flowsave/index.json` tracks all local snapshots:
```json
[
  { "id": 183, "timestamp": "2025-05-20T08:00:00Z", "instanceUrl": "http://...", "sizeBytes": 42310 },
  { "id": 182, "timestamp": "2025-05-13T08:00:00Z", "instanceUrl": "http://...", "sizeBytes": 41800 }
]
```
IDs are sequential integers incremented locally. Cloud snapshots (stored in the Dashboard) use UUIDs.

> **Folder API status (important):** Reading folder structure on backup uses the public API (`GET /api/v1/projects`, folder list endpoints) — fully supported. **Creating folders on restore is not yet available in the public API** (open feature request as of mid-2026). For v1, `n8nClient.ts` uses the n8n internal API (`POST /rest/folders`) to create folders during restore — this is the same endpoint the n8n UI uses internally. It works reliably today but is undocumented and could break on an n8n update without notice.
>
> ⚠️ **When `POST /api/v1/folders` lands in the public API, swap the internal call immediately.** Monitor the [n8n release notes](https://docs.n8n.io/release-notes/) and the [feature request thread](https://community.n8n.io/t/create-folders-in-n8n-using-n8n-public-api/96778). Until then, wrap the internal call defensively: if it fails (e.g. after an n8n update), fall back to restoring workflows flat and warn the user.

---

## 6. Credential Portability Vault

**Important architectural constraint:** The n8n public REST API does not return credential secret values — `GET /api/v1/credentials` returns only metadata (name, type, ID). Sensitive fields are redacted at the API layer by design. Credential backup therefore cannot use the REST API.

The only way to export credential data is via the **n8n CLI** run inside the container:
```bash
n8n export:credentials --all --decrypted --output=/tmp/credentials.json
```

This means credential backup has a hard requirement: **the agent must be co-located with the n8n container** (via Docker exec or a shared volume), or have shell access to the n8n process. This is exactly why the CLI and agent are Docker-native.

**Backup flow:**
1. Agent runs `n8n export:credentials --all --decrypted` inside the n8n container via `docker exec` (or directly if running as a sidecar with a shared volume)
2. Core receives the plaintext JSON, encrypts it with AES-256-GCM using the user's passphrase → `_credentials.enc.json`
3. Encrypted blob is stored locally (CLI) or uploaded to Flowsave R2 (agent)

**Restore flow:**
1. Prompts for passphrase, decrypts `_credentials.enc.json` → plaintext JSON
2. Runs `n8n import:credentials --input=/tmp/credentials.json` inside the destination container
3. Cleans up the plaintext temp file immediately

**Implication for `n8nClient.ts`:** The `credentials` module does NOT use the REST API for reading secret data. It uses CLI exec. The REST API is only used for listing credential metadata (names/IDs) and for creating credential shell entries on restore if needed.

**Implication for the agent docker-compose:** The canonical compose block is in Section 2. The `docker.sock` mount is required for credential backup; workflow-only backups work via the REST API without it.

- Flowsave servers store only the encrypted blob — the passphrase never leaves the user's environment
- Free tier: credential backup unavailable (requires agent with docker.sock access). Architectural, not artificial — document clearly in marketing.

---

## 7. Config File Schema

All CLI and agent configuration lives in `~/.flowsave/config.json`. Defined shape:

```json
{
  "instanceUrl": "http://localhost:5678",
  "apiKey": "n8n_api_xxxxxxxxxxxx",
  "containerName": "n8n",
  "backupDir": "~/.flowsave/backups",
  "gitRemote": "git@github.com:youruser/n8n-backups.git",
  "gitBranch": "main",
  "dashboardToken": "optional_if_using_agent"
}
```

`containerName` is the Docker container name for `docker exec` credential export/import. Required for credential backup; optional if only backing up workflows. `gitRemote` is optional (only needed for `flowsave push`). `dashboardToken` is optional (only needed for agent). `flowsave config init` walks the user through each field interactively.

---

## 8. Pricing

| Plan | Price | Instances | Backup History | Notable |
|---|---|---|---|---|
| **Free** | $0/mo | 1 | 7 days | Manual triggers only, workflow backup (no credentials), manual Git push via CLI |
| **Pro** | $12/mo | 3 | 90 days | Scheduled + webhook triggers, credential vault, automated Git push, private repos |
| **Team** | $39/mo | Unlimited | 1 year | Audit log, REST API, multi-user + roles, priority support |

14-day full Pro trial on signup — no credit card required.

**Clarification for marketing:** Free users can use the CLI's `flowsave push` command manually to push to any Git remote. The Pro gate is on *automated* Git push that runs after every scheduled backup. Free users cannot back up credentials — this is architectural (credential backup requires the self-hosted agent + cloud vault), not a fake limitation.

---

## 9. Tech Stack

| Layer | Choice | Reason |
|---|---|---|
| CLI & Agent | Node.js + TypeScript | Same runtime as n8n, easy community adoption, familiar to target users |
| CLI distribution | `npm publish` — `npm install -g flowsave` | Primary install method. Target users already have Node.js (n8n requires it). Secondary: clone repo + `npm link` for users who prefer running from source. |
| Core encryption | Node.js `crypto` (AES-256-GCM) | Zero external deps for the trust-critical part |
| Dashboard frontend | Next.js 14 (App Router) | SSR + API routes in one repo, also serves the landing page |
| Dashboard backend | Next.js API routes + tRPC | Type-safe end-to-end, colocated with frontend |
| Database (SaaS) | PostgreSQL via Prisma | Backup metadata, schedules, user accounts, job queue |
| Backup blob storage | Cloudflare R2 (S3-compatible) | Cheap, fast, zero egress fees |
| Auth | Clerk | Org support for Team plan, fast to integrate, handles email/OAuth |
| Agent ↔ Dashboard comms | HTTPS polling every 10s (agent polls Dashboard) | No inbound ports required; works behind all firewalls and corporate proxies. 10s interval = ~5s avg latency for manual triggers. Persistent WebSocket is the v2 upgrade path once scale justifies stateful infra. |
| Monorepo tooling | pnpm workspaces + Turborepo | Fast builds; Turborepo task pipeline: `build` → `test` → `lint`, cached per package |

---

## 10. Moat & Distribution

The open-source trust flywheel: CLI and agent being fully open-source means developers audit the code, star the repo, recommend it in the n8n Discord and subreddit, and bring it to their clients. Free CLI drives dashboard conversions without marketing spend. This mirrors n8n's own model.

Primary distribution channels:
- n8n Discord `#self-hosted` channel (organic — answer backup questions, link the tool)
- r/n8n subreddit
- n8n community forum
- GitHub (target 500 stars before paid launch)
- ProductHunt launch
- YouTube tutorials (self-hosted n8n audience is very tutorial-hungry)

---

## 11. Branding

**Name:** Flowsave

**Direction:** Minimal & trustworthy — the "we keep your work safe" feeling. Clean, no-nonsense. Appeals to the self-hoster who does not trust flashy SaaS products.

**Color palette:** Deep navy (`#0F1B2D`) as primary, electric green (`#22C55E`) as accent (signals "saved / safe"), warm white (`#F8F9FA`) for backgrounds.

**Logo concept:** A save/floppy disk icon fused with a flow arrow — simple enough to work at 16px favicon size.

**Tagline options:**
- *"Your n8n workflows, backed up."*
- *"Backup, restore, migrate — without the panic."*
- *"The safety net for your automation stack."*

---

## 12. Implementation Roadmap

Each phase is a self-contained unit of work. Complete each phase fully before starting the next — the core package is the foundation for everything else.

---

### Phase 1 — Core Package (Foundation)

**Goal:** The shared engine that CLI, agent, and dashboard all depend on. No CLI, no UI — just pure logic.

**Deliverables:**
- `packages/core/src/types.ts` — all shared TypeScript types: `Snapshot`, `SnapshotMeta`, `WorkflowBackup`, `CredentialBackup`, `DiffResult`, `FlowsaveConfig`, `BackupJob`
- `packages/core/src/config.ts` — reads/writes `~/.flowsave/config.json` using the schema defined in Section 7
- `packages/core/src/n8nClient.ts` — authenticated n8n REST API client. Two API surfaces used:
  - **Public API** (`/api/v1/`, API key auth): list/create/update/delete workflows, list projects and folders (GET only), list credential metadata, place workflows in a project on creation via `projectId`.
  - **Internal API** (`/rest/`, API key auth): `POST /rest/folders` to create folders during restore. ⚠️ Undocumented — used because the public API has no folder creation endpoint yet. Wrap in try/catch; fall back to flat restore if it fails. Swap to `POST /api/v1/folders` as soon as it ships.
  - Credential secret values are never read via either API — handled by `credentials.ts` via docker exec.
- `packages/core/src/encrypt.ts` — pure AES-256-GCM primitive. `encrypt(plaintext: Buffer, passphrase: string): Buffer` and `decrypt(ciphertext: Buffer, passphrase: string): Buffer`. No file I/O, no n8n knowledge — just the cryptographic operation. Used by `credentials.ts` and by the agent upload/download path.
- `packages/core/src/credentials.ts` — credential export/import via n8n CLI exec. `exportCredentials(containerName, passphrase)`: runs `docker exec <container> n8n export:credentials --all --decrypted`, receives plaintext JSON, calls `encrypt.ts` to produce `_credentials.enc.json`. `importCredentials(containerName, encFile, passphrase)`: calls `encrypt.ts` to decrypt, writes plaintext to temp file, runs `docker exec <container> n8n import:credentials --input=<tempFile>`, deletes temp file immediately.
- `packages/core/src/backup.ts` — snapshot builder: fetch all workflows + folders + credentials → write folder-aware file structure to `backupDir` → append entry to `~/.flowsave/index.json` with auto-incremented integer ID
- `packages/core/src/restore.ts` — restore engine: read snapshot by integer ID from local index → push workflows + folder structure + credentials to target n8n instance. Supports same-instance restore and cross-instance migration (different `instanceUrl`).
- `packages/core/src/migrate.ts` — migration wrapper: runs backup against source instance, then restore against destination instance URL + API key. Distinct from restore — documents the two-step flow explicitly. Inherits the folder creation limitation from `restore.ts`: folder structure recreation on the destination uses `POST /rest/folders` with the same try/catch + flat fallback behavior.
- `packages/core/src/diff.ts` — compare two snapshots by integer ID, return structured `DiffResult`: added workflows, removed workflows, modified workflows (with field-level diff).
- `packages/core/src/gitSync.ts` — `pushToGit(snapshotPath, remote, branch)`: stages snapshot directory, commits with standard message `chore: flowsave backup <timestamp>`, pushes to remote. Open-source module — the Pro gate is on automated scheduling, not on this code existing.
- Unit tests for: `backup`, `restore`, `encrypt`/`decrypt` roundtrip, `credentials` export/import roundtrip, `diff`, `migrate`

**Key decisions resolved:**
- Snapshot IDs are sequential integers stored in `~/.flowsave/index.json` (local). Cloud snapshots use UUIDs.
- Config schema is fixed (Section 7) — do not invent alternatives.
- `n8nClient.ts` uses the public `/api/v1/` API for everything except folder creation on restore, which uses the internal `/rest/folders` endpoint (not yet in public API). Wrap the internal call defensively with a flat-restore fallback. Swap to public API when it ships.
- Credential secrets are handled exclusively by `credentials.ts` via `docker exec` running `n8n export:credentials` / `n8n import:credentials` inside the n8n container.
- Primary CLI distribution is `npm install -g flowsave`. Secondary: clone repo + `npm install && npm run build && npm link` for users who prefer running from source. No binary compilation needed.

**Done when:** Core package can back up a real n8n instance to disk, diff two snapshots, and restore a snapshot — all verified by unit tests passing.

---

### Phase 2 — CLI Package

**Goal:** Usable command-line tool that wraps core. The free product users install.

**Deliverables:**
- `packages/cli/src/index.ts` — CLI entry point using `commander`
- `packages/cli/src/commands/backup.ts` — calls `core.backup()`, shows progress with `ora`, prints snapshot ID on completion
- `packages/cli/src/commands/restore.ts` — accepts `--snap <id>`, optionally `--to <url> --api-key <key>` for cross-instance
- `packages/cli/src/commands/migrate.ts` — wraps `core.migrate()`, requires `--to <url>` and `--api-key <key>`
- `packages/cli/src/commands/diff.ts` — accepts two integer IDs, renders colored diff output with `chalk`
- `packages/cli/src/commands/push.ts` — calls `core.gitSync()` with config's `gitRemote` and `gitBranch`
- `packages/cli/src/commands/list.ts` — reads `~/.flowsave/index.json`, renders table with `cli-table3`
- `packages/cli/src/commands/config.ts` — `init` subcommand: interactive prompts with `inquirer`, writes config file
- `packages/cli/src/commands/doctor.ts` — validates config fields, pings `instanceUrl`, reports issues clearly
- `--help` output for every command (handled by `commander`)
- Colored terminal output using `chalk`, progress spinners using `ora`
- `package.json` configured for npm publish: `"bin": { "flowsave": "./dist/index.js" }`, `"engines": { "node": ">=18" }`, correct `"main"` and `"files"` fields
- Build script: `tsc` compiles to `dist/`, entry point is `dist/index.js` with `#!/usr/bin/env node` shebang
- `CONTRIBUTING.md` documents the local dev install path: `git clone → npm install → npm run build → npm link`
- `README.md` with install instructions, full command reference, and config schema

**Done when:** `npm install -g flowsave` works, `flowsave config init` runs interactively, `flowsave backup` produces a valid snapshot, `flowsave restore --snap 1` restores it cleanly against a real n8n instance.

---

### Phase 3 — CI/CD, Binaries & Community Launch

**Goal:** Get the CLI public with automated releases. Seeding the n8n community is a manual task outside Claude Code.

**Code deliverables (Claude Code):**
- `.github/workflows/ci.yml` — runs `pnpm test` and `pnpm lint` on every PR
- `.github/workflows/release.yml` — on git tag push: runs `npm publish` to publish the package to the npm registry
- Root `README.md` with quick-start (3 commands), architecture overview, and link to full docs
- `turbo.json` with defined tasks: `build` (depends on upstream `build`), `test`, `lint` — all packages

**Manual tasks (not Claude Code):**
- Create public GitHub repo
- Post in n8n Discord `#self-hosted`
- Post in r/n8n
- Post in n8n community forum

**Done when:** Pushing a git tag publishes the package to npm and `npm install -g flowsave` works on a clean machine.

---

### Phase 4 — Agent Package

**Goal:** Long-running daemon that the Dashboard controls. Requires a minimal Dashboard stub to develop against.

**Deliverables:**
- `packages/agent/src/types.ts` — `AgentJob`, `JobStatus`, `PollResponse` types
- `packages/agent/src/poller.ts` — polls `GET /api/agent/poll` every **10s** with `FLOWSAVE_TOKEN` header; receives job queue; dispatches jobs; reports results via `POST /api/agent/report`. 10s gives ~5s average latency for manual triggers while remaining trivially cheap (1,000 agents = 100 req/s, all lightweight). Configurable via `FLOWSAVE_POLL_INTERVAL_MS` env var (default: 10000).
- `packages/agent/src/jobs/backup.ts` — executes backup job: calls `core.backup()`, uploads encrypted bundle to presigned R2 URL provided in the job payload
- `packages/agent/src/jobs/restore.ts` — executes restore job: downloads encrypted bundle from presigned R2 URL, decrypts, calls `core.restore()`
- `packages/agent/src/jobs/gitPush.ts` — executes git push job: calls `core.gitSync()` after backup completes
- `packages/agent/src/health.ts` — HTTP server on port `3001`, `GET /health` returns `{ status: "ok", instanceUrl, lastBackup, agentVersion }`
- `packages/agent/src/index.ts` — entry point: validates all required env vars on startup (`FLOWSAVE_TOKEN`, `N8N_BASE_URL`, `N8N_API_KEY`), starts poller and health server
- `packages/agent/Dockerfile` — Node.js Alpine base (`node:20-alpine`), copies built agent JS, runs with `node`
- `docker-compose.snippet.yml` — ready-to-paste compose block (using the env vars from Section 2)
- **Minimal Dashboard stub** (`packages/agent/stub/server.ts`) — a lightweight Express server that implements `/api/agent/poll` and `/api/agent/report` for local development and testing, returning a hardcoded backup job

**Job payload contract (poll response):**
```json
{
  "jobs": [
    {
      "id": "uuid",
      "type": "backup" | "restore" | "git-push",
      "payload": {
        "uploadUrl": "presigned R2 URL (for backup)",
        "downloadUrl": "presigned R2 URL (for restore)",
        "snapshotUuid": "uuid (for restore/git-push)"
      }
    }
  ]
}
```

**Done when:** Agent container starts, passes startup validation, polls the local stub, executes a backup job, uploads the result to a test R2 bucket, and reports success back to the stub.

**v2 upgrade path — persistent WebSocket (not in scope for v1):**
Once you have real usage data on how many concurrent agents you're running, polling can be replaced with a persistent outbound WebSocket connection from the agent to the Dashboard. The agent initiates the connection (no inbound ports required), the Dashboard pushes jobs instantly, and manual triggers become near-zero latency. The tradeoff is stateful infrastructure on the Dashboard side (each connected agent holds a socket) and significant reconnection/heartbeat logic in the agent. The polling architecture is designed to make this upgrade non-breaking: the `/api/agent/poll` endpoint stays as a fallback for agents that can't maintain a WebSocket (corporate proxies often kill long-lived connections), and the job payload contract stays identical. Add this in v2 only after shipping and validating real demand.

---

### Phase 5 — Dashboard Backend (API)

**Goal:** The server side of the SaaS — auth, job queue, backup storage, billing.

**Deliverables:**
- Next.js 14 project bootstrapped in `apps/dashboard/`
- **Prisma schema** (`apps/dashboard/prisma/schema.prisma`):
  ```
  User          — id, clerkId, email, plan (free|pro|team), createdAt
  Instance      — id (uuid), userId, name, agentToken (hashed), n8nUrl, createdAt
  BackupJob     — id (uuid), instanceId, type, status (pending|running|completed|failed),
                  createdAt, startedAt, completedAt, errorMessage
  Snapshot      — id (uuid), instanceId, jobId, timestamp, sizeBytes, r2Key, gitCommitSha?
  Schedule      — id, instanceId, cronExpression, enabled, lastRunAt, nextRunAt
  AuditLog      — id, userId, instanceId, action, metadata (json), createdAt
  ```
- **Agent API** (no user auth, token-based):
  - `GET /api/agent/poll` — returns pending jobs for the token's instance; marks them `running`
  - `POST /api/agent/report` — receives job result, updates `BackupJob` status + creates `Snapshot` record, generates presigned R2 URLs
- **tRPC router** (user auth via Clerk):
  - `instance`: create, list, delete, regenerate token
  - `snapshot`: list (by instance), delete, getDownloadUrl, getPresignedUploadUrl
  - `schedule`: get, upsert, delete
  - `job`: list (by instance), getStatus (for UI polling during restore)
  - `billing`: getCurrentPlan, createCheckoutSession, createPortalSession
- **Stripe webhooks** — `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted` → update `User.plan`
- **Plan enforcement middleware** — checks `User.plan` before tRPC procedures that are Pro/Team-gated
- **Cron runner** — checks `Schedule` table every minute, enqueues `BackupJob` records for due schedules (use Vercel Cron or a simple setInterval if self-hosted)
- **R2 integration** — `@aws-sdk/client-s3` with presigned URLs; agent uploads/downloads directly, Dashboard never proxies the blob

**Done when:** Agent can register an instance, poll for a job, receive a backup job with a presigned upload URL, upload to R2, report success — and the snapshot appears in the `Snapshot` table.

---

### Phase 6 — Dashboard Frontend (UI)

**Goal:** The web interface users interact with, plus the public landing page.

**Routes and pages:**
- `/` — public landing page: hero (tagline + install command), how it works (CLI → Agent → Dashboard), pricing table, CTA to sign up
- `/sign-in`, `/sign-up` — Clerk hosted UI pages
- `/dashboard` — instance overview: status cards (last backup, next scheduled, total snapshots), instance list
- `/dashboard/[instanceId]` — instance detail: recent jobs, quick backup button
- `/dashboard/[instanceId]/snapshots` — backup history table (timestamp, size, diff button, restore button, delete)
- `/dashboard/[instanceId]/schedule` — cron expression editor with human-readable preview
- `/dashboard/[instanceId]/git` — connect GitHub/GitLab repo, choose branch (Pro gate)
- `/dashboard/[instanceId]/settings` — instance name, copy agent token, delete instance
- `/settings/billing` — current plan, usage meters, upgrade/downgrade, Stripe portal link
- `/settings/team` — invite member by email, set role (viewer/admin), remove member (Team plan gate)

**Key UI components:**
- Snapshot diff viewer — side-by-side diff of two snapshot JSONs, workflow-level grouping
- Restore flow — modal: select snapshot → show what will change → confirm → trigger restore job → poll `job.getStatus` every 3s → show completion or error
- Agent install widget — shows the docker-compose snippet with the user's actual token pre-filled, one-click copy

**Design system:** Tailwind CSS + shadcn/ui. Navy (`#0F1B2D`) / green (`#22C55E`) palette per Section 11.

**Done when:** A logged-in user can view their instance, browse snapshot history, trigger a restore from the UI (with live job status polling), and manage their schedule.

---

### Phase 7 — Git Sync & REST API

**Goal:** Automated Git push after each backup (Pro feature) and REST API for CI/CD (Team feature).

**Deliverables:**
- GitHub OAuth App — user connects their GitHub account in `/dashboard/[instanceId]/git`; stores OAuth token against the instance
- GitLab support — personal access token input (no OAuth required)
- Agent job type `git-push` — after a successful backup job, Dashboard enqueues a `git-push` job with the repo URL, branch, and OAuth token; agent calls `core.gitSync()` using the token
- Commit message format: `chore: flowsave backup <snapshotUuid> <timestamp>`
- Dashboard UI: connected repo status, last commit SHA + link, disconnect button
- **REST API** (`/api/v1/` — Team plan only):
  - `POST /api/v1/backup` — trigger an immediate backup for an instance
  - `GET /api/v1/snapshots` — list snapshots
  - `GET /api/v1/snapshots/:id/download` — get presigned download URL
  - API key management in `/settings/api-keys`

**Done when:** A Pro user connects their GitHub repo, triggers a backup, and a commit appears in their repo with the correct snapshot files.

---

### Phase 8 — Alerts, Polish & Launch

**Goal:** Production-ready. Every feature works end-to-end. Ship to ProductHunt.

**Deliverables:**
- Email alerts on backup failure — `Resend` integration; templated email with instance name, error message, and link to dashboard
- Slack webhook alerts — user pastes incoming webhook URL in instance settings; agent sends failure notification
- Backup health badge — `GET /api/badge/[instanceId]` returns an SVG status badge (last backup time + status); embeddable in GitHub READMEs
- `flowsave doctor` command — already scaffolded in Phase 2; finalize to also check agent reachability via `GET /health` on the agent container
- Documentation site — Mintlify; covers: quick-start, CLI reference, agent install, dashboard guide, credential vault explainer, FAQ
- Annual billing toggle on pricing page (20% discount)
- Uptime monitoring — Betterstack (or similar) on Dashboard and agent health endpoint
- ProductHunt launch assets — tagline, description, screenshots, first comment

**Done when:** All three plans are purchasable end-to-end (Stripe), agent and CLI work on Linux and macOS, documentation is live, ProductHunt post is submitted.

---

## 13. File Structure (Full Monorepo)

```
flowsave/
├── packages/
│   ├── core/
│   │   ├── src/
│   │   │   ├── types.ts
│   │   │   ├── config.ts
│   │   │   ├── n8nClient.ts
│   │   │   ├── backup.ts
│   │   │   ├── restore.ts
│   │   │   ├── migrate.ts
│   │   │   ├── encrypt.ts
│   │   │   ├── credentials.ts      ← docker exec-based credential export/import
│   │   │   ├── diff.ts
│   │   │   └── gitSync.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── cli/
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   └── commands/
│   │   │       ├── backup.ts
│   │   │       ├── restore.ts
│   │   │       ├── migrate.ts
│   │   │       ├── diff.ts
│   │   │       ├── push.ts
│   │   │       ├── list.ts
│   │   │       ├── config.ts
│   │   │       └── doctor.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── agent/
│       ├── src/
│       │   ├── index.ts
│       │   ├── types.ts
│       │   ├── poller.ts
│       │   ├── health.ts
│       │   └── jobs/
│       │       ├── backup.ts
│       │       ├── restore.ts
│       │       └── gitPush.ts
│       ├── stub/
│       │   └── server.ts          ← dev/test stub for Dashboard API
│       ├── Dockerfile
│       ├── docker-compose.snippet.yml
│       ├── package.json
│       └── tsconfig.json
├── apps/
│   └── dashboard/
│       ├── app/                   ← Next.js App Router (includes / landing page)
│       │   ├── page.tsx           ← landing page
│       │   ├── dashboard/
│       │   ├── settings/
│       │   └── api/
│       │       ├── agent/
│       │       │   ├── poll/
│       │       │   └── report/
│       │       ├── v1/            ← REST API (Team plan)
│       │       ├── badge/
│       │       └── webhooks/
│       │           └── stripe/
│       ├── prisma/
│       │   └── schema.prisma
│       ├── server/
│       │   ├── trpc.ts
│       │   └── routers/
│       │       ├── instance.ts
│       │       ├── snapshot.ts
│       │       ├── schedule.ts
│       │       ├── job.ts
│       │       └── billing.ts
│       └── package.json
├── pnpm-workspace.yaml
├── turbo.json                     ← tasks: build, test, lint (cached, dependency-ordered)
├── package.json
└── README.md
```

---

## 14. Context for Claude Code Sessions

When starting a new Claude Code session for any phase, open with:

> "I'm building Flowsave — a backup, restore, and migration SaaS for n8n self-hosters. The repo is a pnpm monorepo with packages/core, packages/cli, packages/agent, and apps/dashboard. I am working on **[Phase N — Name]**. The full spec is in `flowsave-product-spec.md` at the root. Read it first, then implement the deliverables for this phase exactly as specified. Do not proceed to the next phase."

**Phase order is strict.** Phase 1 must be complete and tested before Phase 2 starts. Phase 4 requires the stub server — build it within Phase 4, do not wait for Phase 5. Phase 5 must have the agent API working before Phase 6 UI is built.
