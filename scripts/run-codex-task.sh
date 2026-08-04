#!/usr/bin/env bash
set -Eeuo pipefail

# This wrapper intentionally starts from a minimal environment. It preserves
# the local Codex authentication directory, but does not forward repository
# .env values or unrelated service credentials into the isolated run.

SCRIPT_NAME="$(basename "$0")"
BUILD_REQUESTED=0
TASK_ARG=""
REPO_ROOT=""
TASK_PATH=""
TASK_RELATIVE=""
START_COMMIT=""
RUN_DIR=""
WORKDIR=""
LOG_DIR=""
RESULTS_FILE=""
REPORT_PATH=""
PATCH_PATH=""
DIFF_STAT_PATH=""
CHANGED_FILES_PATH=""
NPMRC_PATH=""
CODEX_FINAL_MESSAGE_PATH=""
CODEX_EVENTS_PATH=""
CODEX_BIN=""
LOCAL_CODEX_HOME=""
RUNTIME_HOME=""

INSTALL_STATUS=125
CODEX_STATUS=125
UNEXPECTED_COMMIT=0
FORBIDDEN_PATH=0
SENSITIVE_SCOPE=0
REMOTE_REMAINS=0
SECRET_TERM_WARNING=0
REQUIRED_FAILURE=0

usage() {
  printf 'Usage: %s [--build] <task-file>\n' "$SCRIPT_NAME" >&2
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

preserve_run_dir() {
  local status=$?
  if [[ -n "${RUN_DIR:-}" ]]; then
    printf 'Run directory preserved: %s\n' "$RUN_DIR" >&2
  fi
  return "$status"
}

trap preserve_run_dir EXIT

parse_args() {
  local argument

  for argument in "$@"; do
    case "$argument" in
      --build)
        [[ "$BUILD_REQUESTED" -eq 0 ]] || { usage; exit 64; }
        BUILD_REQUESTED=1
        ;;
      -*)
        usage
        exit 64
        ;;
      *)
        [[ -z "$TASK_ARG" ]] || { usage; exit 64; }
        TASK_ARG="$argument"
        ;;
    esac
  done

  [[ -n "$TASK_ARG" ]] || { usage; exit 64; }
}

require_command() {
  local command_name=$1
  command -v "$command_name" >/dev/null 2>&1 || fail "required command not found: $command_name"
}

