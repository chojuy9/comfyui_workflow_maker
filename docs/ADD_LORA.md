# LoRA 추가하기

이용자가 고를 수 있는 LoRA를 하나 늘리는 절차입니다.

---

## 왜 이렇게 번거로운가

**이용자는 LoRA 파일을 직접 올릴 수 없습니다.** URL도, 파일 경로도, ComfyUI 노드도 못 넣어요. 화면에 LoRA가 보이는 유일한 경로는 여기 적힌 등록 절차뿐입니다.

임의 파일을 허용하면 GPU에서 아무 코드나 로드하게 되고, 워크플로우 검증도 의미가 없어집니다. 그래서 **세 군데를 모두 고쳐야 실제로 동작**하도록 일부러 잠가뒀어요.

| 고칠 곳 | 안 고치면 |
|---|---|
| `config/lora-registry.json` | 화면에 안 뜸 |
| `config/model-registry.json` | 설치 때 파일을 안 받음 |
| `gateway/security.py`의 `ALLOWED_MODEL_FILES` | GPU가 워크플로우를 거절 |

셋 중 하나라도 빠지면 조용히 실패합니다. 특히 세 번째를 빼먹으면 화면에는 멀쩡히 보이는데 생성만 실패해서 원인 찾기가 제일 어려워요.

---

## 절차

### 1. 라이선스 확인

- 모델 계열이 Anima인지 WAI인지
- **무료 공개 서빙**이 허용되는지
- 재호스팅·크레딧 표기 조건이 있는지

Civitai 페이지의 permission 항목을 그대로 registry에 적어둡니다. 나중에 조건이 바뀌었는지 대조할 근거가 됩니다.

### 2. 파일 받고 해시 계산

**고정된 model version URL**에서 받으세요. 최신 버전 링크는 어느 날 내용이 바뀝니다.

```bash
sha256sum <파일>
```

### 3. `config/lora-registry.json`에 추가

```json
{
  "id": "anima_example_v1",
  "label": "표시할 이름",
  "family": "anima",
  "enabled": false,
  "source": { "provider": "civitai", "modelVersionId": 0, "page": "...", "download": "..." },
  "file": { "name": "example_v1.safetensors", "sha256": "..." },
  "triggerWords": ["example_trigger"],
  "strength": { "defaultWhenEnabled": 0.8, "min": 0.0, "max": 1.0, "step": 0.05 },
  "civitaiPermissions": { ... }
}
```

**`enabled`는 일단 `false`로 둡니다.** 테스트가 끝난 뒤에 켜세요.

`family`가 틀리면 컴파일러가 "선택한 모델과 LoRA 계열이 다릅니다"로 거절합니다. Anima는 `LoraLoaderModelOnly`, WAI(SDXL)는 `LoraLoader`로 서로 다른 노드를 쓰기 때문이에요.

### 4. `config/model-registry.json`에도 추가

설치 스크립트가 보는 목록입니다. 여기 없으면 GPU에 파일이 안 내려갑니다.

### 5. `gateway/security.py`에 파일명 추가

```python
ALLOWED_MODEL_FILES = {
    ...
    "example_v1.safetensors",
}
```

**정확한 basename만** 넣습니다. 경로가 섞이면 GPU가 path traversal로 보고 거절해요.

### 6. 검증

```bash
npm run validate
```

워크플로우 12개를 다시 만들고 컴파일러 테스트를 돌립니다.

### 7. 스모크 테스트

대상 모델의 **세 비율 전부**에서, strength **최솟값 · 기본값 · 최댓값** 세 지점을 확인합니다. 슬라이더 양 끝에서만 깨지는 LoRA가 종종 있어요.

### 8. 공개

- 검열에 영향을 주는지 확인
- 성인 표시(`nsfw`)가 필요한지 판단
- `enabled: true`로 전환

---

## 제한

| 항목 | 값 |
|---|---|
| 한 번에 켤 수 있는 LoRA | 최대 3개 |
| 트리거 자동 삽입 | 기본 켜짐, 이용자가 끌 수 있음 |
| 계열 혼용 | 불가 |

`triggerWords`를 넣어두면 이용자가 Positive에 직접 안 써도 자동으로 앞에 붙습니다. 제출 전 화면에 무엇이 삽입되는지 보여주니, 트리거를 정확히 적어두는 게 좋아요.

---

## 관련 문서

| 파일 | 내용 |
|---|---|
| [`INTEGRATION.md`](INTEGRATION.md) | Cloudflare 쪽 통합 |
| [`INSTALL_VASTAI.md`](INSTALL_VASTAI.md) | GPU 설치 |
