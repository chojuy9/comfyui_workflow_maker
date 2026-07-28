#!/usr/bin/env bash
set -euo pipefail

: "${GATEWAY_TOKEN:?GATEWAY_TOKEN must be set}"
# worker_agent.py 도 같은 값을 봅니다. 둘이 어긋나면 에이전트가 게이트웨이를 못 찾아요.
export GATEWAY_PORT="${GATEWAY_PORT:-8791}"

/opt/venv/bin/python /opt/ComfyUI/main.py \
  --listen 127.0.0.1 \
  --port 8188 \
  --disable-auto-launch \
  --disable-metadata \
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
    /opt/venv/bin/uvicorn app:app --host 0.0.0.0 --port "$GATEWAY_PORT" --proxy-headers &
    gateway_pid=$!
    for gateway_attempt in $(seq 1 30); do
      if curl --fail --silent "http://127.0.0.1:$GATEWAY_PORT/healthz" >/dev/null; then
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
