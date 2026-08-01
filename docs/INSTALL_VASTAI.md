# GPU 설치 — Vast.ai

**대상** 24GB GPU 인스턴스 한 대
**전제** [Cloudflare 쪽 통합](INTEGRATION.md)이 먼저 끝나 있어야 합니다

ComfyUI와 게이트웨이를 컨테이너로 띄우고, 에이전트가 chatos.page에서 일감을 가져와 처리하게 만듭니다.

---

## 1. 어떤 인스턴스를 고르나

| 항목 | 기준 |
|---|---|
| GPU | RTX 3090 24GB 또는 동급 |
| 디스크 | 최소 100GB, 권장 140GB 이상 |
| 네트워크 | 대역폭 넉넉한 호스트 |
| 공개 포트 | **필요 없음** |

**공개 포트가 필요 없는 게 핵심입니다.** GPU가 chatos.page 쪽으로 나가서(outbound) 일감을 물어보는 구조라, 밖에서 GPU로 들어오는 경로 자체가 없어요. 방화벽 설정도, 터널도 생성 경로에는 안 씁니다.

가격과 가용성이 수시로 바뀌니 **특정 인스턴스 ID를 스크립트에 박아두지 마세요.** 첫 며칠은 24시간 돌리면서 처리 시간·VRAM·시간당 비용을 재고, 그 뒤에 운영 시간대를 정하는 순서로 갑니다.

ComfyUI는 커밋 `093d571b83e7a79833200e199b46b9f5a62217f9`(2026-07-27 확인)로 고정합니다. 올릴 때는 워크플로우 12개 회귀 테스트와 3090 스모크 테스트를 통과한 뒤, 별도 변경으로만 하세요.

---

## 2. 토큰 두 개 — 여기부터 짚고 갑니다

설치 전에 이것부터 정리해야 나중에 안 헤맵니다. 이름이 비슷한 값이 셋인데, **둘은 같아야 하고 하나는 달라야 합니다.**

| 값 | 어디에 | 짝 |
|---|---|---|
| `IMAGE_GATEWAY_TOKEN` | Cloudflare Worker 시크릿 | ← 같은 값 → |
| `WORKER_API_TOKEN` | GPU 인스턴스 환경변수 | ← 같은 값 → |
| `GATEWAY_TOKEN` | GPU 인스턴스 환경변수 | **위 둘과 달라야 함** |

`WORKER_API_TOKEN`은 Cloudflare로 나가는 문을 여는 열쇠고, `GATEWAY_TOKEN`은 GPU 안쪽 localhost 게이트웨이를 지키는 열쇠입니다. 역할이 달라서 나눠 둡니다. 셋을 같게 두면 컨테이너 안에서 값 하나가 새는 순간 Cloudflare 내부 API까지 열립니다.

```bash
# 두 값을 따로 만드세요
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## 3. 모델 라이선스와 해시

설치 스크립트는 등록된 SHA-256과 안 맞으면 멈춥니다. 그래서 처음 한 번은 해시를 등록하는 절차가 필요합니다.

`config/model-registry.json`에서 이 둘을 해결해야 해요.

1. `licenseReview: required`인 항목 — **무료 공개 서빙이 허용되는지** 직접 확인
2. `sha256: null`인 파일 — 격리된 환경에서 한 번 받아 해시를 등록

검토용 임시 다운로드는 이렇게 합니다.

```bash
python3 scripts/install_models.py \
  --model-root /workspace/ComfyUI/models \
  --allow-unverified
```

설치가 끝나면 `REGISTER_SHA256` 값이 출력됩니다. 그걸 registry에 적어 넣고, **`--allow-unverified` 없이 다시 돌려서 성공하는지 확인**하세요. 이게 통과해야 앞으로 파일이 바뀌었을 때 알아챌 수 있습니다.

Civitai가 로그인을 요구하면 토큰을 명령줄에 쓰지 말고 환경변수로 주입하세요. 셸 히스토리에 남습니다.

```bash
export CIVITAI_TOKEN=...
```

---

## 4. 값은 계정에 한 번만 넣습니다

**Account → Settings → Environment Variables**

여기 넣은 값은 어떤 템플릿으로 인스턴스를 만들든 자동으로 들어옵니다. 인스턴스마다 다시 적을 필요가 없어요.

| 이름 (Name 칸) | 값 (Value 칸) |
|---|---|
| `WORKER_BASE_URL` | `https://chatos.page` |
| `WORKER_API_TOKEN` | Worker 의 `IMAGE_GATEWAY_TOKEN` 과 **같은 값** |
| `GATEWAY_TOKEN` | 위와 **다른** 32바이트 이상 랜덤값 |
| `CIVITAI_TOKEN` | civitai API 키 |
| `INSTALL_ROOT` | `/workspace/chatos-image` |
| `MODEL_ROOT` | `/workspace/ComfyUI/models` |

