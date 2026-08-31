#!/bin/bash
# Integration tests for the multi-host bootstrap. Every scenario uses a
# disposable HOME and a fake source repo; the caller's home is never read.

set -u

PROJECT_DIR=$(cd "$(dirname "$0")/.." && pwd)
SETUP="$PROJECT_DIR/scripts/setup-hosts.sh"
WRAPPER="$PROJECT_DIR/scripts/setup-symlinks.sh"
TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/setup-hosts-test.XXXXXX")
PASSED=0
FAILED=0

cleanup() {
  case "$TEST_ROOT" in
    "${TMPDIR:-/tmp}"/setup-hosts-test.*) rm -rf "$TEST_ROOT" ;;
    *) echo "Refusing to clean unexpected test path: $TEST_ROOT" >&2 ;;
  esac
}
trap cleanup EXIT HUP INT TERM

pass() {
  PASSED=$((PASSED + 1))
  echo "ok - $1"
}

fail() {
  FAILED=$((FAILED + 1))
  echo "not ok - $1" >&2
}

assert_success() {
  NAME="$1"
  shift
  if "$@" > "$CASE_DIR/output" 2>&1; then pass "$NAME"; else
    sed -n '1,200p' "$CASE_DIR/output" >&2
    fail "$NAME"
  fi
}

assert_failure() {
  NAME="$1"
  shift
  if "$@" > "$CASE_DIR/output" 2>&1; then
    sed -n '1,200p' "$CASE_DIR/output" >&2
    fail "$NAME"
  else
    pass "$NAME"
  fi
}

assert_true() {
  NAME="$1"
  shift
  if "$@"; then pass "$NAME"; else fail "$NAME"; fi
}

new_case() {
  CASE_DIR="$TEST_ROOT/$1"
  TEST_HOME="$CASE_DIR/home"
  TEST_REPO="$CASE_DIR/repo"
  mkdir -p "$TEST_HOME" "$TEST_REPO/.github" "$TEST_REPO/scripts"
  TEST_REPO=$(cd "$TEST_REPO" && pwd)
  for PATH_NAME in agents hooks rules skills scripts docs references; do
    mkdir -p "$TEST_REPO/$PATH_NAME"
  done
  : > "$TEST_REPO/CLAUDE.md"
  : > "$TEST_REPO/AGENTS.md"
  : > "$TEST_REPO/settings.json"
  : > "$TEST_REPO/scripts/statusline.sh"
  : > "$TEST_REPO/.github/pull_request_template.md"
}

run_setup() {
  HOME="$TEST_HOME" \
  CODEX_HOME="$TEST_HOME/.codex" \
  CLAUDE_CONFIG_DIR="$TEST_HOME/.claude" \
  AGENT_CONFIG_REPO="$TEST_REPO" \
  PI_CODING_AGENT_DIR="$TEST_HOME/.pi/agent" \
    bash "$SETUP" "$@"
}

run_setup_with_pi_dir() {
  PI_CODING_AGENT_DIR="$1" \
  HOME="$TEST_HOME" \
  CODEX_HOME="$TEST_HOME/.codex" \
  CLAUDE_CONFIG_DIR="$TEST_HOME/.claude" \
  CLAUDE_DOTFILES_REPO="$TEST_REPO" \
    bash "$SETUP" "${@:2}"
}

run_wrapper() {
  HOME="$TEST_HOME" \
  CODEX_HOME="$TEST_HOME/.codex" \
  CLAUDE_CONFIG_DIR="$TEST_HOME/.claude" \
  CLAUDE_DOTFILES_REPO="$TEST_REPO" \
    bash "$WRAPPER" "$@"
}

assert_link() {
  [ -L "$1" ] && [ "$(readlink "$1")" = "$2" ]
}

