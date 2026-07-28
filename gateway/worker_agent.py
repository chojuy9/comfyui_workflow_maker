from __future__ import annotations

import asyncio
import json
import os

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


def auth_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {WORKER_API_TOKEN}"}


async def run_once(client: httpx.AsyncClient, gateway: httpx.AsyncClient) -> bool:
    headers = auth_headers()
    response = await client.post(f"{WORKER_BASE_URL}/api/image/internal/lease", headers=headers)
    if response.status_code == 204:
        return False
    response.raise_for_status()
    lease = response.json()
    lease_headers = {**headers, "X-Lease-Token": lease["leaseToken"]}
    files: dict[str, tuple[str | None, bytes | str, str]] = {}
    if lease["hasInput"]:
        image_response = await client.get(
            f"{WORKER_BASE_URL}/api/image/internal/jobs/{lease['id']}/input",
            headers=lease_headers,
        )
        image_response.raise_for_status()
        files["image"] = (
            "input",
            image_response.content,
            image_response.headers.get("content-type", "application/octet-stream"),
        )
    files["spec_json"] = (None, json.dumps(lease["spec"]), "application/json")
    try:
        generated = await gateway.post(
            f"{GATEWAY_URL}/v1/generate",
            headers={"Authorization": f"Bearer {GATEWAY_TOKEN}"},
            files=files,
            timeout=900,
        )
        generated.raise_for_status()
        completed = await client.put(
            f"{WORKER_BASE_URL}/api/image/internal/jobs/{lease['id']}/result",
            headers={
                **lease_headers,
                "Content-Type": generated.headers.get("content-type", "image/png"),
            },
            content=generated.content,
            timeout=120,
        )
        completed.raise_for_status()
    except Exception:
        await client.post(
            f"{WORKER_BASE_URL}/api/image/internal/jobs/{lease['id']}/fail",
            headers=lease_headers,
        )
        raise
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
        try:
            while True:
                try:
                    worked = await run_once(client, gateway)
                    if not worked:
                        await asyncio.sleep(POLL_SECONDS)
                except Exception as exc:
                    print(
                        json.dumps({"event": "worker_agent_error", "error": type(exc).__name__}),
                        flush=True,
                    )
                    await asyncio.sleep(min(POLL_SECONDS * 3, 15))
        finally:
            beat.cancel()


if __name__ == "__main__":
    asyncio.run(main())
