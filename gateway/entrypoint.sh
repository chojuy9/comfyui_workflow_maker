#!/usr/bin/env bash
set -euo pipefail

: "${GATEWAY_TOKEN:?GATEWAY_TOKEN must be set}"
# 게이트웨이는 에이전트만 부르므로 TCP 포트 대신 유닉스 소켓을 씁니다.
# worker_agent.py 도 같은 값을 봅니다. 둘이 어긋나면 에이전트가 게이트웨이를 못 찾아요.
export GATEWAY_UDS="${GATEWAY_UDS:-/tmp/chatos-gateway.sock}"

/opt/venv/bin/python /opt/ComfyUI/main.py \
  --listen 127.0.0.1 \
  --port 8188 \
  --disable-auto-launch \
  --preview-method none &
comfy_pid=$!

cleanup() {
  kill "$comfy_pid" 2>/dev/null || true
  if [[ -n "${gateway_pid:-}" ]]; then
    kill "$gateway_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

for attempt in $(seq 1 120); do
  if curl --fail --silent http://127.0.0.1:8188/system_stats >/dev/null; then
    rm -f "$GATEWAY_UDS"
    /opt/venv/bin/uvicorn app:app --uds "$GATEWAY_UDS" &
    gateway_pid=$!
    for gateway_attempt in $(seq 1 30); do
      if curl --fail --silent --unix-socket "$GATEWAY_UDS" http://localhost/healthz >/dev/null; then
        exec /opt/venv/bin/python /opt/gateway/worker_agent.py
      fi
      sleep 1
    done
    echo "GPU gateway did not become ready" >&2
    exit 1
  fi
  sleep 1
done

echo "ComfyUI did not become ready" >&2
exit 1
