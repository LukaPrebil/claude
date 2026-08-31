# ADR 0009: Pi adapter vendors settings and extensions into every agent dir

- **Status**: Accepted
- **Date**: 2026-08-31
- **Deciders**: Luka Prebil Grintal

## Context

The multi-host bootstrap (ADR 0008) linked `AGENTS.md` and shared skills for Pi, but left the resources that make Pi personal unmanaged: the `statusline.ts` footer extension lived untracked in `~/.pi-personal/agent/extensions/`, and `settings.json` (packages, theme, provider defaults) was hand-maintained with a manual personal-to-work-dir symlink chain. Neither was visible to `setup-hosts.sh --check`, and neither survived a new machine without tribal steps. Pi also offers a native package model (`pi install git:`) that could consume this repo as a version-pinned package instead of symlinks.

## Decision

Link `pi/extensions/` and `pi/settings.json` into every configured pi agent dir alongside `AGENTS.md`, selected by `PI_CONFIG_DIRS` (space-separated list), which defaults to the base dir plus the personal-account dir (`~/.pi/agent ~/.pi-personal/agent`). The single-dir `PI_CODING_AGENT_DIR` override still wins when set. Consumption stays symlink-based; pi-specific files live under `pi/` because the repo root is the inherited claude layout.

## Consequences

- One `setup-hosts.sh --apply` configures both pi accounts; `--check` finally sees the personal dir.
- `settings.json` follows the Claude pattern: tracked, with `strip-ephemeral-state` also dropping `lastChangelogVersion`; runtime rewrites stay git-clean.
- The checkout path becomes load-bearing on every machine: moving or deleting it breaks all linked hosts at once.
- The script now diverges from upstream's pi host (which links only `AGENTS.md`); merges carry that known delta.
- New harnesses join by adding an adapter dir plus a host selector, not a second repo.

## Alternatives Considered

- **pi package (`pi install git:`)**: versioned pins and a clean pi-managed clone, but the edit loop becomes commit-push-update, `pi install` writes package entries into the very `settings.json` we symlink, and the shared `~/.agents/skills` link double-loads skills without package filtering. Rejected for a single-operator repo (pinnability and distribution buy nothing here); the root layout stays package-shaped so a later switch costs one `pi install`, not a restructure.
- **Keep personal-dir chaining** (personal dir symlinking the base dir's files): worked, but was invisible to `--check`, undocumented, and required machine-specific memory. Rejected for the explicit dual-dir loop.
- **Symmetric adapter dirs for every host** (`claude/` alongside `pi/`): cleaner shape, but moves the most-churned upstream files (`settings.json`, `hooks/`) and turns every upstream merge into rename/edit conflicts. Deferred until upstream syncing no longer matters.