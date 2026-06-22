# Flowsave CLI — Documentation Knowledge Base

> Source-of-truth content file for building the Flowsave documentation page.
> Every flag, prompt, output, and exit code below is extracted from the actual
> command implementations (`packages/cli/src/commands/`) — not from memory.
> Verified against `flowsave-cli@0.1.1`.

---

## 1. Product overview

**One-liner:** The backup, restore, and migration layer that n8n instance is missing.

**What it is:** Flowsave is an open-source CLI for self-hosted [n8n](https://n8n.io) instances. It snapshots your workflows, folder structure, and encrypted credentials to local disk, lets you compare and restore any snapshot, migrate a full instance to a new server in one command, and optionally version your backups in a Git repository.

**Who it's for:** n8n self-hosters — anyone running n8n in Docker, on a VPS, or on bare metal who has ever lost a workflow to a bad upgrade, a deleted container, or a fat-fingered edit.

**Design principles (use these in docs copy):**
- **Local-first.** All snapshots live on the user's machine. No telemetry, no phoning home, no account required.
- **Credentials are sacred.** Always encrypted at rest (AES-256-GCM), never in logs, never pushed to git.
- **One binary, zero dependencies.** The npm package is a single self-contained file.
- **Honest output.** Every command ends with a summary that says exactly what happened — including what *didn't* happen and why.

---

## 2. Installation

```bash
npm install -g flowsave-cli
```

- The **npm package** is `flowsave-cli`; the **installed command** is `flowsave`.
- Requires **Node.js ≥ 18**.
- The n8n instance must be reachable over HTTP(S) from the machine running Flowsave.

### Docker requirement (credential backup only)

Workflow backup needs only the n8n REST API. **Credential** backup/restore additionally uses `docker exec` to call the n8n CLI inside the container, so Docker must be usable **without sudo**:

```bash
# Linux one-time setup
sudo usermod -aG docker $USER   # then log out and back in
```

macOS with Docker Desktop needs nothing — it already runs as the current user. `flowsave doctor` verifies the whole setup.

---

## 3. Core concepts

### Snapshot
A point-in-time copy of an n8n instance: all workflows as individual JSON files, optional folder structure, optional encrypted credentials, plus metadata. Snapshots get sequential integer IDs (`1`, `2`, `3`, …) and live under the configured backup directory.

### Configuration
A single JSON file at `~/.flowsave/config.json`, created by the interactive wizard (`flowsave config init`). All commands read it; none work without it (they exit with a pointer to `config init`).

### Credential encryption
Credentials are exported from the n8n container, encrypted with a user-supplied passphrase, and stored as one opaque blob. **The passphrase is never stored anywhere** — Flowsave cannot recover credentials if it is lost. This is a feature, not a limitation; say so plainly in the docs.

### The two credential transport paths
1. **Docker path** (`docker exec` into a container) — handles **all** credential types including OAuth. Used for backup (source container) and for restore when a local container is available.
2. **API path** (n8n REST API) — no Docker needed, works across machines. Simple API-key credentials import cleanly; **OAuth credentials may fail** schema validation because their exported data contains internal token state the API rejects. Failures are listed by name so the user can re-add them manually.

### n8n editions
The folder REST API is an n8n **Enterprise** feature. On community edition, backups are complete but **flat** — folder layout is not preserved. Flowsave detects this and says so in every relevant summary.

---

## 4. Quick start (3 commands)

```bash
flowsave config init      # one-time interactive setup
flowsave backup           # take your first snapshot
flowsave list             # see all snapshots
```

---

## 5. Command reference

> Doc-page note: each command below is a self-contained section with synopsis,
> flags, interactive behavior, output anatomy, exit codes, examples, and
> troubleshooting. Suggested anchor slug in parentheses.

---

### 5.1 `flowsave config` (#config)

Manage the Flowsave configuration file (`~/.flowsave/config.json`).

#### `flowsave config init`

Interactive setup wizard. Run once after installing.

**Prompts, in order:**

| Prompt | Default | Validation |
|---|---|---|
| n8n instance URL | `http://localhost:5678` | must parse as a URL |
| API key (from n8n Settings → API) | — | required, non-empty; input masked with `*` |
| Docker container name | blank | optional — blank disables credential backup |
| Backup directory | `~/.flowsave/backups` | — |
| Git remote URL | blank | optional — blank disables `flowsave push` |
| Git branch | `main` | only asked if a git remote was entered |

**Behavior notes:**
- If a config already exists, asks `Overwrite?` (default **No**) before touching anything.
- Makes **no API calls** during setup — it only writes the file. Connectivity is verified by `flowsave doctor` or the first `backup`.
- On success prints the config path and suggests `flowsave backup`.

#### `flowsave config show`

Prints the current configuration with the **API key masked** (first 8 + last 4 characters visible). Also prints the config file path. Exits 1 with a pointer to `config init` if no config exists.

#### `flowsave config set <key> <value>`

Updates a single field without re-running the wizard.

**Valid keys:** `instanceUrl`, `apiKey`, `containerName`, `backupDir`, `gitRemote`, `gitBranch`, `dashboardToken`. Any other key exits 1 and lists the valid keys. The merged config is re-validated before writing.

```bash
flowsave config set gitRemote git@github.com:you/n8n-backups.git
flowsave config set gitBranch backups
flowsave config set containerName n8n
```

---

### 5.2 `flowsave backup` (#backup)

Snapshot all workflows and (optionally) encrypted credentials from the configured instance.

```bash
flowsave backup
```

**No flags.** Credential backup is controlled by config + an interactive prompt.

**Interactive behavior (only when `containerName` is configured):**
1. `Set a passphrase to encrypt credentials (leave blank to skip):` — masked input, validated **inline** against the passphrase policy (see §7). Blank skips credentials entirely.
2. `Confirm passphrase:` — must match exactly, otherwise the backup **aborts with exit 1** before anything is written.

**Output anatomy — Snapshot Summary:**
- Snapshot ID, instance URL, n8n version (when detectable — see note), timestamp, workflow count
- Folder structure: `✓ included` / `✗ not included` (Enterprise-only)
- Credentials: `✓ encrypted & included` / `— not included`
- Snapshot size, saved-to path

**Contextual notices printed after the summary:**
- Folder structure missing → explains the Enterprise folder API limitation
- Passphrase used → **retention warning**: credentials in this snapshot are permanently locked to the passphrase just entered, with the exact restore command to use later
- Blank passphrase → `Credentials were skipped (no passphrase entered).`
- No container configured → how to enable credential backup via `config set containerName`

**n8n version note:** recorded only when a Docker container is configured (`docker exec n8n --version`). n8n's public REST API does not expose the version, so API-only snapshots omit it.

**Exit codes:** `0` success · `1` passphrase mismatch, connectivity failure, or any backup error.

---

### 5.3 `flowsave restore [id]` (#restore)

Restore a snapshot to the same instance or to a different one.

```bash
flowsave restore 3                  # same-instance
flowsave restore --snap 3           # identical — flag form
flowsave restore 3 --to http://new:5678 --api-key <key>          # cross-instance
flowsave restore 3 --to http://new:5678 --api-key <key> \
  --target-container n8n-new --passphrase <pass>                 # cross-instance + Docker creds
```

**Arguments & flags:**

| Flag | Description |
|---|---|
| `[id]` (positional) | Snapshot ID to restore |
| `--snap <id>` | Alternative to the positional argument |
| `--to <url>` | Target instance URL — switches to cross-instance mode |
| `--api-key <key>` | Target API key — **required with `--to`**, rejected without it |
| `--target-container <name>` | Local Docker container for cross-instance credential import (handles OAuth and all types) |
| `--passphrase <key>` | Passphrase to decrypt the snapshot's credentials |

**Validation rules:**
- Missing ID → exit 1 with usage + pointer to `flowsave list`
- Non-integer ID → exit 1
- `--to` without `--api-key` (or vice-versa) → exit 1: *"--to and --api-key must be used together"*

**Interactive behavior:** if no `--passphrase` was given and credentials could be restorable (cross-instance mode, or same-instance with a configured container), prompts once: `Passphrase for credential decryption (leave blank to skip credentials):`. Blank skips credentials.

**Mode semantics (critical for docs):**
- **Same-instance** (no `--to`): workflows are updated/created by ID; stale credentials absent from the snapshot are automatically deleted after Docker import.
- **Cross-instance** (`--to`): **always creates new workflows** (`forceCreate`) — never updates by ID. Re-running duplicates everything. The CLI prints this notice on every cross-instance run.

**Output anatomy — Restore Summary:**
- Snapshot ID, source instance, target instance
- Mode: `cross-instance (always create)` / `same-instance (update/create)`
- Workflows restored, snapshot size
- Folder structure: recreated / not recreated (target may lack Enterprise) / not in snapshot
- Credentials, one of four labels:
  - `✓ N/N imported via API` (or `⚠ N/M … (X failed)`)
  - `✓ decrypted & imported (docker)`
  - `— skipped (no passphrase or no container)`
  - `— snapshot has no credentials`
- **Credential Import Detail** (API path only): per-credential ✓/✗ with name and type; failures get an explanation block about OAuth token state and the `--target-container` escape hatch
- Non-fatal warnings list (folder recreation failures, activation skips, …)

**Exit codes:** `0` success · `1` validation or restore error.

---

### 5.4 `flowsave migrate` (#migrate)

Take a **fresh backup of the live source instance** and restore it to a destination, in one command. Always migrates current state — never a historical snapshot (use `restore --to` for that; the CLI cross-references this in its docs note).

```bash
flowsave migrate --to http://new:5678 --api-key <key>
flowsave migrate --to http://new:5678 --api-key <key> --passphrase <pass>
flowsave migrate --to http://new:5678 --api-key <key> \
  --target-container n8n-new --passphrase <pass>
```

**Flags:**

| Flag | Required | Description |
|---|---|---|
| `--to <url>` | ✅ | Destination n8n instance URL |
| `--api-key <key>` | ✅ | Destination n8n API key |
| `--target-container <name>` | — | Local Docker container for credential import (OAuth-safe path) |
| `--passphrase <key>` | — | Passphrase for credential encryption/decryption |

**Interactive behavior (no `--passphrase` given):**
1. `Set a passphrase to encrypt migrated credentials (leave blank to skip):` — masked, policy-validated inline, blank skips credentials
2. `Confirm passphrase:` — mismatch aborts with exit 1

**Why migrate asks to "set" (not "enter") a passphrase — explain in docs:** migrate creates a *fresh* backup, so there is no existing encryption to validate against. The passphrase entered becomes the new encryption for this snapshot. That's also why confirmation matters: a typo would permanently lock the snapshot's credentials.

**Progress UX:** spinner shows `Step 1/2: Backing up source instance...` then `Step 2/2: Restoring to destination instance...`.

**Output anatomy — Migration Summary:**
- Snapshot ID (the migration leaves a normal snapshot behind — restorable later), source, destination, source n8n version (when available), workflows migrated, size
- Folder backup (source side) and folder restore (destination side), independently reported
- Credentials label (same four states as restore)
- Per-credential import detail (API path)
- **Passphrase retention warning** with the exact future restore command
- Edition notices (flat migration on community source; folder recreation failure on destination)
- **Duplicate notice** (printed every run): each migration creates new workflows; re-running duplicates them; use `flowsave diff` before migrating again
- Non-fatal warnings from both steps

**Exit codes:** `0` success · `1` passphrase mismatch, missing required flags, or any step failing.

---

### 5.5 `flowsave list` (#list)

List all local snapshots in a table, newest first. Purely local — no API calls.

```bash
flowsave list
```

**Columns:** ID · Timestamp · Size · Instance URL (truncated at 40 chars). Empty state prints: `No snapshots yet. Run 'flowsave backup' to take your first snapshot.`

---

### 5.6 `flowsave show <id>` (#show)

Full details of one snapshot. Purely local.

```bash
flowsave show 3
```

**Output anatomy:**
- **Header:** date, instance, n8n version (when recorded), workflow count, size
- **Credentials line, three states:** `— not included` · `✓ included (N credentials)` · `✓ included (names not available — older snapshot)` (snapshots taken before credential metadata existed)
- **Folder backup:** included / not included (community edition)
- **Credentials table** (when metadata exists): #, Name (sorted, truncated at 34 chars), Type. Names only — the credential data itself stays encrypted.
- **Workflows table:** #, Name, Active (✓/✗), Nodes (count), Folder path, Tags — sorted by name, all columns truncation-safe

**Exit codes:** `0` success · `1` invalid or unknown snapshot ID.

---

### 5.7 `flowsave diff <id1> <id2>` (#diff)

Compare two snapshots. Purely local.

```bash
flowsave diff 3 5
```

**Reports:**
- **Added / removed workflows** by name
- **Modified workflows** with field-level context:
  - `nodes: 4 → 6 (+2)` — node count change
  - `active: true → false` — activation toggle
  - `name: "Old" → "New"` — rename
- **Credential changes** (only when *both* snapshots carry credential metadata): added and removed credentials by name and type

**Documented limitations (state these):**
- Credential diff tracks **presence only** (by ID). Renames are invisible — the data is encrypted, the name is metadata.
- A credential type change appears as remove + add (matching how n8n itself requires delete-and-recreate).

**Exit codes:** `0` success · `1` non-integer IDs or unknown snapshots.

---

### 5.8 `flowsave delete <id> [id...]` (#delete)

Permanently delete one or more snapshots from disk and the local index.

```bash
flowsave delete 3
flowsave delete 19 14 13
flowsave delete 19 14 13 --yes
```

| Flag | Description |
|---|---|
| `-y, --yes` | Skip the confirmation prompt |

**Behavior:**
- Accepts multiple IDs; duplicates are de-duplicated
- Unknown IDs are each reported (`✗ Snapshot N not found.`); if *some* IDs are valid the command continues with those, if *none* are valid it exits 1
- Without `--yes`: prints the full list (ID, date, size) and asks once — `Delete N snapshots?` (default **No**)
- Per-snapshot success/failure lines; a final count when more than one was deleted

**Exit codes:** `0` success or user-aborted · `1` invalid/missing IDs.

---

### 5.9 `flowsave prune` (#prune)

Remove snapshots whose content is identical to a newer snapshot — keep the most recent copy of each distinct state.

```bash
flowsave prune             # preview + confirm
flowsave prune --dry-run   # preview only
flowsave prune --yes       # no confirmation
```

| Flag | Description |
|---|---|
| `--dry-run` | Show candidates without deleting anything |
| `-y, --yes` | Skip the confirmation prompt |

**Behavior:**
- Fewer than 2 snapshots → `Nothing to prune` and exits cleanly
- **Always shows the preview first** (even without `--dry-run`): a table of redundant snapshots (`#id  date  size  ≡ #keeper`), space freed, snapshots kept — then asks for confirmation (default **No**)

**"Identical" means** (both must hold):
1. Zero workflows added, removed, or modified
2. Zero credentials added or removed — compared via `_credentials.meta.json`; older snapshots without that file are compared on workflows alone

**The algorithm (worth a diagram on the docs page):** prune walks newest → oldest, comparing each snapshot only to the **last distinct reference**, not to the absolute newest. Consequence: a snapshot that looks identical to the newest one is still kept if an intermediate snapshot changed something in between — that preserves the last restore point before every deletion/change event. Prune removes *consecutive* duplicates, never all-time duplicates.

```
#2  9 creds (Airtable present)   ← kept — differs from #3
#3  8 creds (Airtable removed)   ← kept — differs from #6
#4  9 creds                      ← pruned (≡ #6)
#5  9 creds                      ← pruned (≡ #6)
#6  9 creds (Airtable re-added)  ← kept (newest)
```

**Exit codes:** `0` success, nothing-to-do, or user-aborted · `1` on errors.

---

### 5.10 `flowsave push` (#push)

Commit the latest snapshot to a git repository in the backup directory and push it to the configured remote.

```bash
flowsave push
```

**No flags.** Configuration comes from `gitRemote` (required) and `gitBranch` (default `main`):

```bash
flowsave config set gitRemote git@github.com:you/n8n-backups.git
flowsave config set gitBranch backups   # optional
```

**Behavior (each point is docs-worthy):**
- The remote repo **does not need to exist as a branch beforehand** — Flowsave initializes a local git repo in the backup directory on first push and creates the remote branch automatically (`push -u origin HEAD:<branch>`)
- A `.gitignore` is written so **encrypted credential blobs (`_credentials.enc.json`) never enter git** — only workflow JSON and snapshot metadata are committed
- Commit message format: `chore: flowsave backup <ISO-timestamp> snapshot-<id>`
- Commits only when there are staged changes, but **always pushes** — so changing `gitBranch` propagates even with no new snapshot
- Git authentication is the user's own (SSH keys / credential store) — Flowsave never touches or stores git credentials

**Errors:** no `gitRemote` configured → exit 1 with the fix; no snapshots → exit 1 pointing to `flowsave backup`.

---

### 5.11 `flowsave doctor` (#doctor)

Diagnose the local setup. Four checks, each reported as ✓/✗; never throws.

```bash
flowsave doctor
```

**Checks, in order:**

| # | Check | Pass condition | Failure detail |
|---|---|---|---|
| 1 | Config | `~/.flowsave/config.json` exists and validates | validation message; **subsequent checks are skipped** |
| 2 | n8n instance | `GET /api/v1/workflows?limit=1` succeeds within 5s | distinguishes `401` (*connected but API key is invalid*) from network errors and other HTTP statuses |
| 3 | Docker (only if `containerName` set) | daemon reachable without sudo **and** the named container is running | permission-denied gets the exact fix: `sudo usermod -aG docker $USER` + relogin |
| 4 | Backup dir | directory exists/creatable and writable | path and reason |

**Exit codes:** `0` all checks pass (`✓ All checks passed. Ready to backup.`) · `1` any check fails (with count).

---

## 6. Configuration reference (#configuration)

File: `~/.flowsave/config.json` — created by `config init`, edited by `config set`, readable via `config show`.

| Key | Required | Default | Used by | Description |
|---|---|---|---|---|
| `instanceUrl` | ✅ | `http://localhost:5678` | all API commands | Base URL of the n8n instance |
| `apiKey` | ✅ | — | all API commands | n8n API key (n8n Settings → API). Masked in all output |
| `containerName` | — | unset | backup, restore, migrate, doctor | Docker container name; enables credential backup/restore via `docker exec` |
| `backupDir` | ✅ | `~/.flowsave/backups` | all snapshot commands | Local snapshot storage; `~` is expanded |
| `gitRemote` | — | unset | push | Git remote URL for `flowsave push` |
| `gitBranch` | — | `main` | push | Branch pushed to |
| `dashboardToken` | — | unset | (reserved) | Future agent/dashboard connectivity |

---

## 7. Security model (#security)

> Docs page: give this its own prominent section. It's the product's main trust argument.

### Encryption at rest
- **Cipher:** AES-256-GCM (authenticated encryption — tampering is detected, not just hidden)
- **Key derivation:** scrypt, cost N=16384, r=8, p=1 — deliberately slow against brute force
- **Per-snapshot randomness:** fresh 32-byte salt and 12-byte IV on every encryption
- **Blob layout:** `[salt 32B][iv 12B][authTag 16B][ciphertext]` — one self-contained file, `_credentials.enc.json`

### Passphrase policy (enforced in core — no CLI path can bypass it)
- Minimum **12 characters**
- At least one **uppercase** letter
- At least one **lowercase** letter
- At least one **digit or special character**

Validation happens inline in the prompt (immediate feedback, no retry loop) and again inside `encrypt()`.

### Passphrase lifecycle
- Entered twice (set + confirm) for `backup` and `migrate`; mismatch aborts before anything is written
- **Never stored, never logged, never in error messages, never in any persisted file**
- Lost passphrase = unrecoverable credentials for that snapshot, by design. Workflows are unaffected (they are not encrypted)

### What never leaves the machine
- Encrypted credential blobs are excluded from `flowsave push` via `.gitignore`
- No telemetry of any kind; the only network calls are to the user's own n8n instances and their own git remote

---

## 8. Storage layout (#storage)

```
~/.flowsave/
├── config.json                  # configuration (API key in plain text — local file, chmod-protected)
├── index.json                   # snapshot index: id, timestamp, instanceUrl, sizeBytes
└── backups/                     # = backupDir (configurable)
    ├── .git/                    # created by flowsave push (optional)
    ├── .gitignore               # excludes _credentials.enc.json
    └── <id>/                    # one directory per snapshot
        ├── meta.json            # snapshot metadata (counts, versions, flags)
        ├── <Workflow Name>.json # one file per workflow (root level = no folder)
        ├── <Folder>/…           # subdirectories mirror n8n folders (Enterprise only)
        ├── _credentials.enc.json   # encrypted credential blob (optional)
        └── _credentials.meta.json  # credential names+types, NO secrets (optional)
```

Workflow JSON files are the **raw n8n export format** — they round-trip losslessly and are readable/diffable in any editor or git UI.

---

## 9. Error handling & exit codes (#errors)

**Philosophy:** never show a stack trace; always show a human-readable message; attach an actionable hint when one exists; exit 1.

| Situation | Message style | Hint |
|---|---|---|
| Invalid/missing config | the specific validation error | `Run "flowsave config init" …` |
| Network failure (ECONNREFUSED, ENOTFOUND, ETIMEDOUT, fetch failed) | `Cannot reach n8n instance: <detail>` | `Run "flowsave doctor" …` |
| Wrong passphrase on restore | decryption failure (GCM auth tag mismatch) | — |
| Anything else | the error's own message | — |

**Exit code summary:** `0` = success, nothing-to-do, or user answered "No" to a confirmation. `1` = any validation failure, aborted passphrase confirmation, failed health check, or runtime error. (Useful for scripting/cron.)

---

## 10. Edition compatibility matrix (#editions)

| Feature | Community (free) | Enterprise |
|---|---|---|
| Workflow backup & restore | ✅ | ✅ |
| Credential backup (source) | ✅ requires Docker on source | ✅ |
| Credential restore — same-instance | ✅ docker exec + auto-prune stale | ✅ |
| Credential restore — cross-instance (API) | ✅ simple creds; OAuth may fail | ✅ |
| Credential restore — cross-instance (Docker) | ✅ with `--target-container` | ✅ |
| Folder structure in backup | ✗ | ✅ |
| Folder structure on restore | ✗ | ✅ |

The folder REST API (`GET /api/v1/projects/{id}/folders`) is license-gated. Community backups lose nothing — layout is just flat.

---

## 11. Troubleshooting / FAQ (#faq)

**"Cannot reach n8n instance"** → `flowsave doctor`. Checks URL, API key (distinguishes invalid key from network failure), Docker, and backup dir in one run.

**"Permission denied" on credential backup (Linux)** → user isn't in the `docker` group: `sudo usermod -aG docker $USER`, then log out/in. Doctor detects and prints exactly this.

**OAuth credentials failed during cross-instance restore/migrate** → expected on the API path; their exported data carries internal token state the n8n API rejects. Either re-add them manually in the target UI, or re-run with `--target-container <name>` if the destination container is locally accessible — the Docker path has no schema restrictions.

**I forgot the passphrase for snapshot N** → credentials in that snapshot are unrecoverable (by design — nothing is stored that could recover them). Workflows are unaffected. Take a new backup with a new passphrase.

**Re-running migrate/cross-instance restore duplicated my workflows** → documented behavior: cross-instance operations always create, never update. Compare first with `flowsave diff`, clean up duplicates on the target manually.

**`flowsave push` says nothing changed but I switched branches** → it still pushes; the remote branch is created/updated even without a new commit.

**Snapshot says "names not available — older snapshot"** → credential name metadata (`_credentials.meta.json`) was introduced after that snapshot was taken. The credentials themselves are intact and restorable.

**Why doesn't my snapshot show the n8n version?** → version detection needs `docker exec` (the public API doesn't expose it). Configure `containerName` to record it.

