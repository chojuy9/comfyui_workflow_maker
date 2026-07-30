#!/usr/bin/env bash
# docker 없이 ComfyUI + 게이트웨이 + 에이전트를 돌립니다.
#
# gateway/entrypoint.sh 와 같은 순서로 띄우되, docker 의 `--restart unless-stopped`
# 가 없으니 죽으면 스스로 다시 뜨는 루프를 둡니다.
#
#   ComfyUI (127.0.0.1:8188)  →  게이트웨이 (유닉스 소켓)  →  에이전트
set -uo pipefail

install_root="${INSTALL_ROOT:-/workspace/chatos-image}"
model_root="${MODEL_ROOT:-/workspace/ComfyUI/models}"
comfy_root="$(dirname "$model_root")"          # 모델 경로에서 역산 — 둘이 어긋나면 안 됩니다
venv="${CHATOS_VENV:-/workspace/venv}"
log_dir="${CHATOS_LOG_DIR:-/workspace/logs}"
mkdir -p "$log_dir"

export TOKENIZER_PATH="${TOKENIZER_PATH:-$model_root/tokenizers}"
export COMFY_URL="${COMFY_URL:-http://127.0.0.1:8188}"
# 게이트웨이는 같은 머신 안에서만 부르므로 TCP 포트를 안 씁니다.
# 유닉스 소켓이라 포트 충돌이 아예 생기지 않아요.
# 에이전트도 같은 값을 봐야 하므로 export 합니다.
export GATEWAY_UDS="${GATEWAY_UDS:-/tmp/chatos-gateway.sock}"

: "${GATEWAY_TOKEN:?GATEWAY_TOKEN 이 필요합니다}"
: "${WORKER_BASE_URL:?WORKER_BASE_URL 이 필요합니다}"
: "${WORKER_API_TOKEN:?WORKER_API_TOKEN 이 필요합니다}"

comfy_pid=""
gateway_pid=""

cleanup() {
  [[ -n "$comfy_pid" ]] && kill "$comfy_pid" 2>/dev/null
  [[ -n "$gateway_pid" ]] && kill "$gateway_pid" 2>/dev/null
  wait 2>/dev/null
}
trap 'cleanup; exit 0' INT TERM

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

start_once() {
  log "ComfyUI 시작"
  "$venv/bin/python" "$comfy_root/main.py" \
    --listen 127.0.0.1 --port 8188 \
    --disable-auto-launch --preview-method none \
    >> "$log_dir/comfyui.log" 2>&1 &
  comfy_pid=$!

  # ComfyUI 가 뜰 때까지 최대 5분. 모델을 처음 읽을 때 오래 걸립니다.
  for _ in $(seq 1 300); do
    curl --fail --silent http://127.0.0.1:8188/system_stats >/dev/null && break
    kill -0 "$comfy_pid" 2>/dev/null || { log "ComfyUI 가 죽었습니다. comfyui.log 를 보세요"; return 1; }
    sleep 1
  done
  curl --fail --silent http://127.0.0.1:8188/system_stats >/dev/null \
    || { log "ComfyUI 준비 실패"; return 1; }
  log "ComfyUI 준비됨"

  # 지난번에 죽으면서 남긴 소켓 파일이 있으면 uvicorn 이 바인드에 실패합니다.
  # 이 시점엔 이전 게이트웨이를 이미 정리한 뒤라 지워도 안전합니다.
  rm -f "$GATEWAY_UDS"

  log "게이트웨이 시작 (소켓 $GATEWAY_UDS)"
  ( cd "$install_root/gateway" && exec "$venv/bin/uvicorn" app:app \
      --uds "$GATEWAY_UDS" ) >> "$log_dir/gateway.log" 2>&1 &
  gateway_pid=$!

  for _ in $(seq 1 60); do
    curl --fail --silent --unix-socket "$GATEWAY_UDS" http://localhost/healthz >/dev/null && break
    kill -0 "$gateway_pid" 2>/dev/null || { log "게이트웨이가 죽었습니다. gateway.log 를 보세요"; return 1; }
    sleep 1
  done
  curl --fail --silent --unix-socket "$GATEWAY_UDS" http://localhost/healthz >/dev/null \
    || { log "게이트웨이 준비 실패"; return 1; }
  # 소켓은 기본 권한이 넉넉합니다. 같은 머신의 다른 사용자가 못 붙게 조입니다.
  chmod 600 "$GATEWAY_UDS" 2>/dev/null || true
  log "게이트웨이 준비됨"

  log "에이전트 시작 — 여기서부터 chatos.page 의 일감을 가져옵니다"
  "$venv/bin/python" "$install_root/gateway/worker_agent.py" \
    >> "$log_dir/agent.log" 2>&1
  log "에이전트 종료 (코드 $?)"
  return 1
}

# docker 가 해주던 재시작을 여기서 대신합니다.
while true; do
  start_once
  cleanup
  comfy_pid=""; gateway_pid=""
  log "15초 뒤 다시 시작합니다"
  sleep 15
done