backup_count() {
  BACKUP_BASE="$1"
  COUNT=0
  for FOUND in "$BACKUP_BASE".bak.*; do
    [ -e "$FOUND" ] || [ -L "$FOUND" ] || continue
    COUNT=$((COUNT + 1))
  done
  printf "%s\n" "$COUNT"
}

# Check is auditable and has no side effects on an unconfigured home.
new_case check_no_mutation
assert_failure "check reports drift" run_setup --check
assert_true "check creates no host directories" test ! -e "$TEST_HOME/.claude"
assert_true "check creates no Codex config" test ! -e "$TEST_HOME/.codex"
assert_true "check creates no shared skills path" test ! -e "$TEST_HOME/.agents"

# A clean apply configures every selected host and Codex's narrow fallback.
new_case apply_all
assert_success "apply configures all hosts" run_setup --apply
while IFS='|' read -r NAME RELATIVE; do
  assert_true "Claude manifest includes $NAME" assert_link "$TEST_HOME/.claude/$NAME" "$TEST_REPO/$RELATIVE"
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
assert_true "Codex AGENTS.md is shared" assert_link "$TEST_HOME/.codex/AGENTS.md" "$TEST_REPO/AGENTS.md"
assert_true "Pi AGENTS.md is shared" assert_link "$TEST_HOME/.pi/agent/AGENTS.md" "$TEST_REPO/AGENTS.md"
assert_true "shared skills are repo-owned" assert_link "$TEST_HOME/.agents/skills" "$TEST_REPO/skills"
assert_true "Codex fallback is created" grep -Fq 'project_doc_fallback_filenames = ["CLAUDE.md"]' "$TEST_HOME/.codex/config.toml"
assert_true "Codex status line is created" grep -Fq 'status_line = ["project-name", "git-branch", "model-with-reasoning", "context-used", "five-hour-limit", "weekly-limit", "thread-credits", "estimated-thread-cost"]' "$TEST_HOME/.codex/config.toml"
assert_success "clean check exits zero" run_setup --check

# A Pi-only selection includes every shared resource Pi needs.
new_case pi_only
assert_success "Pi-only apply succeeds" run_setup --apply --host pi
assert_true "Pi-only apply links instructions" assert_link "$TEST_HOME/.pi/agent/AGENTS.md" "$TEST_REPO/AGENTS.md"
assert_true "Pi-only apply links shared skills" assert_link "$TEST_HOME/.agents/skills" "$TEST_REPO/skills"
assert_true "Pi-only apply skips Codex" test ! -e "$TEST_HOME/.codex"
assert_success "Pi-only check exits zero" run_setup --check --host pi
assert_success "Pi-only re-apply is idempotent" run_setup --apply --host pi
assert_true "Pi-only re-apply creates no instruction backup" test "$(backup_count "$TEST_HOME/.pi/agent/AGENTS.md")" -eq 0
assert_true "Pi-only re-apply creates no skill backup" test "$(backup_count "$TEST_HOME/.agents/skills")" -eq 0

# Pi follows its native config-directory override.
new_case pi_custom_dir
CUSTOM_PI_DIR="$CASE_DIR/custom-pi"
assert_success "Pi custom directory apply succeeds" run_setup_with_pi_dir "$CUSTOM_PI_DIR" --apply --host pi
assert_true "Pi custom directory receives instructions" assert_link "$CUSTOM_PI_DIR/AGENTS.md" "$TEST_REPO/AGENTS.md"
assert_true "Pi default directory stays absent" test ! -e "$TEST_HOME/.pi"
assert_true "Pi custom directory still gets shared skills" assert_link "$TEST_HOME/.agents/skills" "$TEST_REPO/skills"
assert_success "Pi custom directory check exits zero" run_setup_with_pi_dir "$CUSTOM_PI_DIR" --check --host pi

