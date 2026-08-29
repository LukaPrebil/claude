# Shared Agent Configuration

Shared behavioral configuration for Claude Code, Codex, and Pi. It provides structured workflows, safety boundaries, code standards, and reusable engineering skills from one repo.

The root `AGENTS.md` is the concise shared instruction source. `skills/`, `rules/`, and the historical `.claude/state/` path are shared across agent hosts. Hooks, permissions, notifications, and teammate mechanics remain host-specific.

Claude Code uses selective links under `~/.claude/`. Codex and Pi link their native instruction paths to `AGENTS.md`, while Codex and Pi discover the repo's skills through `~/.agents/skills`.

## Quick start

```bash
# Clone the repo - the setup script auto-detects its own location
git clone git@github.com:domengabrovsek/claude.git
cd claude

# Report drift without changing anything
bash scripts/setup-hosts.sh --check

# Create only missing links and safe Codex config defaults; refuse conflicts
bash scripts/setup-hosts.sh --apply

# After reviewing conflicts, move them to timestamped backups and link them
bash scripts/setup-hosts.sh --apply --adopt

# Strip ephemeral state Claude Code writes to settings.json at runtime
git config filter.strip-ephemeral-state.clean 'jq "del(.feedbackSurveyState)" 2>/dev/null || cat'
git config filter.strip-ephemeral-state.smudge cat
```

`--check` is read-only and exits nonzero when drift exists. `--apply` never replaces a real path or wrong symlink. `--adopt` is the only replacement mode, and it moves every conflict to an adjacent `<path>.bak.<timestamp>` backup instead of deleting it. The existing `scripts/setup-symlinks.sh` command remains a Claude-only compatibility wrapper.

For Codex, the bootstrap adds the shared-instruction fallback and a built-in TUI status line only when each setting is absent. It preserves an existing custom status line.

### Pi

Install Pi separately from the host configuration:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
bash scripts/setup-hosts.sh --apply --host pi
```

The Pi selector links global instructions under `PI_CODING_AGENT_DIR`, or `~/.pi/agent` when unset. It links shared skills under `~/.agents/skills`. These resources apply in interactive, print, JSON, and RPC modes. See [Pi's usage documentation](https://pi.dev/docs/latest/usage).

The bootstrap does not install or upgrade Pi. It does not manage providers, models, credentials, project trust, tools, or isolation. Pi has no built-in sandbox, so unattended work needs an external boundary. See [Pi's security guidance](https://pi.dev/docs/latest/security).

Pi has no built-in teammate mechanics. Shared workflows use their local fallback when they encounter `Agent` or `SendMessage`; a Pi teammate adapter remains a mechanical-parity gap.

## What's inside

- **`AGENTS.md`** - concise host-neutral instructions loaded by every supported host. See [ADR 0008](docs/adr/0008-share-agent-config-across-hosts.md).
- **`CLAUDE.md`** - thin Claude Code adapter that imports `AGENTS.md` and Claude's modular rules.
- **`rules/`** - detailed standards loaded directly by Claude Code and through the `rulebook` skill by other hosts.
- **`agents/`** - Claude Code expert teammate personas. Equivalent host mechanics are deferred; routing is in [`rules/agent-routing.md`](rules/agent-routing.md).
- **`skills/`** - shared workflows such as `grill-with-docs`, `build`, `debug`, `research`, and `verify-done`.
- **`hooks/`** - Claude Code automation wired into `settings.json`; host-specific parity is deferred.
- **`scripts/`** - the multi-host bootstrap, its Claude compatibility wrapper, and utilities used by hooks and skills.
- **`docs/adr/`** - Architecture Decision Records.
- **`references/`** - long-form checklists (security, testing) loaded by skills on demand.
- **`templates/`** - boilerplate for new ADRs and docs.

## More

- **Security boundaries** - deny list, Bash restrictions, and lock-file protection live in [`settings.json`](settings.json).
- **CI** - markdown linting on push/PR (`.github/workflows/`).