---

## 12. Glossary (#glossary)

| Term | Definition |
|---|---|
| **Snapshot** | One point-in-time backup with a sequential integer ID |
| **Same-instance restore** | Restore to the configured instance; updates workflows by ID |
| **Cross-instance restore** | Restore to another instance (`--to`); always creates new workflows |
| **Docker path** | Credential transport via `docker exec` + n8n CLI; handles all credential types |
| **API path** | Credential transport via n8n REST API; no Docker, OAuth-limited |
| **Prune** | Removal of consecutive content-identical snapshots |
| **Retention warning** | Post-backup/migrate notice that the snapshot's credentials are locked to the entered passphrase |

---

## 13. Doc-page builder notes (meta)

- **Suggested information architecture:** Overview → Install → Quick start → Commands (one page or deep-linked section per command, in the order of §5) → Configuration → Security → Editions → Troubleshooting.
- **Command page template:** synopsis code block → one-paragraph description → flags table → interactive prompts (if any) → annotated example output → exit codes → "Related" links.
- **Tone:** confident, factual, no marketing fluff inside reference pages; the value-prop language from §1 belongs on the landing/overview page only.
- **High-value visuals:** the prune algorithm walk (§5.9), the two credential transport paths (§3), the storage tree (§8), the encrypted blob layout (§7).
- **Keep in sync:** this file mirrors `flowsave-cli@0.1.1`. When commands change, update this KB in the same PR — it is the single source the docs page builds from.
