# 이미지 생성 붙이기 — Cloudflare 쪽

**대상** `C:\Project\chatos-auth` (Worker) · `C:\Project\litellm` (페이지)
**전제** chatos.page 발급 시스템이 이미 돌아가고 있는 상태

이 문서는 **Cloudflare 쪽에서 해야 할 일**만 다룹니다. GPU 설치는 [Vast.ai 설치 가이드](INSTALL_VASTAI.md)에 따로 있어요.

---

## 1. 전체 그림부터

이미지 생성은 기존 발급 시스템 위에 얹힙니다. 새로 만드는 건 **저장소(R2)와 큐(Durable Object)** 둘뿐이고, 로그인·계정은 이미 있는 걸 그대로 씁니다.

```
브라우저 ──① 생성 요청 ──▶ Worker ──▶ 검열 서비스
                              │
                              ├─▶ Durable Object  (큐 · 할당량)
                              └─▶ R2              (원본 · 결과 이미지)
                                      ▲
                                      │ ② GPU가 2초마다 물어봄 (pull)
                              GPU (Vast.ai) ──┘
```

**GPU가 먼저 말을 겁니다.** Worker가 GPU를 호출하는 게 아니라, GPU 쪽 에이전트가 2초마다 `/api/image/internal/lease`를 두드려서 일감을 가져갑니다. 그래서 GPU에 공개 주소가 필요 없고, 스팟 인스턴스가 사라져도 Worker는 아무것도 안 해도 됩니다.

---

## 2. 파일 배치 — 이미 끝났습니다

`integrations/` 아래 파일들은 **이미 실제 저장소로 복사돼 있습니다.** 아래 표는 나중에 이 패키지를 고쳤을 때 어디로 다시 옮겨야 하는지 확인용이에요.

| 이 패키지 | 옮길 곳 |
|---|---|
| `integrations/chatos-auth/image-api.js` | `chatos-auth/image-api.js` |
| `integrations/chatos-auth/image-durable-objects.js` | `chatos-auth/image-durable-objects.js` |
| `src/workflow-compiler.mjs` | `chatos-auth/src/workflow-compiler.mjs` |
| `config/*.json` | `chatos-auth/config/*.json` |
| `integrations/litellm/image.{html,css,js}` | `litellm/` 루트 |

옮길 때 `image-api.js` 맨 위의 컴파일러 import 경로가 `./src/workflow-compiler.mjs`인지 확인하세요.

`worker.js`에 들어간 연결 부분은 이렇습니다. 이미 반영돼 있지만, 어디가 접점인지 알아두면 나중에 디버깅이 편해요.

```js
// 맨 위 — Durable Object 클래스를 Cloudflare에 알려줍니다
export { ImageQueue, ImageQuota } from "./image-durable-objects.js";

// fetch() 안 — 로그인·인증 통과한 계정만 넘깁니다
if (p.startsWith('/api/image/')) {
  const session = await sessionAccount(env, req);
  const account = session?.acct?.verified && !session.acct.blocked ? session.acct : null;
  return await handleImageApi(req, env, ctx, account);
}

// scheduled() 안 — 30일 지난 이미지를 지웁니다
ctx.waitUntil(cleanupImageRetention(env));
```

---

## 3. Cloudflare 자원 만들기

R2 버킷 두 개를 먼저 만듭니다. `preview` 쪽은 `wrangler dev`로 로컬 테스트할 때만 쓰여요.

```bash
npx wrangler r2 bucket create chatos-images
npx wrangler r2 bucket create chatos-images-preview
```

Durable Object와 migration은 `wrangler.toml`에 이미 들어 있습니다. 배포하면 자동으로 만들어져요.

| 자원 | 이름 | 쓰임 |
|---|---|---|
| R2 | `chatos-images` | 원본(i2i 입력)과 결과 이미지 |
| Durable Object | `ImageQueue` | 잡 큐 · 리스 · 기록 |
| Durable Object | `ImageQuota` | 계정별 할당량 · 프롬프트 프리셋 |

> **R2 버킷을 공개로 열지 마세요.** 결과는 Worker가 로그인 확인 후 직접 흘려보냅니다. 버킷을 공개하면 주소만 알면 남의 이미지가 열립니다.

---

## 4. 시크릿 — 여기가 제일 자주 막힙니다

이미지 기능 때문에 시크릿이 하나 늘었습니다.

```bash
npx wrangler secret put IMAGE_GATEWAY_TOKEN
```

값은 32바이트 이상 무작위로 만드세요.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**토큰이 두 개고, 헷갈리면 반드시 고장 납니다.** 이름이 비슷해서 그렇습니다.

| 이름 | 어디에 넣나 | 무엇을 지키나 |
|---|---|---|
| `IMAGE_GATEWAY_TOKEN` | Cloudflare Worker 시크릿 | Worker의 `/api/image/internal/*` |
| `WORKER_API_TOKEN` | GPU 인스턴스 환경변수 | 위와 **같은 값**을 들고 있어야 함 |
| `GATEWAY_TOKEN` | GPU 인스턴스 환경변수 | GPU 안쪽 localhost 게이트웨이 |