# Pi-only adoption recovers both host and shared-resource conflicts.
new_case pi_only_adopt
mkdir -p "$TEST_HOME/.pi/agent" "$TEST_HOME/.agents/skills"
printf "local instructions\n" > "$TEST_HOME/.pi/agent/AGENTS.md"
printf "local skill\n" > "$TEST_HOME/.agents/skills/local-skill"
assert_failure "Pi-only apply refuses conflicts" run_setup --apply --host pi
assert_success "Pi-only adopt resolves conflicts" run_setup --apply --adopt --host pi
assert_true "Pi-only adopt links instructions" assert_link "$TEST_HOME/.pi/agent/AGENTS.md" "$TEST_REPO/AGENTS.md"
assert_true "Pi-only adopt links shared skills" assert_link "$TEST_HOME/.agents/skills" "$TEST_REPO/skills"
assert_true "Pi-only adopt backs up instructions" test "$(backup_count "$TEST_HOME/.pi/agent/AGENTS.md")" -eq 1
assert_true "Pi-only adopt backs up shared skills" test "$(backup_count "$TEST_HOME/.agents/skills")" -eq 1

# A Codex-only selection includes the shared skills it discovers.
new_case codex_only
assert_success "Codex-only apply succeeds" run_setup --apply --host codex
assert_true "Codex-only apply links instructions" assert_link "$TEST_HOME/.codex/AGENTS.md" "$TEST_REPO/AGENTS.md"
assert_true "Codex-only apply links shared skills" assert_link "$TEST_HOME/.agents/skills" "$TEST_REPO/skills"
assert_true "Codex-only apply skips Pi" test ! -e "$TEST_HOME/.pi"

# Re-applying makes no backups or content changes.
new_case idempotent
assert_success "first idempotence apply succeeds" run_setup --apply
FIRST_CONFIG=$(cksum "$TEST_HOME/.codex/config.toml")
assert_success "second idempotence apply succeeds" run_setup --apply
SECOND_CONFIG=$(cksum "$TEST_HOME/.codex/config.toml")
assert_true "idempotent config is unchanged" test "$FIRST_CONFIG" = "$SECOND_CONFIG"
assert_true "idempotent apply creates no config backup" test "$(backup_count "$TEST_HOME/.codex/config.toml")" -eq 0

# Normal apply repairs missing paths but refuses exact conflicts.
new_case conflict_refusal
mkdir -p "$TEST_HOME/.agents/skills"
: > "$TEST_HOME/.agents/skills/local-skill"
assert_failure "apply refuses a real conflict" run_setup --apply
assert_true "refused conflict is preserved" test -f "$TEST_HOME/.agents/skills/local-skill"
assert_true "refused conflict is not replaced" test ! -L "$TEST_HOME/.agents/skills"
assert_true "safe missing links still apply" assert_link "$TEST_HOME/.codex/AGENTS.md" "$TEST_REPO/AGENTS.md"

# Adopt moves content to an adjacent backup and never deletes it.
new_case adopt_backup
mkdir -p "$TEST_HOME/.agents/skills"
printf "keep me\n" > "$TEST_HOME/.agents/skills/local-skill"
assert_success "adopt backs up a real conflict" run_setup --apply --adopt
assert_true "adopt installs the shared link" assert_link "$TEST_HOME/.agents/skills" "$TEST_REPO/skills"
ADOPTED_BACKUP=""
for FOUND in "$TEST_HOME/.agents/skills".bak.*; do
  [ -d "$FOUND" ] || continue
  ADOPTED_BACKUP="$FOUND"
done
assert_true "adopt backup retains content" grep -Fq "keep me" "$ADOPTED_BACKUP/local-skill"

