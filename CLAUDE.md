# Flowsave — Claude Code Instructions

## What this project is
Flowsave is a backup, restore, and migration SaaS for n8n self-hosters.
It ships as three products sharing one monorepo: a CLI tool, a self-hosted Docker agent, and a paid SaaS dashboard.

Full product spec, architecture, and implementation roadmap: `flowsave-product-spec.md`
Current phase and progress: `PHASES.md`
Post-spec decisions: `DECISIONS.md`

---

## How to orient yourself at the start of every session

Read these files in order before writing a single line of code:

1. `CLAUDE.md` — this file
2. `flowsave-product-spec.md` — full spec, all architecture decisions, all phase deliverables
3. `PHASES.md` — which phase is active, what is done, what is blocked
4. `DECISIONS.md` — decisions made after the spec was written

If anything in the codebase conflicts with the spec, **stop and ask** before assuming which is correct.

---

## Phase rules

- Never start a new phase until the current one fully satisfies its "Done when" criteria
- Never implement deliverables from a future phase as a shortcut for the current one
- All shared types live in `packages/core/src/types.ts` — never redefine or duplicate them elsewhere
- All config fields are defined in Section 7 of the spec — never invent new ones without explicit instruction
- File names, module boundaries, and function signatures are defined in the spec — follow them exactly

---

## Security — non-negotiable rules

This product handles credential secrets, encryption keys, and Docker socket access. Security is the core value proposition. Every line of code must reflect that.

### Never do any of the following

- **Never log, print, or expose plaintext credentials, passphrases, or encryption keys** — not in console output, not in error messages, not in stack traces, not in temp files that aren't immediately deleted
- **Never store sensitive values in environment variables beyond what is explicitly defined in the spec** — no undocumented env var shortcuts
- **Never skip input validation** — validate all external input (API responses, CLI arguments, config file values, job payloads from the Dashboard) before using it
- **Never trust data from the network without validation** — the agent receives job payloads from the Dashboard; treat them as untrusted input
- **Never write plaintext credentials to disk without immediately scheduling deletion** — if a temp file is needed (e.g. for `n8n import:credentials`), delete it in a `finally` block, not just in the happy path
- **Never hardcode secrets, tokens, or keys** — not in source, not in tests, not in fixtures
- **Never suppress or swallow errors silently** — every caught error must either be re-thrown, logged (without sensitive data), or explicitly handled with a documented reason
- **Never use `eval`, `Function()`, or dynamic code execution**
- **Never disable or bypass TLS certificate validation** — no `rejectUnauthorized: false` shortcuts

### Encryption

- `encrypt.ts` is the only place AES-256-GCM logic lives — never inline crypto elsewhere
- Always use a random IV (initialization vector) per encryption operation — never reuse IVs
- The passphrase never touches the network — it is only ever used in memory on the user's machine or server

### Docker socket access

- The Docker socket mount (`/var/run/docker.sock`) is used exclusively for `docker exec` credential export/import — nothing else
- Never use it for container inspection, image pulling, or any operation outside the credential backup/restore flow
- Document this scope clearly in any code that touches the socket

### Dependency hygiene

- Keep dependencies minimal — every new package is an attack surface
- Never add a dependency to handle something Node's built-in `crypto`, `fs`, or `child_process` modules can do
- Run `npm audit` before completing any phase — fix all high and critical vulnerabilities before marking a phase done

---

## Code quality rules

### Structure

- One responsibility per module — if a file is doing two things, split it
- `packages/core/` contains zero CLI, agent, or dashboard logic — it is pure business logic only
- `packages/cli/` contains zero business logic — it only calls core and handles UX (prompts, output formatting)
- `packages/agent/` contains zero business logic — it only receives jobs, calls core, and reports results
- Cross-package imports only go downward: `cli` → `core`, `agent` → `core`. Never `core` → `cli`, never `cli` → `agent`

### Error handling

- Every async operation must have explicit error handling — no unhandled promise rejections
- Errors that reach the CLI surface must be human-readable — no raw stack traces shown to users
- Errors that reach the agent must be reported back to the Dashboard via `POST /api/agent/report` with a sanitized message — never drop a failed job silently

### TypeScript

- Strict mode on everywhere (`"strict": true` in all `tsconfig.json` files)
- No `any` types — if the shape is unknown, define it explicitly or use `unknown` with a type guard
- All exported functions must have explicit return type annotations

### Testing

- Every module in `packages/core/` must have a corresponding test file
- Tests must not make real network calls — mock `n8nClient` and `docker exec` calls
- Tests must not write to the real `~/.flowsave/` directory — use a temp directory per test run

---

## The one exception — internal API usage

`POST /rest/folders` (the n8n internal API) is intentionally used for folder creation on restore and migrate. This is a documented, conscious decision recorded in `DECISIONS.md`. It is the **only** place an undocumented API is used, and it must be wrapped in try/catch with a flat-restore fallback. Do not treat this as a pattern to follow elsewhere — every other integration must use documented, stable APIs only.
