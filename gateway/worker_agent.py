from __future__ import annotations

import asyncio
import json
import os
import time

import httpx

WORKER_BASE_URL = os.environ.get("WORKER_BASE_URL", "").rstrip("/")
WORKER_API_TOKEN = os.environ.get("WORKER_API_TOKEN", "")
GATEWAY_TOKEN = os.environ.get("GATEWAY_TOKEN", "")
POLL_SECONDS = float(os.environ.get("POLL_SECONDS", "2"))

# 게이트웨이는 같은 머신에서만 부르므로 TCP 포트가 필요 없습니다.
# 유닉스 소켓을 쓰면 포트 충돌 자체가 생기지 않아요.
# (8080 은 Vast.ai 인스턴스가 이미 쓰고 있어서 게이트웨이가 못 떴던 적이 있습니다.)
GATEWAY_UDS = os.environ.get("GATEWAY_UDS", "/tmp/chatos-gateway.sock")
# 유닉스 소켓에서는 호스트 이름이 의미가 없지만, httpx 가 URL 형식을 요구합니다.
GATEWAY_URL = "http://gateway"

# 잡을 처리하는 동안에도 살아 있다고 알립니다.
# 이게 없으면 생성이 오래 걸리는 사이 lease 호출이 끊겨 관리 화면에 오프라인으로 보입니다.
HEARTBEAT_SECONDS = float(os.environ.get("HEARTBEAT_SECONDS", "10"))

# 시간 사슬은 안쪽이 항상 더 짧아야 합니다.
#
#   ComfyUI 대기 780초  <  이 요청 840초  <  워커의 lease 만료 900초
#
# 예전에는 ComfyUI 600 / 요청 900 / lease 900 이었습니다. 뒤의 둘이 같아서,
# 오래 걸린 잡의 실패 보고가 lease 만료 직후에 도착하면 409 로 거절당하고
# 잡이 큐로 돌아가 무한히 다시 시도되는 자리가 있었어요.
GENERATE_TIMEOUT = float(os.environ.get("GENERATE_TIMEOUT", "840"))
RESULT_TIMEOUT = float(os.environ.get("RESULT_TIMEOUT", "120"))

# 게이트웨이가 죽어 있을 때 다시 확인하기까지 기다리는 시간입니다.
GATEWAY_DOWN_BACKOFF = float(os.environ.get("GATEWAY_DOWN_BACKOFF", "15"))


class GatewayUnavailable(RuntimeError):
    """게이트웨이에 아예 못 붙었습니다. 생성 실패가 아닙니다."""


class GenerationFailed(RuntimeError):
    """실제로 그림을 만들다 실패했습니다. 사유 코드를 함께 들고 다닙니다."""

    def __init__(self, reason: str, detail: str = "") -> None:
        super().__init__(detail or reason)
        self.reason = reason
        self.detail = detail