정리하면 **`IMAGE_GATEWAY_TOKEN` = `WORKER_API_TOKEN`, 그리고 `GATEWAY_TOKEN`은 이 둘과 달라야 합니다.**

세 개를 같게 두면, GPU 컨테이너 안에서 뭔가 새어 나갔을 때 Cloudflare 쪽 내부 API까지 통째로 열립니다. 분리하는 이유가 그거예요.

**증상으로 구분하기**

| 보이는 것 | 원인 |
|---|---|
| 큐에 잡이 쌓이는데 GPU가 아무것도 안 가져감 | 두 값이 다름 |
| GPU 로그에 401이 반복 | 두 값이 다름 |
| 잡이 곧바로 실패로 떨어짐 | GPU 안쪽 `GATEWAY_TOKEN` 불일치 |

Worker에 필요한 시크릿 전체는 다음 다섯입니다.

| 시크릿 | 없으면 |
|---|---|
| `LITELLM_MASTER_KEY` | 키 발급 전체가 멈춤 |
| `USER_ID_SALT` | 발급 불가. **한 번 정하면 변경 금지** |
| `ADMIN_TOKEN` | 관리 페이지 못 엶 |
| `IMAGE_GATEWAY_TOKEN` | GPU가 잡을 못 가져감 |
| `TURNSTILE_SECRET` | 선택. Site Key와 **세트로만** |

---

## 5. 검열 Worker

프롬프트 검열은 **별도 Worker**가 맡습니다. 저장소는 `C:\Project\chatos-moderation`이에요.

### 왜 나눠 뒀나

검열 목록은 자주 고치는데 발급 Worker는 건드릴 일이 드뭅니다. 섞어두면 금지어 하나 고칠 때마다 키 발급까지 재배포돼요. 게다가 목록에 라우트가 없어야 안전해서, 애초에 다른 Worker로 두는 게 맞습니다.

### 방식은 규칙 기반입니다

이 서비스의 프롬프트는 booru 태그 나열(`1girl, blue eyes, ...`)이라 **목록 대조가 LLM 분류기보다 잘 맞습니다.** 외부 호출이 없어서 공짜고 빠르고, 왜 막혔는지도 정확히 알 수 있어요.

비교 전에 프롬프트를 납작하게 펴서 `l o l i` · `l-o-l-i` · `l0li` · `(loli:1.4)`를 전부 같은 것으로 봅니다. 네거티브 프롬프트도 함께 검사해요.

자세한 규칙은 [`chatos-moderation/README.md`](../../chatos-moderation/README.md)에 있습니다.

### 배포 순서

**순서가 중요합니다.** 반대로 하면 `service not found`로 실패해요.

```bash
# 1) 검열 Worker 먼저
cd C:\Project\chatos-moderation
npm test
npx wrangler deploy

# 2) 그 다음 발급 Worker
cd C:\Project\chatos-auth
npx wrangler deploy
```

`chatos-auth/wrangler.toml`의 바인딩은 이미 켜져 있습니다.

```toml
[[services]]
binding = "IMAGE_MODERATION"
service = "chatos-image-moderation"
```

> **검열 Worker에는 라우트를 붙이지 마세요.** service binding 전용이라 라우트가 없으면 인터넷에서 닿을 방법이 없습니다. 붙이는 순간 누구나 금지어 목록을 읽고 고칠 수 있게 됩니다.

바인딩이 없으면 **모든 생성 요청이 503으로 거절됩니다.** 실수가 아니라 의도된 fail-closed예요. 검열이 죽었을 때 통과시키는 것보다 서비스를 멈추는 쪽이 안전합니다.

### 계약

`POST /v1/image-prompt`

| 응답 | 뜻 |
|---|---|
| `200` + `{"allowed": true}` | 통과 |
| `200` + `{"allowed": false, "categories": [...]}` | 차단 |
| 그 외 | 장애로 보고 요청을 거절 |

보내는 본문입니다.

```json
{
  "accountId": "...",
  "positive": "...",
  "negative": "...",
  "hasInputImage": false,
  "policy": {
    "blockMinorSexual": true,
    "blockRealPerson": true,
    "blockIllegal": true,
    "adultContent": "partially_allowed"
  }
}
```

분류는 `minor_sexual` · `real_person` · `illegal` 셋입니다. **성인 콘텐츠 자체는 막지 않습니다** — 정책이 `partially_allowed`라서요.

### 목록 관리

기본 목록은 `chatos-moderation/config/blocklist.json`에 있고 코드라서 화면에서 못 지웁니다. 운영 중 추가·예외는 **관리 페이지의 프롬프트 검열 카드**에서 하세요. KV에 저장되고 기본 목록과 합쳐지며, 최대 1분 뒤 반영됩니다.

