# Contributing to Flowsave

## Local development setup

```bash
git clone https://github.com/achahid19/flowsave.git
cd flowsave
pnpm install          # install all workspace dependencies
pnpm build            # compile core + cli packages
npm install -g packages/cli   # install flowsave binary globally
flowsave --help       # verify the install
```

After making source changes, rebuild and reinstall:

```bash
pnpm build
npm install -g packages/cli
```

## Running tests

```bash
pnpm test             # all packages
pnpm test --filter=@flowsave/core   # core only
pnpm test --filter=flowsave         # cli only
```

## Lint

```bash
pnpm lint
```

## Project structure

```
packages/
  core/     — shared logic: n8n API client, encryption, backup/restore/migrate, diff, git sync
  cli/      — CLI commands, wraps core; distributed as the npm package `flowsave`
```

## Pull requests

- Open an issue first for non-trivial changes.
- Keep PRs focused — one concern per PR.
- All tests must pass (`pnpm test`).
- Lint must pass (`pnpm lint`).
- Add tests for new behaviour; do not reduce coverage.
- Security rule: the passphrase must never appear in logs, error messages, or any persisted file.

## Good first issues

Look for issues labelled `good first issue` in the GitHub issue tracker.
