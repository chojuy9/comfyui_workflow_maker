#!/usr/bin/env bash
# docker 없이 설치합니다.
#
# Vast.ai 인스턴스는 그 자체가 컨테이너라 안에서 docker 를 못 쓰는 경우가 많습니다.
# 이 스크립트는 Dockerfile 이 하던 일을 인스턴스에 직접 합니다.
#
#   사용법
#     ./scripts/bootstrap_native.sh          설치하고 백그라운드로 실행
#     ./scripts/bootstrap_native.sh status   상태 보기
#     ./scripts/bootstrap_native.sh stop     정지
#     ./scripts/bootstrap_native.sh logs     로그 따라가기
set -euo pipefail

install_root="${INSTALL_ROOT:-/workspace/chatos-image}"
model_root="${MODEL_ROOT:-/workspace/ComfyUI/models}"
comfy_root="$(dirname "$model_root")"
venv="${CHATOS_VENV:-/workspace/venv}"
log_dir="${CHATOS_LOG_DIR:-/workspace/logs}"
pid_file="/workspace/chatos-native.pid"
install_pid_file="/workspace/chatos-install.pid"

# 설치가 돌고 있는지 봅니다. pgrep 은 자기 자신도 잡아버려서 pid 파일을 씁니다.
installing() {
  [[ -f "$install_pid_file" ]] && kill -0 "$(cat "$install_pid_file" 2>/dev/null)" 2>/dev/null
}
COMFYUI_COMMIT="${COMFYUI_COMMIT:-093d571b83e7a79833200e199b46b9f5a62217f9}"

command="${1:-install}"

case "$command" in
  status)
    if installing; then
      echo "설치 진행 중 — chatos logs 로 확인하세요"
      tail -3 "$log_dir/install.log" 2>/dev/null | sed 's/^/  /'
      echo
    fi
    if [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
      echo "실행 중 (pid $(cat "$pid_file"))"
    else
      echo "정지 상태"
    fi
    echo "--- 자원 ---"
    printf "  메모리  %s\n" "$(free -h 2>/dev/null | awk '/^Mem:/{print $3" / "$2}')"
    printf "  디스크  %s\n" "$(df -h /workspace 2>/dev/null | awk 'NR==2{print $3" / "$2" ("$5" 사용)"}')"
    echo "--- 포트 ---"
    curl --fail --silent http://127.0.0.1:8188/system_stats >/dev/null \
      && echo "  ComfyUI  8188  응답함" || echo "  ComfyUI  8188  응답 없음"
    curl --fail --silent http://127.0.0.1:8080/healthz >/dev/null \
      && echo "  게이트웨이 8080  응답함" || echo "  게이트웨이 8080  응답 없음"
    echo "--- 최근 에이전트 로그 ---"
    tail -5 "$log_dir/agent.log" 2>/dev/null || echo "  (없음)"
    exit 0 ;;
  stop)
    if [[ -f "$pid_file" ]]; then
      kill -- "-$(cat "$pid_file")" 2>/dev/null || kill "$(cat "$pid_file")" 2>/dev/null || true
      rm -f "$pid_file"
    fi
    if [[ -f "$install_pid_file" ]]; then
      kill -- "-$(cat "$install_pid_file")" 2>/dev/null || kill "$(cat "$install_pid_file")" 2>/dev/null || true
      rm -f "$install_pid_file"
    fi
    pkill -f 'ComfyUI/main.py' 2>/dev/null || true
    pkill -f 'uvicorn app:app' 2>/dev/null || true
    pkill -f 'worker_agent.py' 2>/dev/null || true
    echo "정지했습니다"
    exit 0 ;;
  logs)
    # 설치 중이면 설치 로그를, 다 됐으면 실행 로그를 보여줍니다.
    if installing; then
      echo "== 설치 진행 중 — install.log =="
      tail -f "$log_dir/install.log"
    else
      tail -f "$log_dir"/agent.log "$log_dir"/gateway.log "$log_dir"/comfyui.log
    fi
    exit 0 ;;
esac

# ── 필요한 값 확인 ───────────────────────────────────────────────────────────
missing=()
for name in WORKER_BASE_URL WORKER_API_TOKEN GATEWAY_TOKEN; do
  [[ -z "${!name:-}" ]] && missing+=("$name")
