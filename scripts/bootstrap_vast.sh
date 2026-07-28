#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# 필요한 값은 Vast.ai 계정 설정에 한 번만 넣어두면 됩니다.
#   Account → Settings → Environment Variables
# 거기 넣은 값은 어떤 템플릿으로 인스턴스를 만들든 자동으로 들어옵니다.
#
# 주의: 계정 환경변수는 on-start 스크립트에서만 보입니다.
# SSH 로 직접 들어와서 이 스크립트를 돌리면 값이 비어 있을 수 있어요.
# 그럴 때는 scripts/onstart.sh 를 쓰거나 export 로 직접 넣으세요.
# ─────────────────────────────────────────────────────────────────────────────
# 저장소가 public 이라 주소를 안 넣어도 됩니다.
# 포크했거나 옮겼으면 CHATOS_REPO_URL 로 덮어쓰세요.
: "${CHATOS_REPO_URL:=https://github.com/chojuy9/comfyui_workflow_maker}"

missing=()
for name in WORKER_BASE_URL WORKER_API_TOKEN GATEWAY_TOKEN; do
  [[ -z "${!name:-}" ]] && missing+=("$name")
done
if (( ${#missing[@]} )); then
  cat >&2 <<MSG

빠진 값: ${missing[*]}

Vast.ai 계정 설정에 넣어두면 다음부터는 자동으로 들어옵니다.
  Account → Settings → Environment Variables

  WORKER_BASE_URL   https://chatos.page
  WORKER_API_TOKEN  Worker 의 IMAGE_GATEWAY_TOKEN 과 같은 값
  GATEWAY_TOKEN     위와 다른 32바이트 이상 랜덤값
  CIVITAI_TOKEN     civitai API 키 (모델 받을 때 필요)

지금 당장 돌리시려면 export 로 넣으세요.

MSG
  exit 1
fi

if [[ -z "${CIVITAI_TOKEN:-}" ]]; then
  echo "경고: CIVITAI_TOKEN 이 없습니다. civitai 모델에서 401 이 날 수 있습니다." >&2
fi

install_root="${INSTALL_ROOT:-/workspace/chatos-image}"
model_root="${MODEL_ROOT:-/workspace/ComfyUI/models}"

if [[ ! -d "$install_root/.git" ]]; then
  git clone --depth 1 "$CHATOS_REPO_URL" "$install_root"
fi
# 토큰을 origin 에 그대로 둡니다. 지우면 손으로 `git pull` 할 때마다 아이디를 묻거든요.
# 인스턴스는 어차피 쓰고 버리는 것이고, 토큰은 읽기 전용 + 만료가 걸려 있습니다.
git -C "$install_root" remote set-url origin "$CHATOS_REPO_URL"
git -C "$install_root" fetch --depth 1 origin HEAD
# 실행 권한 비트 같은 로컬 변경이 pull 을 막지 않도록 원격 상태로 맞춥니다.
git -C "$install_root" reset --hard FETCH_HEAD

python3 "$install_root/scripts/install_models.py" \
  --model-root "$model_root" \
  ${ALLOW_UNVERIFIED_MODELS:+--allow-unverified}

docker build -t chatos-image-gateway "$install_root/gateway"
docker rm -f chatos-image-gateway >/dev/null 2>&1 || true
docker run -d --restart unless-stopped --gpus all \
  --name chatos-image-gateway \
  -e WORKER_BASE_URL \
  -e WORKER_API_TOKEN \
  -e GATEWAY_TOKEN \
  -v "$model_root:/opt/ComfyUI/models" \
  -p 127.0.0.1:8080:8080 \
  chatos-image-gateway

docker ps --filter name=chatos-image-gateway