# Wrong symlinks are conflicts too: refused normally, recoverably adopted.
new_case wrong_symlink
mkdir -p "$TEST_HOME/.codex" "$CASE_DIR/other"
ln -s "$CASE_DIR/other" "$TEST_HOME/.codex/AGENTS.md"
assert_failure "wrong symlink is refused without adopt" run_setup --apply --host codex
assert_true "wrong symlink remains untouched" assert_link "$TEST_HOME/.codex/AGENTS.md" "$CASE_DIR/other"
assert_success "wrong symlink can be adopted" run_setup --apply --adopt --host codex
assert_true "adopt replaces wrong symlink" assert_link "$TEST_HOME/.codex/AGENTS.md" "$TEST_REPO/AGENTS.md"
assert_true "wrong symlink itself is backed up" test "$(backup_count "$TEST_HOME/.codex/AGENTS.md")" -eq 1

# Existing Codex config is backed up before the root key is prepended.
new_case codex_existing
mkdir -p "$TEST_HOME/.codex"
printf '[features]\nweb_search = true\n' > "$TEST_HOME/.codex/config.toml"
assert_success "existing Codex config gets safe fallback" run_setup --apply --host codex
assert_true "existing Codex config has fallback at root" test "$(sed -n '1p' "$TEST_HOME/.codex/config.toml")" = 'project_doc_fallback_filenames = ["CLAUDE.md"]'
assert_true "existing Codex settings are preserved" grep -Fq 'web_search = true' "$TEST_HOME/.codex/config.toml"
assert_true "existing Codex config gets status line" grep -Fq 'status_line = ["project-name", "git-branch", "model-with-reasoning", "context-used", "five-hour-limit", "weekly-limit", "thread-credits", "estimated-thread-cost"]' "$TEST_HOME/.codex/config.toml"
assert_true "existing Codex config has one backup" test "$(backup_count "$TEST_HOME/.codex/config.toml")" -eq 1

# An existing tui table receives the default without creating a second table.
new_case codex_existing_tui
mkdir -p "$TEST_HOME/.codex"
printf '[tui]\nnotifications = true\n' > "$TEST_HOME/.codex/config.toml"
assert_success "existing tui table gets status line" run_setup --apply --host codex
assert_true "existing tui setting is preserved" grep -Fq 'notifications = true' "$TEST_HOME/.codex/config.toml"
assert_true "existing tui table is not duplicated" test "$(grep -c '^\[tui\]$' "$TEST_HOME/.codex/config.toml")" -eq 1
assert_true "status line is inside existing tui table" test "$(sed -n '/^\[tui\]$/,/^\[/p' "$TEST_HOME/.codex/config.toml" | grep -c '^status_line = ')" -eq 1

# A custom status line is preserved while an independent fallback is added.
new_case codex_custom_status
mkdir -p "$TEST_HOME/.codex"
printf '[tui]\nstatus_line = ["thread-id"]\n' > "$TEST_HOME/.codex/config.toml"
assert_success "custom Codex status line is preserved" run_setup --apply --host codex
assert_true "custom status line remains unchanged" grep -Fq 'status_line = ["thread-id"]' "$TEST_HOME/.codex/config.toml"
assert_true "custom status config gets fallback" test "$(sed -n '1p' "$TEST_HOME/.codex/config.toml")" = 'project_doc_fallback_filenames = ["CLAUDE.md"]'
assert_true "custom status migration has one backup" test "$(backup_count "$TEST_HOME/.codex/config.toml")" -eq 1

# A compatible fallback and custom status line are a complete no-op.
new_case codex_compatible
mkdir -p "$TEST_HOME/.codex"
printf 'project_doc_fallback_filenames = ["AGENT.md", "CLAUDE.md"]\n\n[tui]\nstatus_line = ["git-branch"]\n' > "$TEST_HOME/.codex/config.toml"
assert_success "compatible Codex fallback is unchanged" run_setup --apply --host codex
assert_true "compatible custom status is unchanged" grep -Fq 'status_line = ["git-branch"]' "$TEST_HOME/.codex/config.toml"
assert_true "compatible Codex config has no backup" test "$(backup_count "$TEST_HOME/.codex/config.toml")" -eq 0

