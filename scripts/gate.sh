#!/usr/bin/env bash
# gate.sh — 반영 전 기계 검증 (기계 우선 + AI 보조 전략의 '기계' 부분)
# 1) 코드 품질: lint · typecheck · test  2) 요구사항 추적: (P1) REQ에 테스트가 있는가
# 실패하면 non-zero로 종료 → 다음 단계 진행 불가. (macOS 기본 bash 3.2 호환)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PRD="$ROOT/docs/PRD.md"
PLAN="$ROOT/docs/PLAN.md"
FAIL=0

echo "── gate: 코드 품질 ─────────────────────────────"
if [ -f "$ROOT/package.json" ]; then
  RUN="npm --prefix $ROOT run -s"
  command -v pnpm >/dev/null 2>&1 && [ -f "$ROOT/pnpm-lock.yaml" ] && RUN="pnpm --dir $ROOT run -s"
  $RUN lint      || FAIL=1
  $RUN typecheck || FAIL=1
  $RUN test      || FAIL=1
else
  echo "  (package.json 없음 — 프로젝트 스택에 맞게 이 블록을 수정하세요)"
fi

echo "── gate: 요구사항 추적성 (활성 페이즈) ──────────────────"
# PRD에서 (P1)/(P2)/...로 표시된 REQ ID 전부 추적 — 특정 페이즈만 하드코딩하면 다음 페이즈가 사각지대가 된다.
# (관통) 태그가 붙은 REQ = 수동 관통 검증형(UI 등) → 유닛테스트 강요 안 함. 태그 없으면 기본 (자동).
# 한 페이즈를 여러 서브페이즈로 쪼개 커밋할 때, 아직 착수 안 한 서브페이즈의 (자동) REQ까지
# gate가 잡으면 그 페이즈의 첫 서브페이즈조차 커밋할 수 없다 — PLAN.md에 "## 게이트 예외"
# 섹션을 만들고 그 아래 REQ-NNN을 적어두면 예외로 둔다(사람이 관리하는 면제 목록이므로,
# 그 서브페이즈를 실제로 구현하면 반드시 여기서 지워야 한다 — 안 지우면 테스트 없이 통과됨).
P1_REQS="$(grep -oE 'REQ-[0-9]+\*\* \(P[0-9]+\)' "$PRD" 2>/dev/null | grep -oE 'REQ-[0-9]+' | sort -u)"
MANUAL_REQS="$(grep -E '\(관통\)' "$PRD" 2>/dev/null | grep -oE 'REQ-[0-9]+' | sort -u)"
PENDING_REQS="$(awk '/^## 게이트 예외/{flag=1; next} /^## /{flag=0} flag' "$PLAN" 2>/dev/null | grep -oE 'REQ-[0-9]+' | sort -u)"
TESTED="$(grep -rhoE 'REQ-[0-9]+' "$ROOT" --include='*.test.*' 2>/dev/null | sort -u)"

TOTAL=0; COVERED=0; MISSING=""; MANUAL=""; PENDING=""
while IFS= read -r req; do
  [ -z "$req" ] && continue
  TOTAL=$((TOTAL + 1))
  if printf '%s\n' "$MANUAL_REQS" | grep -qx "$req"; then
    MANUAL="$MANUAL $req"
  elif printf '%s\n' "$PENDING_REQS" | grep -qx "$req"; then
    PENDING="$PENDING $req"
  elif printf '%s\n' "$TESTED" | grep -qx "$req"; then
    COVERED=$((COVERED + 1))
  else
    MISSING="$MISSING $req"
  fi
done <<EOF
$P1_REQS
EOF

AUTO_TOTAL=$((TOTAL - $(printf '%s' "$MANUAL" | wc -w) - $(printf '%s' "$PENDING" | wc -w)))
echo "  요구사항: ${TOTAL}개 (착수한 자동검증 ${AUTO_TOTAL}개 중 테스트 커버 ${COVERED}개)"
if [ -n "$MISSING" ]; then
  echo "  ❌ 테스트 없는 (자동) 요구사항:"
  for req in $MISSING; do echo "     - $req"; done
  FAIL=1
else
  echo "  ✅ 착수한 (자동) 요구사항은 모두 테스트로 추적됨"
fi
if [ -n "$MANUAL" ]; then
  echo "  🔎 수동 관통 검증 필요 (테스트 면제 · 프리뷰+관통으로 확인):"
  for req in $MANUAL; do echo "     - $req"; done
fi
if [ -n "$PENDING" ]; then
  echo "  ⏳ 다음 서브페이즈 예정 (PLAN.md 게이트 예외 목록, 아직 gate 대상 아님):"
  for req in $PENDING; do echo "     - $req"; done
fi

echo "────────────────────────────────────────────────"
[ "$FAIL" -eq 0 ] && echo "GATE PASS ✅" || echo "GATE FAIL ❌"
exit "$FAIL"
