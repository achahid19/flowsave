# Flowsave

> The backup, restore, and migration layer that n8n never built.

![Flowsave demo](https://raw.githubusercontent.com/achahid19/flowsave/main/docs/flowsave-demo.gif)

Flowsave is an open-source CLI, self-hosted agent, and paid SaaS dashboard for n8n self-hosters. Never lose a workflow again.

## Install

```bash
npm install -g flowsave-cli
```

Requires Node.js ≥ 18. Your n8n instance must be reachable from the machine running Flowsave.

### Docker requirement (credential backup only)

Credential backup and restore use `docker exec` to call the n8n CLI inside the container. Docker must be accessible **without `sudo`** from the user running Flowsave.

On Linux, Docker requires root by default. Add your user to the `docker` group once:

```bash
sudo usermod -aG docker $USER
# then log out and back in for the change to take effect
```

On macOS with Docker Desktop this is not required — Docker Desktop runs as the current user.

Run `flowsave doctor` at any time to verify your Docker setup.

## Quick start

```bash
flowsave config init      # one-time setup
flowsave backup           # take your first snapshot
flowsave list             # see all snapshots
```

## Commands

### `flowsave backup`

Snapshot all workflows and (optionally) encrypted credentials from your n8n instance.

```bash
flowsave backup
```

- Workflows are saved as JSON files under `~/.flowsave/backups/<id>/`
- If a Docker container is configured, prompts for a passphrase and exports credentials encrypted with AES-256-GCM
- **Passphrase requirements**: at least 12 characters, with one uppercase letter, one lowercase letter, and one digit or special character. You are asked to confirm it — the passphrase is never stored anywhere, and credentials in a snapshot cannot be recovered without it.
- **Folder structure** is preserved only on n8n Enterprise (the folder REST API is an Enterprise feature); community edition backups are flat — all workflows at root level
- **n8n version** is recorded in snapshot metadata when a Docker container is configured (`docker exec n8n --version`). n8n's public REST API does not expose the instance version, so this field is omitted from snapshots taken without a container.

---

### `flowsave restore [id]`

Restore a snapshot to an n8n instance.

```bash
flowsave restore 3
flowsave restore --snap 3                               # same thing

# Cross-instance restore (creates new workflows, never updates by ID)
flowsave restore 3 --to http://new-instance:5678 --api-key <key>

# With credential decryption
flowsave restore 3 --passphrase <passphrase>

# Cross-instance with credentials via local Docker (handles OAuth and all types)
flowsave restore 3 --to http://new-instance:5678 --api-key <key> \
  --target-container n8n-new --passphrase <passphrase>
```

| Flag | Description |
|------|-------------|
| `--to <url>` | Target instance URL (cross-instance mode) |
| `--api-key <key>` | Target API key — required when `--to` is used |
| `--target-container <name>` | Docker container on this machine for cross-instance credential import |
| `--passphrase <key>` | Passphrase to decrypt backed-up credentials |

**Credential restore behaviour:**
- **Same-instance** (no `--to`): credentials are imported via `docker exec` into the configured container, then stale credentials absent from the snapshot are automatically deleted.
- **Cross-instance** (with `--to`): credentials are imported via the n8n REST API — no Docker access required. Simple API-key credentials work reliably. OAuth credentials may fail schema validation (their exported data includes internal token state that the API rejects). Failed credentials are listed by name so you can re-add them manually.
- **Cross-instance + `--target-container`**: credentials are imported via `docker exec` into the specified container. This handles all credential types including OAuth without schema restrictions.

> **Note:** Cross-instance restore (`--to`) always creates new workflows on the target. Re-running will create duplicates — existing workflows on the target are never updated.

---

### `flowsave migrate`

Takes a fresh backup of your **current live instance** and restores it to a new instance in
one command. Always migrates the current state — not a historical snapshot.

```bash
flowsave migrate --to http://new-instance:5678 --api-key <key>

# With credential migration
flowsave migrate --to http://new-instance:5678 --api-key <key> --passphrase <passphrase>

# With Docker access to the destination (handles OAuth and all credential types)
flowsave migrate --to http://new-instance:5678 --api-key <key> \
  --target-container n8n-new --passphrase <passphrase>
```

| Flag | Description |
|------|-------------|
| `--to <url>` | Destination n8n instance URL *(required)* |
| `--api-key <key>` | Destination n8n API key *(required)* |
| `--target-container <name>` | Docker container on this machine for credential import (handles OAuth and all types) |
| `--passphrase <key>` | Passphrase for credential encryption/decryption |

Credentials are migrated via the n8n REST API by default (no Docker required on the destination). Use `--target-container` if the destination container is locally accessible — that path handles all credential types including OAuth without schema restrictions.

> **Want to restore a specific snapshot to a different instance?**
> Use `flowsave restore <id> --to <url> --api-key <key>` instead.

> **Note:** Each migration creates new workflows on the destination. Re-running will create duplicates — existing workflows on the destination are never updated. Use `flowsave diff` to compare snapshots before migrating again.

---

### `flowsave diff <id1> <id2>`

Compare two snapshots and show what changed.

```bash
flowsave diff 3 5
```

Shows added, removed, and modified workflows. For modified workflows, shows field-level context:
- `nodes: 4 → 6 (+2)` — node count change
- `active: true → false` — activation toggle
- `name: "Old" → "New"` — rename

When both snapshots include a credential backup, also shows added and removed credentials by name and type.

> **Note:** Credential diff tracks presence only (added/removed by ID). Renames are not detected — the credential data is encrypted and the name is metadata only. A type change always appears as a remove + add since it requires deleting and recreating the credential in n8n.

---

### `flowsave show <id>`

Show full details of a specific snapshot.

```bash
flowsave show 3
```

Displays metadata (date, instance URL, n8n version, size, credentials, folder backup) and a table of all workflows in the snapshot with name, active status, node count, and folder path.

---

### `flowsave list`

List all local snapshots in a table.

```bash
flowsave list
```

Shows snapshot ID, timestamp, workflow count, and size.

---

### `flowsave push`

Push the latest snapshot to the configured Git remote.

```bash
flowsave push
```

Requires `gitRemote` to be set in your config:

```bash
flowsave config set gitRemote git@github.com:you/n8n-backups.git
flowsave config set gitBranch backups   # optional, defaults to main
```

- The remote repository does not need to exist beforehand — Flowsave initializes a local git repo on first push and creates the remote branch automatically.
- Encrypted credential files (`_credentials.enc.json`) are excluded from git via `.gitignore`. Only workflow JSON and snapshot metadata are committed.
- The commit message includes the snapshot ID and timestamp: `chore: flowsave backup <timestamp> snapshot-<id>`.

---

### `flowsave config`

Manage your Flowsave configuration (`~/.flowsave/config.json`).

#### `flowsave config init`

Interactive setup wizard. Run this once after installing.

```bash
flowsave config init
```

Prompts for: instance URL, API key, Docker container name (optional, for credential backup), backup directory, Git remote (optional).

#### `flowsave config show`

Print the current configuration. The API key is masked.

```bash
flowsave config show
```

#### `flowsave config set <key> <value>`

Update a single field without re-running the full wizard.

```bash
flowsave config set gitRemote https://github.com/you/n8n-backups.git
flowsave config set gitBranch main
flowsave config set containerName n8n
flowsave config set backupDir /mnt/backups
```

---

### `flowsave delete <id> [id...]`

Permanently delete one or more snapshots from disk and from the local index.

```bash
flowsave delete 3              # prompts for confirmation
flowsave delete 3 --yes        # skip confirmation
flowsave delete 19 14 13       # delete multiple at once
flowsave delete 19 14 13 --yes # skip confirmation
```

| Flag | Description |
|------|-------------|
| `-y, --yes` | Skip the confirmation prompt |

---

### `flowsave prune`

Scan all local snapshots and remove any that are identical to a newer snapshot. Keeps the most recent copy of each distinct state.

Two snapshots are considered identical when all of the following are true:
- No workflows were added, removed, or modified
- No credentials were added or removed (compared via `_credentials.meta.json` when available — snapshots without this file are compared on workflows alone)

```bash
flowsave prune             # preview + prompt
flowsave prune --dry-run   # show what would be removed, don't delete
flowsave prune --yes       # skip confirmation
```

The command always shows a preview table before deleting:

```
  Found 2 redundant snapshots:
  ────────────────────────────────────────────────────
  #1    2026-06-09 08:00     1.2 KB      ≡ #3
  #2    2026-06-09 09:00     1.2 KB      ≡ #3
  ────────────────────────────────────────────────────
  Space freed               2.4 KB
  Snapshots kept            1
```

| Flag | Description |
|------|-------------|
| `--dry-run` | Show candidates without deleting anything |
| `-y, --yes` | Skip the confirmation prompt |

#### How the algorithm works

Prune walks snapshots from newest to oldest, keeping track of the last distinct state it has seen. Each snapshot is compared only to that most-recent distinct reference — not to every newer snapshot.

This means a snapshot that looks content-identical to the newest one can still be kept if an intermediate snapshot changed something between them:

```
#2  9 creds (Airtable present)   ← kept — differs from #3
#3  8 creds (Airtable removed)   ← kept — differs from #6
#4  9 creds                      ← pruned (≡ #6)
#5  9 creds                      ← pruned (≡ #6)
#6  9 creds (Airtable re-added)  ← kept (newest)
```

Snapshot #2 is kept even though its content matches #5 and #6 because the algorithm compares it to #3 (the last distinct reference), and they differ — #3 is the snapshot where Airtable was deleted. Pruning #2 would erase the last restore point from before that deletion event.

In short: prune removes consecutive duplicates, not all-time duplicates. Any snapshot that records a genuine state change is always preserved.

---

### `flowsave doctor`

Diagnose your setup. Checks config, n8n reachability, Docker container, and backup directory.

```bash
flowsave doctor
```

---

## Notes on n8n editions

| Feature | Community (free) | Enterprise |
|---------|-----------------|------------|
| Workflow backup & restore | ✅ | ✅ |
| Credential backup (source) | ✅ (requires Docker on source) | ✅ |
| Credential restore — same-instance | ✅ (docker exec + auto-prune stale) | ✅ |
| Credential restore — cross-instance (API) | ✅ (simple credentials; OAuth may fail) | ✅ |
| Credential restore — cross-instance (Docker) | ✅ (requires `--target-container`) | ✅ |
| Folder structure in backup | ✗ | ✅ |
| Folder structure on restore | ✗ | ✅ |

The folder REST API (`GET /api/v1/projects/{id}/folders`) is gated behind an n8n Enterprise license. On community edition, Flowsave backs up and restores all workflows flat — nothing is lost, subdirectory layout is just not preserved.

## Architecture

```
flowsave (monorepo)
├── packages/core     — business logic: n8n API client, encryption, backup/restore/migrate, diff, git sync
└── packages/cli      — CLI commands (commander); published as the npm package flowsave-cli
```

The CLI bundles `packages/core` at build time (tsup), so the published package has **zero runtime dependencies** and installs instantly.

## Status

🚧 Under active development. Star the repo to follow along.

## License

[Elastic License 2.0 (ELv2)](LICENSE) — free to use and self-host; cannot be offered as a managed service.
