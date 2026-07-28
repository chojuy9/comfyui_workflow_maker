# chatos.page 이미지 생성

WAI Illustrious SDXL v17.0과 Anima Base 1.0을 ComfyUI로 돌리고, 기존 chatos.page 계정 뒤에 대기열·할당량·보관을 붙이는 패키지입니다.

**API가 아니라 웹 페이지입니다.** 사이트에서 직접 뽑는 형태예요. 그래서 형식 호환이나 타임아웃 문제가 없는 대신, 큐와 저장소와 필터를 직접 만들어야 했습니다.

---

## 어떻게 생겼나

세 덩어리가 각각 다른 곳에서 돕니다.

| 덩어리 | 어디서 | 하는 일 |
|---|---|---|
| 페이지 | Cloudflare Pages | 생성 화면, 기록·갤러리 |
| 발급 Worker | Cloudflare | 인증, 큐, 할당량, R2 |
| 검열 Worker | Cloudflare | 프롬프트 규칙 검사 |
| GPU | Vast.ai | ComfyUI 실행 |

**GPU가 Worker 쪽으로 나가서 일감을 가져갑니다.** 2초마다 물어보는 pull 방식이라 GPU에 공개 주소가 필요 없고, 스팟 인스턴스가 사라져도 Worker 설정을 건드릴 일이 없습니다.

```
브라우저 ──▶ Worker ──▶ 검열 · 큐(DO) · R2
                 ▲
                 │ 2초마다 lease
              GPU ┘
```

---

## 들어 있는 것

- 모델 2개 × 비율 3개 = 워크플로우 12개 (API용 · UI용)
- 허용목록 기반 LoRA 최대 3개, 트리거 자동 삽입
- Real-ESRGAN 2× 업스케일, PNG·WebP (I2I는 현재 잠금)
- 10자리 시드, 모델별 sampler·scheduler·steps·CFG 서버 검증
- Vast.ai용 ComfyUI + FastAPI 게이트웨이와 pull 에이전트
- 계정당 일 50장 · 주 250장, I2I는 1.5장으로 계산
- 단일 GPU FIFO 큐, 15분 리스 복구, 계정당 실행 1 · 대기 4
- 비공개 R2 전달, 30일 이미지 · 7일 기록 · 보관 예외
- 기존 chatos.page 스타일을 따르는 생성 화면

---

## 읽는 순서

1. [Cloudflare 쪽 통합](docs/INTEGRATION.md) — R2·DO 만들고 시크릿 넣기
2. 검열 Worker 배포 → 발급 Worker 배포 (**순서 중요**)
3. [Vast.ai 설치](docs/INSTALL_VASTAI.md) — GPU 띄우기
4. [공개 전 점검표](docs/RELEASE_CHECKLIST.md) — 하나씩 확인

LoRA를 더 넣고 싶으면 [LoRA 추가](docs/ADD_LORA.md)를 보세요.

### 빠른 확인

```bash
npm run validate    # 워크플로우 12개 재생성 + 컴파일러 테스트
```

---

## 공개 전에 반드시

**라이선스.** Anima Base 1.0과 일부 Civitai 모델·LoRA는 무료 서비스라도 별도 조건이 붙을 수 있습니다. `config/model-registry.json`에서 `licenseReview: required`인 파일은 확인이 끝나기 전에 올리지 마세요.

**해시.** `sha256`이 `null`인 파일은 통제된 환경에서 한 번 받아 해시를 등록한 뒤에 운영 설치를 합니다. 안 그러면 파일이 바뀌어도 알 방법이 없습니다.

**검열.** 검열 Worker가 없거나 실패하면 production Worker는 작업을 아예 안 받습니다. 실수가 아니라 의도된 fail-closed예요. 개발 환경에서만 `IMAGE_MODERATION_MODE=disabled`로 끌 수 있습니다.

**I2I는 잠겨 있습니다.** 원본 이미지를 검사할 수단이 아직 없어서요. 사진 업로드가 실존 인물·미성년자 위험이 가장 큰 경로라, 이미지 판정이 붙기 전에는 열지 않습니다.

---

## 문서

| 파일 | 내용 |
|---|---|
| [`docs/INTEGRATION.md`](docs/INTEGRATION.md) | Cloudflare 쪽 통합 |
| [`docs/INSTALL_VASTAI.md`](docs/INSTALL_VASTAI.md) | GPU 인스턴스 설치 |
| [`docs/ADD_LORA.md`](docs/ADD_LORA.md) | LoRA 추가 절차 |
| [`docs/RELEASE_CHECKLIST.md`](docs/RELEASE_CHECKLIST.md) | 공개 전 점검표 |

운영 보고서와 확장 계획은 이 저장소에 없습니다. 서비스의 약한 지점이 그대로 적혀 있어서 공개 저장소에 두지 않아요. 소유자의 `litellm_memory` 폴더에 있습니다.