> **이름 칸에는 이름만, 공백 없이.** 뒤에 공백이 하나만 붙어도 Vast.ai 가
> `Must NOT begin with a digit and can only contain alphanumeric characters or underscores`
> 로 거절합니다.

`WORKER_BASE_URL` 끝에 슬래시를 붙이지 마세요.

### 저장소는 public 입니다

인증이 없어서 `CHATOS_REPO_URL` 을 안 넣어도 됩니다. clone 할 때 아이디도 토큰도 안 물어봐요.

이 패키지에 비밀값이 없기 때문에 가능한 겁니다 — 토큰은 전부 환경변수고 `.gitignore` 가 `.env` 를 막습니다.

### CIVITAI_TOKEN 은 사실상 필수입니다

civitai 파일 중 로그인을 요구하는 게 있습니다. 없으면 그 파일에서 **401**로 멈춰요.
**civitai.com → Account settings → API Keys → Add API key**

> **계정 환경변수는 on-start 스크립트에서만 보입니다.** SSH 로 직접 들어가면 값이 비어 있어요. 다음 장의 on-start 방식을 쓰면 이 문제가 없습니다.

---

## 5. 설치

### 두 줄이면 됩니다

```bash
git clone --depth 1 https://github.com/chojuy9/comfyui_workflow_maker /workspace/chatos-image
bash /workspace/chatos-image/go.sh
```

인스턴스를 만들 때 **On-start Script** 칸에 넣으면 SSH 로 들어갈 일도 없습니다. SSH 에서 직접 해도 같은 두 줄이에요.

한 번 돌리고 나면 `chatos` 명령이 깔립니다.

```bash
chatos          # 최신으로 받고 설치·실행 (몇 번을 쳐도 안전)
chatos status   # 포트 응답, 최근 로그
chatos logs     # 로그 따라가기
chatos stop     # 정지
```

### go.sh 가 하는 일

1. 계정 환경변수를 `/etc/chatos.env` 에 저장 (SSH 에서도 보이게)
2. 저장소를 원격 상태로 맞춤 (`pull` 이 아니라 덮어쓰기 — 충돌이 안 남)
3. **docker 유무를 보고 갈라짐**

| | 하는 일 |
|---|---|
| docker 없음 (대부분) | 인스턴스에 직접 설치 (`bootstrap_native.sh`) |
| docker 됨 (VM 계열) | 컨테이너로 격리 (`bootstrap_vast.sh`) |

**Vast.ai 인스턴스는 대개 그 자체가 컨테이너라 안에서 docker 를 못 씁니다.** 그래서 보통 네이티브로 갑니다.

네이티브 설치는 Dockerfile 과 같은 일을 합니다. ComfyUI 고정 커밋, 가상환경, 의존성, 모델 확인, 백그라운드 실행.

**인스턴스에 torch 가 이미 있으면 재사용합니다.** `--system-site-packages` 로 가상환경을 만들어 몇 GB 재설치를 건너뛰고, CUDA 버전도 호스트에 맞는 걸 씁니다.

`setsid` 로 떼어놓아서 **SSH 를 끊어도 계속 돕니다.** docker 의 `--restart unless-stopped` 대신 `run_native.sh` 안에 재시작 루프가 있어서, 뭔가 죽으면 15초 뒤 스스로 다시 뜹니다.

로그는 `/workspace/logs/` 에 `comfyui.log` · `gateway.log` · `agent.log` 로 나뉩니다.

> **`MODEL_ROOT` 의 상위 폴더가 ComfyUI 설치 경로가 됩니다.** 기본값 `/workspace/ComfyUI/models` 면 ComfyUI 는 `/workspace/ComfyUI` 에 깔려요. 둘이 어긋나면 모델을 못 찾으니 경로에서 역산하도록 해뒀습니다.

### 모델 해시가 아직 등록 안 됐다면