new_case codex_incompatible
mkdir -p "$TEST_HOME/.codex"
printf 'project_doc_fallback_filenames = ["OTHER.md"]\n' > "$TEST_HOME/.codex/config.toml"
BEFORE=$(cksum "$TEST_HOME/.codex/config.toml")
assert_failure "different Codex fallback is refused" run_setup --apply --host codex
assert_true "different Codex fallback is untouched" test "$BEFORE" = "$(cksum "$TEST_HOME/.codex/config.toml")"
assert_true "different fallback creates no backup" test "$(backup_count "$TEST_HOME/.codex/config.toml")" -eq 0

new_case codex_check_no_mutation
mkdir -p "$TEST_HOME/.codex"
printf '[features]\nweb_search = true\n' > "$TEST_HOME/.codex/config.toml"
BEFORE=$(cksum "$TEST_HOME/.codex/config.toml")
assert_failure "Codex check reports missing fallback" run_setup --check --host codex
assert_true "Codex check preserves existing config" test "$BEFORE" = "$(cksum "$TEST_HOME/.codex/config.toml")"
assert_true "Codex check creates no backup" test "$(backup_count "$TEST_HOME/.codex/config.toml")" -eq 0

new_case codex_multiline
mkdir -p "$TEST_HOME/.codex"
printf 'project_doc_fallback_filenames = [\n  "CLAUDE.md",\n]\n' > "$TEST_HOME/.codex/config.toml"
assert_failure "multiline Codex fallback is refused" run_setup --apply --host codex

# Ambiguous tui layouts and duplicate status lines require a manual edit.
new_case codex_nested_tui
mkdir -p "$TEST_HOME/.codex"
printf 'project_doc_fallback_filenames = ["CLAUDE.md"]\n\n[tui.keymap]\nexample = "ctrl-e"\n' > "$TEST_HOME/.codex/config.toml"
BEFORE=$(cksum "$TEST_HOME/.codex/config.toml")
assert_failure "nested tui without parent is refused" run_setup --apply --host codex
assert_true "nested tui config is untouched" test "$BEFORE" = "$(cksum "$TEST_HOME/.codex/config.toml")"

new_case codex_duplicate_status
mkdir -p "$TEST_HOME/.codex"
printf 'project_doc_fallback_filenames = ["CLAUDE.md"]\n\n[tui]\nstatus_line = ["git-branch"]\nstatus_line = ["thread-id"]\n' > "$TEST_HOME/.codex/config.toml"
BEFORE=$(cksum "$TEST_HOME/.codex/config.toml")
assert_failure "duplicate Codex status lines are refused" run_setup --apply --host codex
assert_true "duplicate status config is untouched" test "$BEFORE" = "$(cksum "$TEST_HOME/.codex/config.toml")"

# The legacy command selects only Claude and retains automatic safe adoption.
new_case legacy_wrapper
mkdir -p "$TEST_HOME/.claude"
printf 'local\n' > "$TEST_HOME/.claude/CLAUDE.md"
assert_success "legacy wrapper applies and adopts Claude" run_wrapper
assert_true "legacy wrapper links Claude config" assert_link "$TEST_HOME/.claude/CLAUDE.md" "$TEST_REPO/CLAUDE.md"
assert_true "legacy wrapper backs up Claude conflict" test "$(backup_count "$TEST_HOME/.claude/CLAUDE.md")" -eq 1
assert_true "legacy wrapper does not configure Codex" test ! -e "$TEST_HOME/.codex"
assert_true "legacy wrapper does not configure Pi" test ! -e "$TEST_HOME/.pi"
assert_true "legacy wrapper does not configure shared skills" test ! -e "$TEST_HOME/.agents"
assert_success "legacy --check remains report-only" run_wrapper --check
assert_success "legacy -n remains report-only" run_wrapper -n
assert_success "legacy --dry-run remains report-only" run_wrapper --dry-run

echo ""
echo "$PASSED passed; $FAILED failed"
[ "$FAILED" -eq 0 ]