같은 카드에 **시험 판정**이 있습니다. 프롬프트를 넣으면 통과 여부와 어떤 규칙에 걸렸는지 나와요. 오탐이 났을 때 여기서 원인을 찾고 예외 목록에 넣으면 됩니다.

### I2I는 지금 잠겨 있습니다

원본 이미지를 검사할 수단이 아직 없습니다. 사진 업로드가 실존 인물·미성년자 위험이 가장 큰 경로라, 이미지 검열이 붙기 전에는 안 엽니다.

네 겹으로 막혀 있어요.

| 위치 | 하는 일 |
|---|---|
| `image.html` · `image.js` | I2I 토글을 잠그고 사유 표시 |
| `image-api.js` | 요청을 앞단에서 403 |
| `workflow-compiler.mjs` | 컴파일 단계에서 거절 |
| 검열 Worker | `hasInputImage` 거절 |

열 때는 이미지 판정을 붙인 뒤 네 곳을 함께 고칩니다. `service-policy.json`의 `img2img.enabled`가 출발점이에요.

### 로컬 개발

```
ENVIRONMENT="development"
IMAGE_MODERATION_MODE="disabled"
```

`ENVIRONMENT`가 `production`이면 이 설정은 무시되고 항상 검사합니다.

---

## 6. 페이지 쪽

`image.html` · `image.css` · `image.js` 세 파일을 `litellm/` 루트에 두면 끝입니다. 서버가 필요 없어요.

내비게이션 링크와 관리 페이지의 이미지 상태 카드는 **이미 반영돼 있습니다.**

| 페이지 | 상태 |
|---|---|
| 전체 `<nav>`에 이미지 링크 | 완료 |
| `admin.html` 이미지 GPU 현황 카드 | 완료 |
| `usage.html` 이미지 할당량 카드 | **아직 없음** |

`usage.html`에 붙일 거라면 `/api/image/quota`의 `dailyUsed` · `weeklyUsed` · `queued` · `running`을 쓰면 됩니다.

---

## 7. 브라우저에 절대 내려가면 안 되는 것

이미지 기능은 GPU 주소를 감추는 게 전제라서, 노출 경계를 한 번 정리해 둡니다.

| 내려가는 것 | 내려가면 안 되는 것 |
|---|---|
| 모델·LoRA 표시명 | Civitai URL, 실제 파일명 |
| 허용 범위(steps·CFG 범위) | ComfyUI 노드 ID·구조 |
| 할당량 숫자 | `img.chatos.page`, 게이트웨이 토큰 |

Worker의 오류 응답에도 예외 `message`나 stack을 싣지 마세요. 밖으로는 고정된 오류 코드만 나가고, 자세한 원인은 구조화 로그에만 남깁니다.

GPU 쪽도 받은 워크플로우를 **독립적으로 다시 검사합니다.** 허용 노드 16종, 허용 모델 파일명 목록에 없으면 거절해요. Worker가 뚫려도 한 겹이 더 있는 구조입니다.

---

## 8. 보관 정책

| 대상 | 기간 |
|---|---|
| 결과 이미지 | 30일 |
| 생성 기록 목록 | 7일 |
| 갤러리 보관 | 무기한, 계정당 15장 |
| 기록 보관(고정) | 무기한, 계정당 10장 |
| 프롬프트 프리셋 | 무기한, 계정당 50개 |

보관 표시가 하나라도 켜진 이미지는 30일이 지나도 지우지 않습니다. cron이 5분마다 돌면서 정리해요.

---

## 9. 배포와 확인

```bash
# 검열 Worker 먼저 (순서 중요)
cd C:\Project\chatos-moderation
npm test && npx wrangler deploy

# 그 다음 발급 Worker
cd C:\Project\chatos-auth
npm run check      # 문법 + dry-run
npx wrangler deploy
```

배포 후 확인 순서입니다.

1. 관리 페이지(`admin.html`)를 열고 **이미지 GPU** 카드가 뜨는지
2. GPU를 아직 안 붙였으면 "오프라인"이 정상입니다
3. **프롬프트 검열** 카드에 목록 개수가 뜨는지 — "연결 안 됨"이면 바인딩 문제입니다
4. 시험 판정에 `1girl, loli`를 넣어 차단되는지
5. `image.html`에서 로그인하지 않은 상태로도 모델·LoRA 목록이 보이는지
6. I2I 항목이 잠겨 있고 사유가 보이는지
7. 로그인 후 할당량 숫자가 뜨는지

---

## 10. 관련 문서

| 파일 | 내용 |
|---|---|
| [`INSTALL_VASTAI.md`](INSTALL_VASTAI.md) | GPU 인스턴스 설치 |
| [`ADD_LORA.md`](ADD_LORA.md) | LoRA 추가 절차 |
| [`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md) | 공개 전 점검표 |
| `../../chatos-moderation/README.md` | 검열 규칙과 목록 관리 |
| `../chatos-3차보고서.md` | 발급 시스템 전반 |
| `../확장계획.md` | 임베딩 · STT/TTS · 이미지 확장 설계 |
