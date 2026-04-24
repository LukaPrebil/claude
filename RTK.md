# RTK - Rust Token Killer

**Usage**: Token-optimized CLI proxy (60-90% savings on dev operations)

## Meta Commands (always use rtk directly)

```bash
rtk gain              # Show token savings analytics
rtk gain --history    # Show command usage history with savings
rtk discover          # Analyze Claude Code history for missed opportunities
rtk proxy <cmd>       # Execute raw command without filtering (for debugging)
```

## Installation Verification

```bash
rtk --version         # Should show: rtk X.Y.Z
rtk gain              # Should work (not "command not found")
which rtk             # Verify correct binary
```

⚠️ **Name collision**: If `rtk gain` fails, you may have reachingforthejack/rtk (Rust Type Kit) installed instead.

## Hook-Based Usage

All other commands are automatically rewritten by the Claude Code hook.
Example: `git status` → `rtk git status` (transparent, 0 tokens overhead)

Refer to CLAUDE.md for full command reference.

## Hook Bailouts to Avoid

The RTK hook silently falls back to raw output when a command contains shell
operators it cannot parse cleanly. To keep adoption high:

- **Do not append `2>&1`** — RTK filters already surface stderr usefully; the
  redirect suppresses the rewrite and loses the savings. Let failure output
  flow through naturally.
- Avoid command substitution (`$(...)`), pipes into interpreters
  (`| python -c`, `| node -e`), and compound commands (`&&`, `;`) when a
  simpler single-command form exists.

**Exception: `glab`** — RTK has no `glab` filter yet (tracked upstream at
rtk-ai/rtk#1085). Until that ships, `glab` commands bypass RTK regardless of
redirects, so `2>&1` is harmless there.
