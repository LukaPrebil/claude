#!/bin/bash
# Non-destructive bootstrap for shared Claude Code, Codex, and Pi config.
# Bash 3.2 compatible; replacements are always recoverable adjacent backups.

set -u

MODE=""
ADOPT=0
HOST="all"

usage() {
  cat <<'EOF'
Usage: scripts/setup-hosts.sh (--check|--apply) [--adopt] [--host HOST]

Modes:
  --check          Report drift without changing the filesystem.
  --apply          Create missing links and add safe Codex fallback config.
  --apply --adopt  Also move exact conflicts to timestamped backups, then link.

Hosts: all (default), claude, codex, pi, shared

Environment:
  AGENT_CONFIG_REPO     Repo to link (preferred generic override).
  CLAUDE_DOTFILES_REPO Backward-compatible repo override.
  CLAUDE_CONFIG_DIR    Claude config directory (default: ~/.claude).
  CODEX_HOME           Codex config directory (default: ~/.codex).
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --check)
      [ -z "$MODE" ] || { echo "Choose exactly one of --check or --apply." >&2; exit 2; }
      MODE="check"
      ;;
    --apply)
      [ -z "$MODE" ] || { echo "Choose exactly one of --check or --apply." >&2; exit 2; }
      MODE="apply"
      ;;
    --adopt)
      ADOPT=1
      ;;
    --host)
      shift
      [ "$#" -gt 0 ] || { echo "--host requires a value." >&2; exit 2; }
      HOST="$1"
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

[ -n "$MODE" ] || { echo "Choose --check or --apply." >&2; usage >&2; exit 2; }
[ "$ADOPT" -eq 0 ] || [ "$MODE" = "apply" ] || {
  echo "--adopt is valid only with --apply." >&2
  exit 2
}

case "$HOST" in
  all|claude|codex|pi|shared) ;;
  *) echo "Unknown host: $HOST" >&2; exit 2 ;;
esac

if [ -n "${AGENT_CONFIG_REPO:-}" ]; then
  REPO="$AGENT_CONFIG_REPO"
elif [ -n "${CLAUDE_DOTFILES_REPO:-}" ]; then
  REPO="$CLAUDE_DOTFILES_REPO"
else
  SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
  CANDIDATE=$(cd "$SCRIPT_DIR/.." && pwd)
  if [ -d "$CANDIDATE/.git" ] || git -C "$CANDIDATE" rev-parse --git-dir >/dev/null 2>&1; then
    REPO="$CANDIDATE"
  else
    REPO="$HOME/dev/claude"
  fi
fi

if [ ! -d "$REPO" ]; then
  echo "Repo not found at $REPO." >&2
  echo "Set AGENT_CONFIG_REPO (or CLAUDE_DOTFILES_REPO) to override." >&2
  exit 1
fi
REPO=$(cd "$REPO" && pwd)

CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
PI_DIR="$HOME/.pi/agent"
SHARED_DIR="$HOME/.agents"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
ISSUES=0

host_enabled() {
  [ "$HOST" = "all" ] || [ "$HOST" = "$1" ]
}

report() {
  printf "%-34s %-13s %s\n" "$1" "$2" "$3"
}

mark_issue() {
  ISSUES=$((ISSUES + 1))
}

next_backup() {
  BACKUP_CANDIDATE="$1.bak.$TIMESTAMP"
  BACKUP_NUMBER=1
  while [ -e "$BACKUP_CANDIDATE" ] || [ -L "$BACKUP_CANDIDATE" ]; do
    BACKUP_CANDIDATE="$1.bak.$TIMESTAMP.$BACKUP_NUMBER"
    BACKUP_NUMBER=$((BACKUP_NUMBER + 1))
  done
  printf "%s\n" "$BACKUP_CANDIDATE"
}

ensure_parent() {
  PARENT=$(dirname "$1")
  if [ -d "$PARENT" ]; then
    return 0
  fi
  mkdir -p "$PARENT"
}

