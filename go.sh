#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# 원터치 설치·갱신
#
#   bash /workspace/chatos-image/go.sh
#
# 몇 번을 돌려도 안전합니다. 최신으로 맞추고, 필요한 것만 설치하고, 띄웁니다.
# 한 번 돌리고 나면 그냥 `chatos` 라고 치면 돼요.
#
#   chatos          설치·갱신하고 실행
#   chatos status   상태
#   chatos logs     로그
#   chatos stop     정지
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

install_root="${INSTALL_ROOT:-/workspace/chatos-image}"

# 저장소가 public 이라 주소를 안 넣어도 됩니다.
# 포크했거나 옮겼으면 CHATOS_REPO_URL 로 덮어쓰세요.
: "${CHATOS_REPO_URL:=https://github.com/chojuy9/comfyui_workflow_maker}"

# ── 값 불러오기 ─────────────────────────────────────────────────────────────
# Vast.ai 계정 환경변수는 on-start 에서만 보입니다. SSH 세션에는 안 넘어와요.
# onstart.sh 나 이전 실행이 /etc/chatos.env 에 적어둔 게 있으면 그걸 씁니다.
if [[ -f /etc/chatos.env ]]; then
  set -a; . /etc/chatos.env; set +a
fi

missing=()
for name in WORKER_BASE_URL WORKER_API_TOKEN GATEWAY_TOKEN; do
  [[ -z "${!name:-}" ]] && missing+=("$name")
done
if (( ${#missing[@]} )); then
  cat >&2 <<MSG

빠진 값: ${missing[*]}

Vast.ai Account → Settings → Environment Variables 에 넣어두면
다음 인스턴스부터는 자동으로 들어옵니다.

지금 당장은 이렇게 넣고 다시 돌리세요.

  export WORKER_BASE_URL=https://chatos.page
  export WORKER_API_TOKEN=<Worker 의 IMAGE_GATEWAY_TOKEN 과 같은 값>
  export GATEWAY_TOKEN=<위와 다른 랜덤값>
  export CIVITAI_TOKEN=<civitai API 키>
  bash $0

MSG
  exit 1
fi

# ── git 인증 심어두기 ───────────────────────────────────────────────────────
# private 저장소면 CHATOS_REPO_URL 에 토큰이 박혀 있습니다. 그 토큰을 git 자격
# 저장소에 한 번 넣어두면, 앞으로 어떤 git 명령을 쳐도 아이디를 안 묻습니다.
# 토큰 없는 주소(public)면 아무것도 안 합니다.
if [[ "${CHATOS_REPO_URL:-}" == https://*@* ]]; then
  rest="${CHATOS_REPO_URL#https://}"     # 토큰@github.com/계정/저장소
  creds="https://${rest%%/*}"            # https://토큰@github.com
  grep -qxF "$creds" /root/.git-credentials 2>/dev/null \
    || echo "$creds" >> /root/.git-credentials
  chmod 600 /root/.git-credentials
  git config --global credential.helper store
  echo "git 인증을 저장했습니다. 앞으로 git 명령이 아이디를 안 묻습니다."
fi

# ── 최신으로 맞추기 ─────────────────────────────────────────────────────────
# chmod 로 생긴 실행 권한 변경 같은 게 pull 을 막지 않도록 통째로 덮어씁니다.
# 인스턴스는 쓰고 버리는 것이라 로컬 변경을 지킬 이유가 없어요.
if [[ -d "$install_root/.git" ]]; then
  echo "== 저장소 갱신 =="
  git -C "$install_root" fetch --depth 1 origin HEAD
  git -C "$install_root" reset --hard FETCH_HEAD
  git -C "$install_root" clean -fd -e '*.log' >/dev/null 2>&1 || true
fi
chmod +x "$install_root"/scripts/*.sh "$install_root/go.sh" 2>/dev/null || true

# ── 다음부터 `chatos` 한 마디로 되게 ────────────────────────────────────────
cat > /usr/local/bin/chatos <<EOF
#!/usr/bin/env bash
[[ -f /etc/chatos.env ]] && { set -a; . /etc/chatos.env; set +a; }
case "\${1:-start}" in
  start|update|"") exec bash "$install_root/go.sh" ;;
  *) exec bash "$install_root/scripts/bootstrap_native.sh" "\$1" ;;
esac
EOF
chmod +x /usr/local/bin/chatos

# ── 값 정리 후 저장 (SSH 로 들어와도 보이게) ───────────────────────────────
# 웹 화면에서 붙여넣다 보면 앞뒤 공백이나 따옴표가 딸려 들어옵니다.
# 그대로 두면 civitai 가 400 을 주거나 토큰 대조가 어긋나는데, 원인이 잘 안 보여요.
for name in CHATOS_REPO_URL WORKER_BASE_URL WORKER_API_TOKEN GATEWAY_TOKEN \
            CIVITAI_TOKEN INSTALL_ROOT MODEL_ROOT; do
  value="${!name:-}"
  [[ -z "$value" ]] && continue
  value="${value#"${value%%[![:space:]]*}"}"   # 앞 공백
  value="${value%"${value##*[![:space:]]}"}"   # 뒤 공백
  value="${value%\"}"; value="${value#\"}"     # 감싼 큰따옴표
  value="${value%\'}"; value="${value#\'}"     # 감싼 작은따옴표
  if [[ "$value" != "${!name}" ]]; then
    echo "정리함: $name (앞뒤 공백이나 따옴표를 제거했습니다)"
  fi
  export "$name=$value"
done

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
if docker info >/dev/null 2>&1; then
  echo "== docker 있음 — 컨테이너로 =="
  exec bash "$install_root/scripts/bootstrap_vast.sh"
else
  echo "== docker 없음 — 인스턴스에 직접 =="
  exec bash "$install_root/scripts/bootstrap_native.sh"
fi