`sha256`이 `null`인 항목이 있으면 스크립트가 거부합니다. 처음 한 번은 이렇게 여세요.

```bash
export ALLOW_UNVERIFIED_MODELS=1
chatos
```

출력에서 `REGISTER_SHA256` 줄을 모아 `config/model-registry.json`에 적고 푸시한 다음, **`ALLOW_UNVERIFIED_MODELS` 없이** 다시 돌려서 통과하는지 확인합니다. 이게 통과해야 앞으로 파일이 바뀌었을 때 알아챌 수 있어요.

---

## 6. 잘 떴는지 확인

```bash
chatos status
curl --fail http://127.0.0.1:8080/healthz
nvidia-smi
```

컨테이너 안에서는 이 순서로 올라옵니다. 중간에 멈추면 어디서 막혔는지 로그로 갈립니다.

```
ComfyUI (127.0.0.1:8188)  ──▶  게이트웨이 (0.0.0.0:8080)  ──▶  에이전트
       최대 120초 대기              최대 30초 대기           15초마다 lease 조회
```

**가장 확실한 확인은 관리 페이지입니다.** `admin.html`의 이미지 GPU 카드가 "온라인"으로 바뀌면 에이전트가 Worker에 닿은 겁니다. 30초 안에 lease를 요청한 적이 있으면 온라인으로 뜹니다.

에이전트는 작업을 받은 동안에만 10초마다 heartbeat를 보내고, 아카 릴레이
요청 여부는 2분마다 확인합니다. 큐가 비어 있을 때 heartbeat를 따로 보내지
않으므로 GPU 한 대가 대기할 때의 Cloudflare Worker 호출은 하루 약
5만 건대에서 약 1만 건 아래로 줄어듭니다.

### 안 될 때

| 증상 | 볼 곳 |
|---|---|
| 카드가 계속 오프라인 | `WORKER_API_TOKEN`이 Worker 시크릿과 같은지 |
| 에이전트 로그에 401 | 위와 동일 |
| 잡을 가져가는데 곧바로 실패 | `GATEWAY_TOKEN` 불일치 또는 모델 파일 누락 |
| ComfyUI가 안 뜸 | VRAM, 모델 경로 마운트 |

에이전트는 실패해도 죽지 않고 15초까지 간격을 늘리며 재시도합니다. 로그가 조용하면 오히려 정상이에요.

---

## 7. 처리 방식

에이전트는 **한 번에 한 작업만** 처리합니다. 잡을 받으면 리스 토큰을 들고 최대 15분간 붙잡아요.

| 상황 | 결과 |
|---|---|
| 성공 | 결과를 R2에 올리고 할당량 확정 |
| 실패 | Worker에 알리고 **할당량 되돌림** |
| 인스턴스가 사라짐 | 15분 뒤 리스 만료 → 잡이 대기열로 복귀, 할당량 유지 |

**차감은 완료됐을 때만 확정됩니다.** 제출 시점엔 예약만 잡아두기 때문에, GPU가 죽어도 이용자가 손해 보지 않습니다.

---

## 8. img.chatos.page는 선택입니다

생성 경로가 pull 방식이라 공개 주소가 필요 없습니다. 운영 확인용으로 붙이고 싶다면,

- Cloudflare Tunnel + Access 서비스 토큰으로 **`/healthz`만** 노출
- 브라우저·DNS 안내·프론트엔드 코드 어디에도 이 주소를 넣지 않음
- **ComfyUI의 8188 포트는 절대 노출하지 않음**

8188이 열리면 워크플로우 검증이고 할당량이고 전부 우회됩니다. 컨테이너 안에서 `127.0.0.1`로만 듣게 묶어둔 이유예요.

---

## 9. 스팟 회수 대응

**인스턴스를 지우면 그 안의 데이터는 같이 사라집니다.** 모델도 마찬가지예요.

Vast.ai 에 볼륨 기능이 있긴 한데, **볼륨은 만들어진 물리 머신에만 붙습니다.** 같은 호스트를 다시 빌리면 모델이 남아 있지만, 다른 호스트로 가면 못 씁니다. 스팟이 회수되면 대개 다른 머신으로 옮기게 되니 **매번 다시 받는다고 보는 게 맞습니다.**

그래서 복구는 이렇게 됩니다.

1. 새 인스턴스를 빌림 (계정 환경변수는 자동으로 따라옴)
2. On-start Script 가 알아서 clone → 설치 → 실행 (인증 없음)
3. 모델 재다운로드 15~20분