manage_link() {
  LABEL="$1"
  LIVE="$2"
  TARGET="$3"

  if [ ! -e "$TARGET" ] && [ ! -L "$TARGET" ]; then
    report "$LABEL" "MISSING-SRC" "$TARGET"
    mark_issue
    return
  fi

  if [ -L "$LIVE" ]; then
    CURRENT=$(readlink "$LIVE")
    if [ "$CURRENT" = "$TARGET" ]; then
      report "$LABEL" "OK" "already correct"
      return
    fi
    if [ "$MODE" = "check" ]; then
      report "$LABEL" "WRONG-LINK" "$CURRENT (expected $TARGET)"
      mark_issue
      return
    fi
    if [ "$ADOPT" -eq 0 ]; then
      report "$LABEL" "REFUSED" "wrong link; re-run with --adopt"
      mark_issue
      return
    fi
    BACKUP=$(next_backup "$LIVE")
    if mv "$LIVE" "$BACKUP" && ln -s "$TARGET" "$LIVE"; then
      report "$LABEL" "ADOPTED" "backup: $BACKUP"
    else
      report "$LABEL" "FAILED" "could not back up and link"
      mark_issue
    fi
    return
  fi

  if [ -e "$LIVE" ]; then
    if [ "$MODE" = "check" ]; then
      report "$LABEL" "CONFLICT" "real path (requires --adopt)"
      mark_issue
      return
    fi
    if [ "$ADOPT" -eq 0 ]; then
      report "$LABEL" "REFUSED" "real path; re-run with --adopt"
      mark_issue
      return
    fi
    BACKUP=$(next_backup "$LIVE")
    if mv "$LIVE" "$BACKUP" && ln -s "$TARGET" "$LIVE"; then
      report "$LABEL" "ADOPTED" "backup: $BACKUP"
    else
      report "$LABEL" "FAILED" "could not back up and link"
      mark_issue
    fi
    return
  fi

  if [ "$MODE" = "check" ]; then
    report "$LABEL" "MISSING" "would link to $TARGET"
    mark_issue
    return
  fi

  if ensure_parent "$LIVE" && ln -s "$TARGET" "$LIVE"; then
    report "$LABEL" "CREATED" "$TARGET"
  else
    report "$LABEL" "FAILED" "could not create link"
    mark_issue
  fi
}