resolve_task_path() {
  local candidate

  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || fail "run this script inside a Git repository"
  REPO_ROOT="$(cd "$REPO_ROOT" && pwd -P)"

  if [[ "$TASK_ARG" == /* ]]; then
    candidate="$TASK_ARG"
  else
    candidate="$REPO_ROOT/$TASK_ARG"
  fi

  TASK_PATH="$(realpath -e -- "$candidate" 2>/dev/null)" || fail "task file does not exist: $TASK_ARG"
  case "$TASK_PATH" in
    "$REPO_ROOT"/*) ;;
    *) fail "task file must be inside the repository: $TASK_ARG" ;;
  esac
  [[ -f "$TASK_PATH" ]] || fail "task path is not a regular file: $TASK_ARG"
  TASK_RELATIVE="${TASK_PATH#"$REPO_ROOT"/}"
}

validate_task_file() {
  local heading
  local headings=(Task Scope Constraints Validation Completion)

  for heading in "${headings[@]}"; do
    grep -Fqx "# $heading" "$TASK_PATH" || fail "task file is missing the '# $heading' heading"
  done
}

check_source_preflight() {
  local status

  START_COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD)" || fail "unable to resolve the starting commit"
  status="$(git -C "$REPO_ROOT" status --porcelain=v1 --untracked-files=all)"
  if [[ -n "$status" ]]; then
    printf '%s\n' "Source repository is not clean; refusing to clone or run Codex." >&2
    printf '%s\n' "$status" >&2
    fail "checkpoint the source repository before running an automated task"
  fi
}

create_run_directory() {
  local tmp_root="${TMPDIR:-/tmp}"

  RUN_DIR="$(mktemp -d "$tmp_root/optn-codex-task.XXXXXX")" || fail "unable to create an isolated run directory"
  chmod 700 "$RUN_DIR"
  WORKDIR="$RUN_DIR/repository"
  LOG_DIR="$RUN_DIR/logs"
  RESULTS_FILE="$RUN_DIR/validation-results.tsv"
  REPORT_PATH="$RUN_DIR/agent-report.md"
  PATCH_PATH="$RUN_DIR/agent.patch"
  DIFF_STAT_PATH="$RUN_DIR/agent-diff-stat.txt"
  CHANGED_FILES_PATH="$RUN_DIR/agent-changed-files.txt"
  NPMRC_PATH="$RUN_DIR/npmrc"
  CODEX_FINAL_MESSAGE_PATH="$RUN_DIR/codex-final-message.md"
  CODEX_EVENTS_PATH="$RUN_DIR/codex-events.jsonl"
  RUNTIME_HOME="$RUN_DIR/home"

  mkdir -p "$LOG_DIR" "$RUNTIME_HOME" "$RUN_DIR/config" "$RUN_DIR/tmp"
  : > "$NPMRC_PATH"
  : > "$RESULTS_FILE"
}

clone_repository() {
  local clone_log="$LOG_DIR/clone.log"
  local remote_name

  if ! git clone --no-local --no-hardlinks "$REPO_ROOT" "$WORKDIR" >"$clone_log" 2>&1; then
    fail "unable to clone the starting commit; see $clone_log"
  fi
  git -C "$WORKDIR" checkout --detach "$START_COMMIT" >>"$clone_log" 2>&1 || fail "unable to check out the starting commit"

  while IFS= read -r remote_name; do
    [[ -n "$remote_name" ]] || continue
    git -C "$WORKDIR" remote remove "$remote_name" >>"$clone_log" 2>&1 || fail "unable to remove cloned Git remote: $remote_name"
  done < <(git -C "$WORKDIR" remote)

  [[ -z "$(git -C "$WORKDIR" remote)" ]] || fail "isolated repository still has a Git remote"
  [[ -f "$WORKDIR/$TASK_RELATIVE" ]] || fail "task file is not present at the starting commit: $TASK_RELATIVE"
}

configure_safe_environment() {
  local home_value="${HOME:-}"

  [[ -n "$home_value" ]] || fail "HOME is required to locate the local Codex authentication session"
  LOCAL_CODEX_HOME="${CODEX_HOME:-$home_value/.codex}"
}

safe_env() {
  env -i \
    HOME="$RUNTIME_HOME" \
    PATH="$PATH" \
    USER="${USER:-codex}" \
    TMPDIR="$RUN_DIR/tmp" \
    LANG="${LANG:-C.UTF-8}" \
    LC_ALL="${LC_ALL:-C.UTF-8}" \
    TERM="${TERM:-dumb}" \
    XDG_CONFIG_HOME="$RUN_DIR/config" \
    CODEX_HOME="$LOCAL_CODEX_HOME" \
    NPM_CONFIG_USERCONFIG="$NPMRC_PATH" \
    CI=1 \
    NO_COLOR=1 \
    "$@"
}

run_check() {
  local phase=$1
  local name=$2
  local log_file="$LOG_DIR/${phase}-${name}.log"
  local status=0
  shift 2

  printf 'Running %s/%s...\n' "$phase" "$name"
  if (cd "$WORKDIR" && safe_env "$@") >"$log_file" 2>&1; then
    status=0
  else
    status=$?
  fi
  printf '%s\t%s\t%s\t%s\n' "$phase" "$name" "$status" "$log_file" >> "$RESULTS_FILE"
  LAST_CHECK_STATUS=$status
}

run_validation_set() {
  local phase=$1

  run_check "$phase" deps-check npm run deps:check
  run_check "$phase" format-check npm run format:check
  run_check "$phase" typecheck-core npm run typecheck:core
  run_check "$phase" addons-validate npm run addons:validate
  run_check "$phase" security-test npm run security:test
  run_check "$phase" lint-core npm run lint:core
  run_check "$phase" test-core npm run test:core
  run_check "$phase" test-ui npm run test:ui
  if [[ "$BUILD_REQUESTED" -eq 1 ]]; then
    run_check "$phase" build npm run build
  fi
}

result_status() {
  local phase=$1
  local name=$2

  awk -F '\t' -v expected_phase="$phase" -v expected_name="$name" \
    '$1 == expected_phase && $2 == expected_name { print $3; found = 1 } END { if (!found) print 125 }' \
    "$RESULTS_FILE" | tail -n 1
}

write_codex_prompt() {
  local task_content
  local agents_content

  task_content="$(<"$WORKDIR/$TASK_RELATIVE")"
  agents_content="$(<"$WORKDIR/AGENTS.md")"
  {
    printf '%s\n\n' 'Work only inside the provided isolated repository.'
    printf '%s\n' 'Inspect relevant code and tests before editing. Make the smallest coherent change.'
    printf '%s\n' 'Read and follow the complete AGENTS.md and task definition below.'
    printf '%s\n' 'Run the focused test identified by the task when safe, but do not run live-network tests, native packaging, signing, broadcasting, deployment, release, or external-infrastructure flows.'
    printf '%s\n' 'Do not install dependencies or applications. Do not commit, push, tag, merge, publish, or release.'
    printf '%s\n\n' 'Finish with a concise report of the root cause, files changed, checks run, and remaining risks.'
    printf '%s\n\n' '--- AGENTS.md ---'
    printf '%s\n\n' "$agents_content"
    printf '%s\n\n' '--- TASK FILE ---'
    printf '%s\n' "$task_content"
  } > "$RUN_DIR/codex-prompt.md"
}

run_codex() {
  local status=0

  write_codex_prompt
  printf 'Running Codex in the isolated repository...\n'
  if safe_env "$CODEX_BIN" exec \
    --cd "$WORKDIR" \
    --sandbox workspace-write \
    --json \
    --output-last-message "$CODEX_FINAL_MESSAGE_PATH" \
    < "$RUN_DIR/codex-prompt.md" > "$CODEX_EVENTS_PATH" 2>&1; then
    status=0
  else
    status=$?
  fi
  CODEX_STATUS=$status
}

collect_changed_paths() {
  {
    git -C "$WORKDIR" diff --name-only "$START_COMMIT" --
    git -C "$WORKDIR" ls-files --others --exclude-standard
  } | sort -u > "$RUN_DIR/all-changed-paths.txt"

  git -C "$WORKDIR" status --short --untracked-files=all > "$CHANGED_FILES_PATH"
  {
    git -C "$WORKDIR" diff --stat "$START_COMMIT" --
    if [[ -s "$RUN_DIR/all-changed-paths.txt" ]]; then
      printf '\nUntracked files:\n'
      git -C "$WORKDIR" ls-files --others --exclude-standard
    fi
  } > "$DIFF_STAT_PATH"
}

is_forbidden_path() {
  case "$1" in
    .env|.env.*|*.jks|*.keystore|android/key.properties|android/app/google-services.json|\
      .github/workflows/*|wallets|wallets/*|*.optn|src-tauri/resources/tor|src-tauri/resources/tor/*|\
      node_modules|node_modules/*|dist|dist/*|dist-extension-chrome|dist-extension-chrome/*|\
      dist-extension-firefox|dist-extension-firefox/*|target|target/*|src-tauri/target|src-tauri/target/*|\
      android/.gradle|android/.gradle/*|android/build|android/build/*|android/app/build|android/app/build/*|\
      android/app/src/main/assets|android/app/src/main/assets/*|ios/App/App/public|ios/App/App/public/*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

scope_mentions() {
  local needle=$1
  local scope_text=$2
  local trimmed="${needle%/}"

  [[ "$scope_text" == *"$needle"* || "$scope_text" == *"$trimmed"* ]]
}

inspect_safety() {
  local path
  local scope_text
  local final_head

  scope_text="$(awk '/^# Scope$/{inside=1; next} /^# /{if (inside) exit} inside{print}' "$TASK_PATH")"
  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    if is_forbidden_path "$path"; then
      FORBIDDEN_PATH=1
    fi
    case "$path" in
      package.json|package-lock.json|cashscript/*|src/apis/ContractManager/artifacts/*|android/*|ios/*|src-tauri/*)
        if ! scope_mentions "$path" "$scope_text"; then
          case "$path" in
            package.json|package-lock.json) scope_mentions "$(basename "$path")" "$scope_text" || SENSITIVE_SCOPE=1 ;;
            cashscript/*) scope_mentions "cashscript/" "$scope_text" || SENSITIVE_SCOPE=1 ;;
            src/apis/ContractManager/artifacts/*) scope_mentions "src/apis/ContractManager/artifacts/" "$scope_text" || SENSITIVE_SCOPE=1 ;;
            android/*) scope_mentions "android/" "$scope_text" || SENSITIVE_SCOPE=1 ;;
            ios/*) scope_mentions "ios/" "$scope_text" || SENSITIVE_SCOPE=1 ;;
            src-tauri/*) scope_mentions "src-tauri/" "$scope_text" || SENSITIVE_SCOPE=1 ;;
          esac
        fi
        ;;
    esac
  done < "$RUN_DIR/all-changed-paths.txt"

  final_head="$(git -C "$WORKDIR" rev-parse HEAD)"
  [[ "$final_head" == "$START_COMMIT" ]] || UNEXPECTED_COMMIT=1
  [[ -z "$(git -C "$WORKDIR" remote)" ]] || REMOTE_REMAINS=1
  if grep -Eiq -- 'mnemonic|seed[[:space:]]+phrase|recovery[[:space:]]+phrase|private[[:space:]]+key|xprv|keystore[[:space:]]+password' "$PATCH_PATH"; then
    SECRET_TERM_WARNING=1
  fi
}

write_patch() {
  local path
  local status

  : > "$PATCH_PATH"
  git -C "$WORKDIR" diff --binary "$START_COMMIT" -- >> "$PATCH_PATH"
  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    if git -C "$WORKDIR" diff --no-index --binary /dev/null "$WORKDIR/$path" >> "$PATCH_PATH"; then
      status=0
    else
      status=$?
      [[ "$status" -eq 1 ]] || return "$status"
    fi
  done < <(git -C "$WORKDIR" ls-files --others --exclude-standard)
}

check_required_results() {
  local check
  local status
  local required=(deps-check format-check typecheck-core addons-validate security-test)

  REQUIRED_FAILURE=0
  for check in "${required[@]}"; do
    status="$(result_status after "$check")"
    [[ "$status" -eq 0 ]] || REQUIRED_FAILURE=1
  done
}

write_report() {
  local check
  local baseline_status
  local final_status
  local required=(deps-check format-check typecheck-core addons-validate security-test)
  local diagnostic=(lint-core test-core test-ui)

  {
    printf '%s\n\n' '# Codex task report'
    printf '%s\n' "- Task file: `$TASK_RELATIVE`"
    printf '%s\n' "- Starting commit: `$START_COMMIT`"
    printf '%s\n' "- Isolated working directory: `$WORKDIR`"
    printf '%s\n' "- Codex CLI exit status: `$CODEX_STATUS`"
    printf '%s\n' "- Dependency installation exit status: `$INSTALL_STATUS`"
    printf '%s\n' "- Unexpected commit created: `$UNEXPECTED_COMMIT`"
    printf '%s\n' "- Git remote configured after run: `$REMOTE_REMAINS`"
    printf '%s\n' "- Forbidden path changed: `$FORBIDDEN_PATH`"
    printf '%s\n' "- Sensitive-scope change requires review: `$SENSITIVE_SCOPE`"
    printf '%s\n' "- Secret-related term warning: `$SECRET_TERM_WARNING`"
    printf '%s\n' "- Source repository modified by wrapper: `no`"
    printf '%s\n\n' 'Nothing from this isolated run was applied to the source repository.'

    printf '%s\n\n' '## Codex final message'
    if [[ -s "$CODEX_FINAL_MESSAGE_PATH" ]]; then
      printf '%s\n' "$(<"$CODEX_FINAL_MESSAGE_PATH")"
    else
      printf '%s\n' '_No Codex final message was produced._'
    fi

    printf '%s\n\n' '## Changed files'
    if [[ -s "$CHANGED_FILES_PATH" ]]; then
      printf '%s\n' '```text'
      printf '%s\n' "$(<"$CHANGED_FILES_PATH")"
      printf '%s\n' '```'
    else
      printf '%s\n' 'No tracked or untracked changes were detected.'
    fi

    printf '%s\n\n' '## Diff summary'
    printf '%s\n' '```text'
    printf '%s\n' "$(<"$DIFF_STAT_PATH")"
    printf '%s\n' '```'

    printf '%s\n\n' '## Validation commands'
    while IFS=$'\t' read -r phase check final_status log_file; do
      [[ "$phase" == 'after' ]] || continue
      printf '%s\n' "- `npm run ${check//-/:}`: exit `$final_status` (log: `$log_file`)"
    done < "$RESULTS_FILE"

    printf '%s\n\n' '## Required currently-green checks'
    printf '%s\n' '- `deps:check`' '- `format:check`' '- `typecheck:core`' '- `addons:validate`' '- `security:test`'
    for check in "${required[@]}"; do
      baseline_status="$(result_status baseline "$check")"
      final_status="$(result_status after "$check")"
      printf '%s\n' "- ${check//-/:}: baseline=$baseline_status, after=$final_status"
    done

    printf '%s\n\n' '## Diagnostic currently-known-failing checks'
    printf '%s\n' '- `lint:core`' '- `test:core`' '- `test:ui`'
    for check in "${diagnostic[@]}"; do
      baseline_status="$(result_status baseline "$check")"
      final_status="$(result_status after "$check")"
      if [[ "$baseline_status" -ne 0 && "$final_status" -ne 0 ]]; then
        printf '%s\n' "- ${check//-/:}: baseline=$baseline_status, after=$final_status (known baseline failure persists)"
      elif [[ "$baseline_status" -eq 0 && "$final_status" -ne 0 ]]; then
        printf '%s\n' "- ${check//-/:}: baseline=$baseline_status, after=$final_status (new failure; review required)"
      elif [[ "$baseline_status" -ne 0 && "$final_status" -eq 0 ]]; then
        printf '%s\n' "- ${check//-/:}: baseline=$baseline_status, after=$final_status (baseline failure fixed)"
      else
        printf '%s\n' "- ${check//-/:}: baseline=$baseline_status, after=$final_status (passed)"
      fi
    done
    printf '%s\n' '- Diagnostic failures do not alone determine the version-one exit status.'

    printf '%s\n\n' '## Safety-policy findings'
    printf '%s\n' "- Required check failure: `$REQUIRED_FAILURE`"
    printf '%s\n' "- Forbidden path finding: `$FORBIDDEN_PATH`"
    printf '%s\n' "- Sensitive-scope finding: `$SENSITIVE_SCOPE`"
    printf '%s\n' "- Unexpected commit finding: `$UNEXPECTED_COMMIT`"
    printf '%s\n' "- Remote configuration finding: `$REMOTE_REMAINS`"
    printf '%s\n' "- Secret-related term review warning: `$SECRET_TERM_WARNING`"

    printf '%s\n\n' '## Manual review'
    printf '%s\n' "Review `$PATCH_PATH` and the logs before applying anything. Confirm the changed files, test output, security implications, and task scope manually. This wrapper did not stage, commit, or apply changes to the source repository."
  } > "$REPORT_PATH"
}

main() {
  local overall_status=0

  parse_args "$@"
  require_command git
  require_command npm
  require_command realpath
  require_command codex
  CODEX_BIN="$(command -v codex)"
  resolve_task_path
  validate_task_file
  check_source_preflight
  configure_safe_environment
  create_run_directory
  clone_repository

  run_check bootstrap npm-ci npm ci
  INSTALL_STATUS="$LAST_CHECK_STATUS"
  if [[ "$INSTALL_STATUS" -ne 0 ]]; then
    collect_changed_paths
    write_patch
    inspect_safety
    write_report
    printf '%s\n' 'Overall result: dependency installation failed.' >&2
    printf '%s\n' "Isolated repository: $WORKDIR" "Report: $REPORT_PATH" "Patch: $PATCH_PATH" "Changed files: $CHANGED_FILES_PATH" >&2
    printf '%s\n' 'Review the isolated artifacts manually; the source repository was not modified.' >&2
    exit 1
  fi

  run_validation_set baseline
  run_codex
  run_validation_set after
  collect_changed_paths
  write_patch
  inspect_safety
  check_required_results
  write_report

  [[ "$CODEX_STATUS" -eq 0 ]] || overall_status=1
  [[ "$REQUIRED_FAILURE" -eq 0 ]] || overall_status=1
  [[ "$FORBIDDEN_PATH" -eq 0 ]] || overall_status=1
  [[ "$SENSITIVE_SCOPE" -eq 0 ]] || overall_status=1
  [[ "$UNEXPECTED_COMMIT" -eq 0 ]] || overall_status=1
  [[ "$REMOTE_REMAINS" -eq 0 ]] || overall_status=1

  if [[ "$overall_status" -eq 0 ]]; then
    printf '%s\n' 'Overall result: passed required checks and safety review.'
  else
    printf '%s\n' 'Overall result: review required; one or more required checks or safety policies failed.' >&2
  fi
  printf '%s\n' "Isolated repository: $WORKDIR" "Report: $REPORT_PATH" "Patch: $PATCH_PATH" "Changed files: $CHANGED_FILES_PATH"
  printf '%s\n' 'Review the patch manually. The source repository was not modified by this wrapper.'
  exit "$overall_status"
}

main "$@"