done
if (( ${#missing[@]} )); then
  echo "빠진 값: ${missing[*]}" >&2
  echo "Vast.ai Account → Settings → Environment Variables 에 넣거나 export 하세요." >&2
  exit 1
fi
[[ -z "${CIVITAI_TOKEN:-}" ]] && echo "경고: CIVITAI_TOKEN 이 없습니다. civitai 모델에서 401 이 날 수 있습니다." >&2

mkdir -p "$log_dir"

# ── 1. 시스템 패키지 ────────────────────────────────────────────────────────
# 이미 깔려 있으면 건너뜁니다. 최소만 넣어요.
need_apt=()
command -v git >/dev/null || need_apt+=(git)
command -v curl >/dev/null || need_apt+=(curl)
python3 -c 'import venv' 2>/dev/null || need_apt+=(python3-venv)
if (( ${#need_apt[@]} )); then
  echo "== apt 설치: ${need_apt[*]} =="
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    "${need_apt[@]}" libgl1 libglib2.0-0 ca-certificates
fi

# ── 2. ComfyUI ──────────────────────────────────────────────────────────────
# 커밋을 고정합니다. 올릴 때는 워크플로우 회귀 테스트를 통과한 뒤에 별도 변경으로.
if [[ ! -d "$comfy_root/.git" ]]; then
  echo "== ComfyUI 받기 =="
  mkdir -p "$comfy_root"
  git init -q "$comfy_root"
  git -C "$comfy_root" remote add origin https://github.com/Comfy-Org/ComfyUI.git 2>/dev/null || true
fi
git -C "$comfy_root" fetch --depth 1 origin "$COMFYUI_COMMIT"
git -C "$comfy_root" checkout -q --detach FETCH_HEAD
echo "ComfyUI 커밋 $(git -C "$comfy_root" rev-parse --short HEAD)"

# ── 3. 가상환경 ─────────────────────────────────────────────────────────────
# 인스턴스 이미지에 torch 가 이미 있으면 그걸 그대로 씁니다.
# 몇 GB 짜리 재설치를 피할 수 있고 CUDA 버전도 호스트에 맞는 걸 씁니다.
if [[ ! -d "$venv" ]]; then
  if python3 -c 'import torch' 2>/dev/null; then
    echo "== 가상환경 생성 (시스템 torch 재사용) =="
    python3 -m venv --system-site-packages "$venv"
  else
    echo "== 가상환경 생성 =="
    python3 -m venv "$venv"
  fi
fi
"$venv/bin/pip" install -q --upgrade pip
echo "== ComfyUI 의존성 =="
"$venv/bin/pip" install -q -r "$comfy_root/requirements.txt"
echo "== 게이트웨이 의존성 =="
"$venv/bin/pip" install -q -r "$install_root/gateway/requirements.txt"
"$venv/bin/python" -c 'import torch; print("torch", torch.__version__, "cuda", torch.cuda.is_available())'

# 게이트웨이 의존성이 ComfyUI 쪽 패키지를 끌어내리는 일이 있었습니다.
# pip 는 그걸 경고만 하고 0 으로 끝내서, ComfyUI 가 뜰 때가 되어서야 터집니다.
# 여기서 미리 잡아 원인이 보이게 합니다.
echo "== 의존성 정합성 확인 =="
# pip check 는 참고용입니다. venv 가 --system-site-packages 라 인스턴스 이미지에
# 원래 있던 무관한 충돌까지 잡아내거든요. 여기서 멈추면 안 됩니다.
"$venv/bin/pip" check || echo "(위 충돌 목록은 참고용입니다. 아래 임포트가 되면 진행합니다.)"
# 진짜 판정은 이겁니다. 이게 깨지면 ComfyUI 가 100% 못 뜹니다.
"$venv/bin/python" -c 'from transformers import CLIPTokenizer; from tokenizers import Tokenizer' || {
  echo "transformers/tokenizers 임포트 실패 — 이 상태면 ComfyUI 가 뜨지 않습니다." >&2
  exit 1
}

# ── 4. 모델 ─────────────────────────────────────────────────────────────────
echo "== 모델 확인 =="
python3 "$install_root/scripts/install_models.py" \
  --model-root "$model_root" \
  ${ALLOW_UNVERIFIED_MODELS:+--allow-unverified}

# ── 5. 실행 ─────────────────────────────────────────────────────────────────
"$0" stop >/dev/null 2>&1 || true
chmod +x "$install_root/scripts/run_native.sh"
echo "== 실행 =="
# setsid 로 떼어놓아서 SSH 를 끊어도 계속 돕니다.
setsid nohup "$install_root/scripts/run_native.sh" >> "$log_dir/run.log" 2>&1 &
echo $! > "$pid_file"
sleep 2
echo
echo "백그라운드로 실행 중입니다 (pid $(cat "$pid_file"))"
echo "  상태  ./scripts/bootstrap_native.sh status"
echo "  로그  ./scripts/bootstrap_native.sh logs"
echo "  정지  ./scripts/bootstrap_native.sh stop"
echo
echo "ComfyUI 가 처음 뜨는 데 몇 분 걸립니다."
echo "관리 페이지의 이미지 GPU 카드가 '온라인'으로 바뀌면 연결된 겁니다."