진행 중이던 잡은 **15분 뒤 리스가 만료되면 대기열로 돌아옵니다.** 할당량도 차감되지 않아요. 새 인스턴스가 이어서 처리합니다.

계정 환경변수와 on-start 를 한 번 세팅해두면, 재임대할 때 사람이 할 일은 **인스턴스 고르고 만들기** 하나뿐입니다.

완전 자동 재임대는 실제 비용과 Vast.ai API 실패 패턴을 좀 본 뒤에 2단계로 만듭니다. 지금 만들면 어떤 실패를 처리해야 하는지 모른 채 짜는 셈이라서요.

---

## 10. 3090 스모크 테스트

공개 전에 한 번은 돌려야 합니다. 조합은 모델 2종 × 비율 3종 = 6개이고, 각각에 대해 확인합니다.

| 확인할 것 | 왜 |
|---|---|
| T2I 1장 | 기본 경로 |
| I2I 1장 | 업로드·인코딩 경로 |
| LoRA 1개 / 3개 | 체인 조립과 VRAM |
| 업스케일 on / off | 2× 경로와 메모리 |

기록할 것은 이렇습니다.

- peak VRAM과 OOM 여부
- cold / warm 생성 시간
- 결과 해상도와 PNG·WebP 형식
- 실패 작업의 할당량 환불과 15분 리스 복구
- Anima 기본값(CFG 4.5, 35 steps, er_sde) 결과
- WAI 기본값(CFG 10, 20 steps, Euler a) 결과

> **24GB에서 OOM이 나면 batch는 1로 두고 ComfyUI의 VRAM 옵션을 조정하세요.** 기본 해상도나 이용자에게 열어둔 범위를 슬쩍 낮추면, 나중에 왜 결과가 예전 같지 않은지 아무도 못 찾습니다.

### RTX 5060 Ti 16GB로 교체할 때

ComfyUI를 시작할 때 GPU VRAM과 CUDA capability를 자동 감지합니다.

| 감지 결과 | 정밀도 |
|---|---|
| 24GB급 이상(실측 23GiB 이상) | 기존 FP16/BF16 |
| 16GB급 이하(실측 17GiB 이하) + Ada Lovelace 이상(capability 8.9 이상) | diffusion weights FP8 |
| 그 사이 용량 또는 구형 GPU | 기존 FP16/BF16 |

정밀도 선택은 파일에 저장하지 않고 시작할 때마다 다시 계산합니다. 따라서 5060 Ti
16GB에서 RTX 3090 24GB로 돌아가도 별도 설정 삭제 없이 기존 정밀도로 실행됩니다.

설치가 한 번 끝난 뒤 다음 명령으로 GPU·CUDA·FP8을 확인하고, Anima와 WAI를
1024×1024·배치 1로 한 장씩 생성합니다. 테스트 중에는 에이전트를 끄므로 실제
사용자 작업을 가져가지 않습니다.

```bash
bash /workspace/chatos-image/scripts/prepare_5060ti.sh all
```

CUDA 빌드가 너무 오래됐다는 오류가 나올 때만 PyTorch를 갱신하고 다시 실행합니다.

```bash
bash /workspace/chatos-image/scripts/prepare_5060ti.sh install-torch
bash /workspace/chatos-image/scripts/prepare_5060ti.sh all
```

두 모델이 모두 통과하면 `/workspace/chatos-5060ti-ready`가 생깁니다. 그 뒤에만
아래 재부팅 명령이 동작합니다. 재부팅 후에는 기존 Vast.ai On-start Script가
GPU를 다시 감지하고 에이전트까지 포함한 정상 서빙을 시작합니다.

```bash
bash /workspace/chatos-image/scripts/prepare_5060ti.sh reboot --yes-reboot
```

Vast.ai 환경에 따라 컨테이너 안의 `reboot`가 허용되지 않을 수 있습니다. 그 경우
성공 마커가 생성된 것을 확인한 뒤 Vast.ai 화면에서 인스턴스를 재시작하세요.

---

## 11. 관련 문서

| 파일 | 내용 |
|---|---|
| [`INTEGRATION.md`](INTEGRATION.md) | Cloudflare 쪽 통합 |
| [`ADD_LORA.md`](ADD_LORA.md) | LoRA 추가 절차 |
| [`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md) | 공개 전 점검표 |
