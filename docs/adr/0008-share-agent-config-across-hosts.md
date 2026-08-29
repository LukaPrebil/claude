# Share agent configuration across hosts

Use the root `AGENTS.md` as the concise shared instruction source and `skills/` as the shared skill library for Claude Code, Codex, and Pi. `CLAUDE.md` imports the shared instructions, while the host bootstrap links each host's native paths to the same files and leaves hooks, permissions, and teammate mechanics in host-specific adapters; this avoids duplicated guidance without disrupting the existing Claude setup.
