#!/usr/bin/env sh
set -eu

failures=0

check_file() {
  file="$1"
  if [ -f "$file" ]; then
    echo "[ok]      $file"
    return
  fi
  echo "[missing] $file"
  failures=$((failures + 1))
}

check_contains() {
  file="$1"
  pattern="$2"
  label="$3"
  if [ ! -f "$file" ]; then
    echo "[missing] $label (file missing: $file)"
    failures=$((failures + 1))
    return
  fi
  if grep -Eq "$pattern" "$file"; then
    echo "[ok]      $label"
    return
  fi
  echo "[missing] $label"
  failures=$((failures + 1))
}

for file in AGENTS.md PLANS.md docs/ARCHITECTURE.md docs/OBSERVABILITY.md Makefile.harness scripts/harness/lint.sh scripts/harness/typecheck.sh scripts/harness/test.sh scripts/harness/smoke.sh .github/workflows/harness.yml; do
  check_file "$file"
done

check_contains AGENTS.md "Harness Commands" "AGENTS.md: Harness Commands section"
check_contains AGENTS.md "Execution Plans" "AGENTS.md: Execution Plans section"
check_contains docs/ARCHITECTURE.md "Boundaries" "ARCHITECTURE.md: boundary guidance"
check_contains docs/OBSERVABILITY.md "Required Event Fields" "OBSERVABILITY.md: required fields"
check_contains Makefile.harness "^smoke:" "Makefile.harness: smoke target"
check_contains Makefile.harness "^test:" "Makefile.harness: test target"
check_contains Makefile.harness "^lint:" "Makefile.harness: lint target"
check_contains Makefile.harness "^typecheck:" "Makefile.harness: typecheck target"
check_contains Makefile.harness "^ci:" "Makefile.harness: ci target"
check_contains .github/workflows/harness.yml "make ci" "CI workflow executes make ci"

if [ "$failures" -gt 0 ]; then
  echo "Harness audit failed: $failures issue(s) detected."
  exit 1
fi

echo "Harness audit passed."
