# Contributing to Flowsave

Thanks for your interest in making Flowsave better! This guide covers everything you need to go from `git clone` to a merged PR.

Flowsave is an open-source CLI for backing up, restoring, and migrating [n8n](https://n8n.io) instances. If you self-host n8n, you are exactly the kind of contributor we want.

## Quick links

- [Project structure](#project-structure)
- [Local development setup](#local-development-setup)
- [Development workflow](#development-workflow)
- [Branching & commits](#branching--commits)
- [Pull request checklist](#pull-request-checklist)
- [Security rules](#security-rules-non-negotiable)
- [Good first issues](#good-first-issues)

## Project structure

Flowsave is a pnpm monorepo orchestrated with Turborepo:

```
packages/
  core/     — pure business logic: n8n API client, AES-256-GCM encryption,
              backup/restore/migrate, diff, prune, git sync. No CLI concerns.
  cli/      — the user-facing CLI (commander + inquirer + chalk + ora).
              Published to npm as `flowsave-cli`; the binary command is `flowsave`.
```

**The boundary rule:** `core` never imports from `cli`. All user interaction (prompts, spinners, colors, `process.exit`) lives in `cli`; all logic that could one day power the agent or dashboard lives in `core`.

At publish time, tsup bundles `core` and every dependency into a single file — the npm package has zero runtime dependencies. You never publish manually; a CI pipeline does it on version tags (maintainers only).

## Local development setup

**Prerequisites:** Node.js ≥ 18, [pnpm](https://pnpm.io) ≥ 10, and Docker if you want to test credential backup (optional).

```bash
git clone https://github.com/achahid19/flowsave.git
cd flowsave
pnpm install          # install all workspace dependencies
pnpm build            # build core (tsc) + cli (tsup)
npm install -g "$(pwd)/packages/cli" --force   # install the flowsave binary globally
flowsave --help       # verify the install
```

> The absolute path matters: `npm install -g packages/cli` would be interpreted as a GitHub shorthand, not a local folder.

To test against a real n8n instance, the easiest path is a throwaway Docker container:

```bash
docker run -d --name n8n-test -p 5679:5678 n8nio/n8n
flowsave config init   # point it at http://localhost:5679
```

## Development workflow

The edit-test loop:

```bash
pnpm build                          # rebuild after source changes
npm install -g "$(pwd)/packages/cli" --force   # refresh the global binary
flowsave <command>                  # try it
```

> The global binary does **not** auto-update from source — always rebuild and reinstall before manual testing.

Run checks the same way CI does:

```bash
pnpm test                           # all packages (vitest)
pnpm --filter @flowsave/core test   # core only
pnpm --filter flowsave-cli test     # cli only
pnpm lint                           # eslint — zero errors AND zero warnings expected
pnpm audit --audit-level=high       # security audit
```

### Writing tests

- Every new module in `core` gets a test file in `packages/core/src/__tests__/`.
- CLI commands are tested in `packages/cli/src/__tests__/` with mocked core functions.
- Gotcha: `vi.clearAllMocks()` does **not** drain `mockReturnValueOnce` queues — use `vi.resetAllMocks()` or `.mockReset()` between describe blocks.
- Lint enforces explicit return types and forbids the `!` non-null assertion — use `?.` optional chaining.

## Branching & commits

`main` is protected: no direct pushes, PRs only, and all three CI jobs (**Build & Test**, **Lint**, **Security Audit**) must pass before merge.

**Branch naming:**

| Prefix | Use for |
|--------|---------|
| `feat/` | new features |
| `fix/` | bug fixes |
| `docs/` | documentation only |
| `chore/` | tooling, dependencies, maintenance |

**Commit messages** follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(cli): add --dry-run flag to prune
fix(git-sync): use HEAD:<branch> refspec for push
docs(readme): expand flowsave push section
```

The scope is the package or module you touched (`cli`, `core`, `git-sync`, `release`, `readme`, …).

## Pull request checklist

Before opening a PR, confirm:

- [ ] Branch is up to date with `main` (strict status checks require it)
- [ ] `pnpm build` passes with zero TypeScript errors
- [ ] `pnpm test` passes — and new behaviour has new tests
- [ ] `pnpm lint` passes with zero errors and zero warnings
- [ ] One concern per PR — split unrelated changes
- [ ] For non-trivial changes, an issue exists describing the problem first
- [ ] User-facing changes are reflected in `README.md`

A maintainer will review as soon as possible. Small, focused PRs get merged fastest.

## Security rules (non-negotiable)

Flowsave handles n8n credentials. These rules apply to every line of code:

1. **The passphrase must never appear** in logs, error messages, or any persisted file.
2. **Plaintext credentials are never written to disk** without deletion in a `finally` block.
3. **Encrypted credential blobs (`_credentials.enc.json`) never leave the user's machine** — they are excluded from git sync by design.
4. No telemetry, no phoning home. Backup data stays local.

PRs that violate any of these will be asked to change regardless of how useful the feature is.

## Good first issues

Look for the [`good first issue`](https://github.com/achahid19/flowsave/labels/good%20first%20issue) label in the issue tracker. Typical starter tasks:

- Improving error messages or `flowsave doctor` checks
- Adding flags to existing commands (with tests)
- Documentation fixes and examples

Not sure where to start? Open an issue describing what you'd like to work on, or pick any open bug and comment that you're taking it.

## Code of conduct

Be kind, be constructive, assume good intent. Harassment or hostility of any kind is not tolerated. Report conduct issues privately to the maintainer via GitHub.

## License

Flowsave is licensed under the [Elastic License 2.0](LICENSE) — free to use, modify, and self-host; cannot be offered as a managed service. By contributing, you agree your contributions are licensed under the same terms.
