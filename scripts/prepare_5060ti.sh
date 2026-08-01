#!/usr/bin/env bash
# RTX 5060 Ti 16GB에서 FP8을 켜고 Anima/WAI 배치 1 스모크 테스트를 수행합니다.
# 테스트를 통과해야만 reboot 하위 명령을 사용할 수 있습니다.
set -euo pipefail

env_file="${CHATOS_ENV_FILE:-/etc/chatos.env}"
if [[ -f "$env_file" ]]; then
  set -a
  # root 전용으로 저장되는 서비스 환경 파일입니다.
  . "$env_file"
  set +a
fi

install_root="${INSTALL_ROOT:-/workspace/chatos-image}"
venv="${CHATOS_VENV:-/workspace/venv}"
log_dir="${CHATOS_LOG_DIR:-/workspace/logs}"
ready_marker="${CHATOS_5060TI_READY_MARKER:-/workspace/chatos-5060ti-ready}"
smoke_csv="${CHATOS_5060TI_SMOKE_CSV:-/workspace/5060ti-smoke.csv}"
command="${1:-all}"

python_bin="$venv/bin/python"
[[ -x "$python_bin" ]] || {
  echo "가상환경이 없습니다: $python_bin" >&2
  echo "먼저 bash $install_root/go.sh 를 한 번 실행하세요." >&2
  exit 1
}

check_hardware() {
  "$python_bin" - <<'PY'
import json
import torch

if not torch.cuda.is_available():
    raise SystemExit("FAIL: torch에서 CUDA를 사용할 수 없습니다")

props = torch.cuda.get_device_properties(0)
name = props.name
vram_gib = props.total_memory / 1024**3
capability = torch.cuda.get_device_capability(0)
cuda_text = torch.version.cuda or "0.0"
try:
    cuda_version = tuple(int(part) for part in cuda_text.split(".")[:2])
except ValueError:
    cuda_version = (0, 0)

info = {
    "gpu": name,
    "vram_gib": round(vram_gib, 2),
    "capability": capability,
    "torch": torch.__version__,
    "torch_cuda": torch.version.cuda,
}
print(json.dumps(info, ensure_ascii=False))

if "RTX 5060 Ti" not in name:
    raise SystemExit(f"FAIL: RTX 5060 Ti가 아닙니다: {name}")
if vram_gib < 15:
    raise SystemExit(f"FAIL: 16GB 모델이 아닙니다: {vram_gib:.2f} GiB")
if capability != (12, 0):
    raise SystemExit(f"FAIL: 예상 CUDA capability (12, 0)가 아닙니다: {capability}")
if cuda_version < (12, 8):
    raise SystemExit(
        f"FAIL: 이 Torch는 CUDA {cuda_text} 빌드입니다. "
        "prepare_5060ti.sh install-torch를 먼저 실행하세요."
    )

# FP8 저장과 cast가 실제 GPU에서 실행되는지 짧게 확인합니다.
x = torch.randn(4096, device="cuda", dtype=torch.float16)
y = x.to(torch.float8_e4m3fn).to(torch.float16)
torch.cuda.synchronize()
if not torch.isfinite(y).all().item():
    raise SystemExit("FAIL: FP8 cast 결과에 비정상 값이 있습니다")
print("PASS: RTX 5060 Ti 16GB / CUDA / FP8 cast")
PY
}

restart_service() {
  : "${WORKER_BASE_URL:?WORKER_BASE_URL 이 필요합니다}"
  : "${WORKER_API_TOKEN:?WORKER_API_TOKEN 이 필요합니다}"
  : "${GATEWAY_TOKEN:?GATEWAY_TOKEN 이 필요합니다}"
  # 검증이 끝나고 재부팅하기 전에는 실제 사용자 작업을 가져가지 않습니다.
  export CHATOS_AGENT_DISABLED=1
  "$install_root/scripts/bootstrap_native.sh" restart
  for _ in $(seq 1 300); do
    if curl --fail --silent http://127.0.0.1:8188/system_stats >/dev/null; then
      echo "PASS: ComfyUI 준비됨"
      return 0
    fi
    sleep 1
  done
  echo "FAIL: 5분 안에 ComfyUI가 준비되지 않았습니다." >&2
  tail -n 80 "$log_dir/comfyui.log" >&2 || true
  return 1
}

smoke_test() {
  rm -f "$ready_marker"
  "$python_bin" "$install_root/scripts/benchmark_comfy.py" \
    --smoke-only --repo "$install_root" --output "$smoke_csv"

  if ! pgrep -af 'ComfyUI/main.py' | grep -q -- '--fp8_e4m3fn-unet'; then
    echo "FAIL: 실행 중인 ComfyUI 명령에서 FP8 인자를 찾지 못했습니다." >&2
    return 1
  fi
  if ! grep -q 'fp8_e4m3fn' "$log_dir/comfyui.log"; then
    echo "FAIL: ComfyUI 로그에서 FP8 로딩을 확인하지 못했습니다." >&2
    tail -n 80 "$log_dir/comfyui.log" >&2 || true
    return 1
  fi

  {
    date -Is
    "$python_bin" -c 'import torch; print(torch.cuda.get_device_name(0)); print(torch.__version__, torch.version.cuda)'
    echo "PRECISION_MODE=auto(fp8)"
    echo "SMOKE_CSV=$smoke_csv"
  } > "$ready_marker"
  chmod 600 "$ready_marker"
  echo "PASS: Anima -> WAI, 1024x1024, batch 1"
  echo "재부팅 승인 마커: $ready_marker"
}

install_torch() {
  echo "== PyTorch CUDA 13.0 설치 =="
  "$venv/bin/pip" install --upgrade torch torchvision torchaudio \
    --index-url https://download.pytorch.org/whl/cu130
  check_hardware
}

case "$command" in
  check)
    check_hardware ;;
  enable)
    check_hardware
    restart_service ;;
  smoke)
    check_hardware
    smoke_test ;;
  all)
    check_hardware
    restart_service
    smoke_test
    echo
    echo "모두 통과했습니다. 재부팅하려면 아래 명령을 실행하세요."
    echo "  bash $install_root/scripts/prepare_5060ti.sh reboot --yes-reboot" ;;
  install-torch)
    install_torch ;;
  reboot)
    [[ "${2:-}" == "--yes-reboot" ]] || {
      echo "재부팅 확인 인자가 필요합니다: reboot --yes-reboot" >&2
      exit 2
    }
    [[ -s "$ready_marker" ]] || {
      echo "스모크 테스트 성공 마커가 없습니다: $ready_marker" >&2
      echo "먼저 prepare_5060ti.sh all을 실행하세요." >&2
      exit 1
    }
    echo "테스트 통과 상태를 확인했습니다. 지금 재부팅합니다."
    sync
    reboot ;;
  *)
    echo "사용법: $0 {check|install-torch|enable|smoke|all|reboot --yes-reboot}" >&2
    exit 2 ;;
esac