manage_codex_config() {
  CONFIG="$CODEX_DIR/config.toml"
  FALLBACK='project_doc_fallback_filenames = ["CLAUDE.md"]'
  STATUS_LINE='status_line = ["project-name", "git-branch", "model-with-reasoning", "context-used", "five-hour-limit", "weekly-limit", "thread-credits", "estimated-thread-cost"]'
  FALLBACK_MANUAL="manually set TOML root: $FALLBACK"
  STATUS_MANUAL="manually set under [tui]: $STATUS_LINE"
  ADD_FALLBACK=1
  ADD_STATUS=1
  TUI_COUNT=0

  if [ -L "$CONFIG" ] || { [ -e "$CONFIG" ] && [ ! -f "$CONFIG" ]; }; then
    report "codex/config.toml" "REFUSED" "must be a regular file; $FALLBACK_MANUAL"
    mark_issue
    return
  fi

  if [ -f "$CONFIG" ]; then
    KEY_INFO=$(awk '
      /^[[:space:]]*\[/ { in_table=1 }
      /^[[:space:]]*project_doc_fallback_filenames[[:space:]]*=/ {
        if (in_table) print "table:" $0; else print "root:" $0
      }
    ' "$CONFIG")
    KEY_COUNT=$(printf "%s\n" "$KEY_INFO" | awk 'NF { count++ } END { print count+0 }')

    if [ "$KEY_COUNT" -gt 1 ]; then
      report "codex/config.toml" "REFUSED" "multiple fallback keys; $FALLBACK_MANUAL"
      mark_issue
      return
    fi
    if [ "$KEY_COUNT" -eq 1 ]; then
      case "$KEY_INFO" in
        root:*'['*CLAUDE.md*']'*)
          ADD_FALLBACK=0
          ;;
        root:*)
          report "codex/config.toml" "REFUSED" "fallback differs or is multiline; $FALLBACK_MANUAL"
          mark_issue
          return
          ;;
        table:*)
          report "codex/config.toml" "REFUSED" "fallback is not at TOML root; $FALLBACK_MANUAL"
          mark_issue
          return
          ;;
      esac
    fi

    STATUS_INFO=$(awk '
      /^[[:space:]]*\[/ {
        if (!seen_table) seen_table=1
        in_tui = ($0 ~ /^[[:space:]]*\[tui\][[:space:]]*(#.*)?$/)
      }
      !seen_table && /^[[:space:]]*tui[.]status_line[[:space:]]*=/ { print "root:" $0 }
      in_tui && /^[[:space:]]*status_line[[:space:]]*=/ { print "tui:" $0 }
    ' "$CONFIG")
    STATUS_COUNT=$(printf "%s\n" "$STATUS_INFO" | awk 'NF { count++ } END { print count+0 }')
    TUI_COUNT=$(awk '/^[[:space:]]*\[tui\][[:space:]]*(#.*)?$/ { count++ } END { print count+0 }' "$CONFIG")

    if [ "$STATUS_COUNT" -gt 1 ]; then
      report "codex/config.toml" "REFUSED" "multiple status lines; $STATUS_MANUAL"
      mark_issue
      return
    fi
    if [ "$STATUS_COUNT" -eq 1 ]; then
      ADD_STATUS=0
    elif [ "$TUI_COUNT" -gt 1 ]; then
      report "codex/config.toml" "REFUSED" "multiple [tui] tables; $STATUS_MANUAL"
      mark_issue
      return
    elif [ "$TUI_COUNT" -eq 0 ]; then
      TUI_AMBIGUOUS=$(awk '
        /^[[:space:]]*\[/ { seen_table=1 }
        /^[[:space:]]*\[tui[.]/ { found=1 }
        !seen_table && /^[[:space:]]*tui[.]/ { found=1 }
        END { print found+0 }
      ' "$CONFIG")
      if [ "$TUI_AMBIGUOUS" -eq 1 ]; then
        report "codex/config.toml" "REFUSED" "nested or dotted tui config; $STATUS_MANUAL"
        mark_issue
        return
      fi
    fi
  fi

  if [ "$ADD_FALLBACK" -eq 0 ] && [ "$ADD_STATUS" -eq 0 ]; then
    report "codex/config.toml" "OK" "fallback and status line configured"
    return
  fi

  if [ "$MODE" = "check" ]; then
    if [ "$ADD_FALLBACK" -eq 1 ]; then
      report "codex/config.toml" "MISSING" "would add root fallback key"
      mark_issue
    fi
    if [ "$ADD_STATUS" -eq 1 ]; then
      report "codex/config.toml" "MISSING" "would add default status line"
      mark_issue
    fi
    return
  fi

  if ! ensure_parent "$CONFIG"; then
    report "codex/config.toml" "FAILED" "could not create parent directory"
    mark_issue
    return
  fi

  if [ -f "$CONFIG" ]; then
    CONFIG_BACKUP=$(next_backup "$CONFIG")
    if ! mv "$CONFIG" "$CONFIG_BACKUP"; then
      report "codex/config.toml" "FAILED" "could not create backup"
      mark_issue
      return
    fi
    if {
      if [ "$ADD_FALLBACK" -eq 1 ]; then
        printf "%s\n" "$FALLBACK"
      fi
      if [ "$ADD_FALLBACK" -eq 1 ] && [ -s "$CONFIG_BACKUP" ]; then
        printf "\n"
      fi
      awk -v add_status="$ADD_STATUS" -v prepended="$ADD_FALLBACK" -v status_line="$STATUS_LINE" '
        { print }
        add_status && $0 ~ /^[[:space:]]*\[tui\][[:space:]]*(#.*)?$/ {
          print status_line
          inserted=1
        }
        END {
          if (add_status && !inserted) {
            if (NR > 0 || prepended) print ""
            print "[tui]"
            print status_line
          }
        }
      ' "$CONFIG_BACKUP"
    } > "$CONFIG"; then
      if [ "$ADD_FALLBACK" -eq 1 ] && [ "$ADD_STATUS" -eq 1 ]; then
        CONFIG_CHANGE="added fallback and status line"
      elif [ "$ADD_FALLBACK" -eq 1 ]; then
        CONFIG_CHANGE="added root fallback"
      else
        CONFIG_CHANGE="added status line"
      fi
      report "codex/config.toml" "UPDATED" "$CONFIG_CHANGE; backup: $CONFIG_BACKUP"
    else
      FAILED_COPY=$(next_backup "$CONFIG.failed")
      mv "$CONFIG" "$FAILED_COPY" 2>/dev/null || true
      mv "$CONFIG_BACKUP" "$CONFIG" 2>/dev/null || true
      report "codex/config.toml" "FAILED" "write failed; original restored if possible"
      mark_issue
    fi
  elif {
    printf "%s\n\n" "$FALLBACK"
    printf "[tui]\n%s\n" "$STATUS_LINE"
  } > "$CONFIG"; then
    report "codex/config.toml" "CREATED" "root fallback and status line"
  else
    report "codex/config.toml" "FAILED" "could not create config"
    mark_issue
  fi
}

printf "%-34s %-13s %s\n" "PATH" "STATE" "DETAIL"
printf "%-34s %-13s %s\n" "----" "-----" "------"

if host_enabled claude; then
  while IFS='|' read -r NAME RELATIVE; do
    [ -n "$NAME" ] || continue
    manage_link "claude/$NAME" "$CLAUDE_DIR/$NAME" "$REPO/$RELATIVE"
  done <<'EOF'
CLAUDE.md|CLAUDE.md
settings.json|settings.json
agents|agents
hooks|hooks
rules|rules
skills|skills
scripts|scripts
docs|docs
references|references
statusline.sh|scripts/statusline.sh
pull_request_template.md|.github/pull_request_template.md
EOF
fi

if host_enabled codex; then
  manage_link "codex/AGENTS.md" "$CODEX_DIR/AGENTS.md" "$REPO/AGENTS.md"
  manage_codex_config
fi

if host_enabled pi; then
  manage_link "pi/AGENTS.md" "$PI_DIR/AGENTS.md" "$REPO/AGENTS.md"
fi

if host_enabled shared; then
  manage_link "shared/skills" "$SHARED_DIR/skills" "$REPO/skills"
fi

echo ""
if [ "$ISSUES" -eq 0 ]; then
  if [ "$MODE" = "check" ]; then
    echo "All selected host configuration is current."
  else
    echo "All selected host configuration is in place. Repo: $REPO"
  fi
  exit 0
fi

echo "$ISSUES selected configuration issue(s) remain." >&2
exit 1