def log(event: str, **fields: object) -> None:
    """시각을 붙여서 한 줄로 남깁니다.

    예전에는 예외 이름만 찍어서, 로그를 봐도 그게 언제 일인지 알 수 없었습니다.
    유령 에이전트를 찾을 때 이것 때문에 한참 헤맸어요.
    """
    print(
        json.dumps(
            {"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "event": event, **fields},
            ensure_ascii=False,
        ),
        flush=True,
    )


def auth_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {WORKER_API_TOKEN}"}


async def gateway_healthy(gateway: httpx.AsyncClient) -> bool:
    try:
        response = await gateway.get(f"{GATEWAY_URL}/healthz", timeout=10)
        return response.status_code == 200
    except Exception:
        return False


async def generate(gateway: httpx.AsyncClient, lease: dict, files: dict) -> httpx.Response:
    """게이트웨이에 생성을 맡깁니다.

    여기서 나오는 예외를 두 갈래로 나누는 게 이 함수의 존재 이유입니다.
    붙지도 못한 것과 만들다 실패한 것은 전혀 다른 사건인데, 예전에는 둘 다
    "생성 실패"로 보고해서 이용자 할당량만 깎였습니다.
    """
    try:
        response = await gateway.post(
            f"{GATEWAY_URL}/v1/generate",
            headers={"Authorization": f"Bearer {GATEWAY_TOKEN}"},
            files=files,
            timeout=GENERATE_TIMEOUT,
        )
    except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
        # 소켓 파일이 없거나 게이트웨이가 안 듣고 있습니다.
        raise GatewayUnavailable(str(exc)) from exc
    except httpx.ReadTimeout as exc:
        # 840초를 넘겼습니다. 게이트웨이는 780초에 포기하도록 맞춰뒀으니
        # 여기까지 왔다는 건 게이트웨이 자체가 멎었다는 뜻입니다.
        raise GatewayUnavailable(f"gateway did not answer in {GENERATE_TIMEOUT}s") from exc
    except httpx.TransportError as exc:
        raise GatewayUnavailable(str(exc)) from exc

    if response.status_code == 200:
        return response
    # 401 은 GATEWAY_TOKEN 이 어긋난 것입니다. 잡의 잘못이 아니므로 실패시키지
    # 않고 되돌립니다. 사람이 환경변수를 고칠 때까지 계속 되돌아갈 뿐이에요.
    if response.status_code in (401, 403, 503):
        raise GatewayUnavailable(f"gateway refused with {response.status_code}")
    if response.status_code == 400:
        raise GenerationFailed("workflow_rejected", "gateway rejected the workflow")
    if response.status_code == 504:
        raise GenerationFailed("generation_timeout", "ComfyUI did not finish in time")
    if response.status_code == 502:
        reason = "generation_failed"
        try:
            detail = str(response.json().get("detail", ""))
        except Exception:
            detail = ""
        if "timed out" in detail:
            reason = "generation_timeout"
        raise GenerationFailed(reason, detail)
    raise GenerationFailed("gateway_error", f"unexpected status {response.status_code}")


async def run_once(client: httpx.AsyncClient, gateway: httpx.AsyncClient) -> bool:
    headers = auth_headers()
    response = await client.post(f"{WORKER_BASE_URL}/api/image/internal/lease", headers=headers)
    if response.status_code == 204:
        return False
    response.raise_for_status()
    lease = response.json()
    job_id = lease["id"]
    lease_headers = {**headers, "X-Lease-Token": lease["leaseToken"]}

    async def give_back() -> None:
        """잡을 대기열로 되돌립니다. 실패로 기록하지 않습니다."""
        await client.post(
            f"{WORKER_BASE_URL}/api/image/internal/jobs/{job_id}/release",
            headers=lease_headers,
        )

    async def report_failure(reason: str) -> None:
        await client.post(
            f"{WORKER_BASE_URL}/api/image/internal/jobs/{job_id}/fail",
            headers={**lease_headers, "X-Fail-Reason": reason},
        )

    files: dict[str, tuple[str | None, bytes | str, str]] = {}
    try:
        if lease["hasInput"]:
            image_response = await client.get(
                f"{WORKER_BASE_URL}/api/image/internal/jobs/{job_id}/input",
                headers=lease_headers,
            )
            image_response.raise_for_status()
            files["image"] = (
                "input",
                image_response.content,
                image_response.headers.get("content-type", "application/octet-stream"),
            )
        files["spec_json"] = (None, json.dumps(lease["spec"]), "application/json")

        generated = await generate(gateway, lease, files)

        # 여기서부터는 그림이 이미 나온 뒤입니다. 업로드가 깨지면 그건 생성
        # 실패가 아니라 전달 실패라, 사유를 따로 남겨야 원인이 보입니다.
        try:
            completed = await client.put(
                f"{WORKER_BASE_URL}/api/image/internal/jobs/{job_id}/result",
                headers={
                    **lease_headers,
                    "Content-Type": generated.headers.get("content-type", "image/png"),
                },
                content=generated.content,
                timeout=RESULT_TIMEOUT,
            )
            completed.raise_for_status()
        except Exception as exc:
            raise GenerationFailed("upload_failed", f"{type(exc).__name__}: {exc}") from exc

    except GatewayUnavailable as exc:
        log("gateway_unavailable", jobId=job_id, detail=str(exc)[:200])
        try:
            await give_back()
        except Exception as give_back_error:
            log("release_failed", jobId=job_id, detail=str(give_back_error)[:200])
        raise
    except GenerationFailed as exc:
        log("generation_failed", jobId=job_id, reason=exc.reason, detail=exc.detail[:200])
        try:
            await report_failure(exc.reason)
        except Exception as report_error:
            log("fail_report_failed", jobId=job_id, detail=str(report_error)[:200])
        return True
    except Exception as exc:
        # 무엇인지 모르는 것은 되돌립니다. 모르면 이용자에게 유리한 쪽으로.
        log("unexpected_error", jobId=job_id, error=type(exc).__name__, detail=str(exc)[:200])
        try:
            await give_back()
        except Exception:
            pass
        raise

    log("job_completed", jobId=job_id)
    return True


async def heartbeat_loop(client: httpx.AsyncClient) -> None:
    """
    잡을 돌리는 중에도 계속 살아 있다고 알립니다.

    lease 호출도 생존 신호로 쓰이지만, 생성이 최대 900초 걸리는 동안에는
    lease 를 부르지 않아 관리 화면이 오프라인으로 보였습니다.
    여기서 실패해도 절대 죽지 않습니다 — 어디까지나 표시용이라,
    이것 때문에 잡 처리가 멈추면 안 됩니다.
    """
    while True:
        try:
            await client.post(
                f"{WORKER_BASE_URL}/api/image/internal/heartbeat",
                headers=auth_headers(),
                timeout=15,
            )
        except Exception:
            pass
        await asyncio.sleep(HEARTBEAT_SECONDS)


async def main() -> None:
    if not WORKER_BASE_URL or not WORKER_API_TOKEN:
        raise RuntimeError("WORKER_BASE_URL and WORKER_API_TOKEN must be configured")
    gateway_transport = httpx.AsyncHTTPTransport(uds=GATEWAY_UDS)
    async with httpx.AsyncClient(follow_redirects=False, timeout=60) as client, \
            httpx.AsyncClient(transport=gateway_transport, timeout=60) as gateway:
        beat = asyncio.create_task(heartbeat_loop(client))
        log("agent_started", uds=GATEWAY_UDS, worker=WORKER_BASE_URL)
        try:
            while True:
                # 게이트웨이가 죽어 있으면 일감을 아예 안 가져옵니다.
                #
                # 이게 없으면 2초마다 잡을 하나씩 집어와서 되돌리기를 반복합니다.
                # 되돌리니 실패로 남지는 않지만, 큐가 계속 들썩이고 로그가
                # 쓸데없이 불어나요. 문 닫힌 걸 알면 줄을 서지 않는 게 맞습니다.
                if not await gateway_healthy(gateway):
                    log("gateway_down", retryIn=GATEWAY_DOWN_BACKOFF)
                    await asyncio.sleep(GATEWAY_DOWN_BACKOFF)
                    continue
                try:
                    worked = await run_once(client, gateway)
                    if not worked:
                        await asyncio.sleep(POLL_SECONDS)
                except Exception as exc:
                    log("worker_agent_error", error=type(exc).__name__, detail=str(exc)[:200])
                    await asyncio.sleep(min(POLL_SECONDS * 3, 15))
        finally:
            beat.cancel()


if __name__ == "__main__":
    asyncio.run(main())
