#!/usr/bin/env bash
# 인스턴스가 처음 뜰 때 자동으로 도는 스크립트입니다.
#
# Vast.ai 인스턴스를 만들 때 On-start Script 칸에 이 내용을 붙여넣으면
# SSH 로 들어가지 않아도 설치가 끝납니다.
#
# 계정 환경변수(Account → Settings → Environment Variables)에
# 아래 값들이 들어 있어야 합니다.
#   WORKER_BASE_URL  WORKER_API_TOKEN  GATEWAY_TOKEN  CIVITAI_TOKEN
set -euo pipefail

install_root="${INSTALL_ROOT:-/workspace/chatos-image}"
: "${CHATOS_REPO_URL:=https://github.com/chojuy9/comfyui_workflow_maker}"

# ── 나중에 SSH 로 들어와도 값이 보이게 저장해 둡니다 ─────────────────────────
# 계정 환경변수는 on-start 에서만 보입니다. SSH 세션에는 안 넘어와요.
# 여기서 한 번 적어두면 손으로 뭔가 할 때 훨씬 편합니다.
{
  for name in CHATOS_REPO_URL WORKER_BASE_URL WORKER_API_TOKEN GATEWAY_TOKEN \
              CIVITAI_TOKEN INSTALL_ROOT MODEL_ROOT; do
    [[ -n "${!name:-}" ]] && echo "$name=${!name}"
  done
} > /etc/chatos.env
chmod 600 /etc/chatos.env
grep -q 'chatos.env' /root/.bashrc 2>/dev/null \
  || echo 'set -a; [ -f /etc/chatos.env ] && . /etc/chatos.env; set +a' >> /root/.bashrc

# ── 설치 ────────────────────────────────────────────────────────────────────
if [[ ! -d "$install_root/.git" ]]; then
  git clone --depth 1 "$CHATOS_REPO_URL" "$install_root"
else
  # 실행 권한 비트 같은 로컬 변경이 pull 을 막지 않도록 원격 상태로 맞춥니다.
  git -C "$install_root" fetch --depth 1 origin HEAD
  git -C "$install_root" reset --hard FETCH_HEAD
fi
chmod +x "$install_root"/scripts/*.sh "$install_root/gateway/entrypoint.sh" 2>/dev/null || true

# Vast.ai 인스턴스는 대개 그 자체가 컨테이너라 안에서 docker 를 못 씁니다.
# 되면 컨테이너로, 안 되면 인스턴스에 직접 설치합니다.
if docker info >/dev/null 2>&1; then
  echo "docker 사용 가능 — 컨테이너로 설치합니다"
  "$install_root/scripts/bootstrap_vast.sh"
else
  echo "docker 없음 — 인스턴스에 직접 설치합니다"
  "$install_root/scripts/bootstrap_native.sh"
fi
