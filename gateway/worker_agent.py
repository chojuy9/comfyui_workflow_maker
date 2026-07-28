from __future__ import annotations

import asyncio
import json
import os

import httpx

WORKER_BASE_URL = os.environ.get("WORKER_BASE_URL", "").rstrip("/")
WORKER_API_TOKEN = os.environ.get("WORKER_API_TOKEN", "")
GATEWAY_TOKEN = os.environ.get("GATEWAY_TOKEN", "")
POLL_SECONDS = float(os.environ.get("POLL_SECONDS", "2"))
# 8080 은 Vast.ai 인스턴스에서 이미 쓰고 있는 경우가 많습니다.
# 겹치면 게이트웨이가 바인드에 실패하고 에이전트까지 못 뜹니다.
GATEWAY_PORT = os.environ.get("GATEWAY_PORT", "8791")
GATEWAY_URL = f"http://127.0.0.1:{GATEWAY_PORT}"


async def run_once(client: httpx.AsyncClient) -> bool:
    headers = {"Authorization": f"Bearer {WORKER_API_TOKEN}"}
    response = await client.post(f"{WORKER_BASE_URL}/api/image/internal/lease", headers=headers)
    if response.status_code == 204:
        return False
    response.raise_for_status()
    lease = response.json()
    lease_headers = {**headers, "X-Lease-Token": lease["leaseToken"]}
    files: dict[str, tuple[str, bytes, str]] = {}
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
        generated = await client.post(
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


async def main() -> None:
    if not WORKER_BASE_URL or not WORKER_API_TOKEN:
        raise RuntimeError("WORKER_BASE_URL and WORKER_API_TOKEN must be configured")
    async with httpx.AsyncClient(follow_redirects=False, timeout=60) as client:
        while True:
            try:
                worked = await run_once(client)
                if not worked:
                    await asyncio.sleep(POLL_SECONDS)
            except Exception as exc:
                print(json.dumps({"event": "worker_agent_error", "error": type(exc).__name__}), flush=True)
                await asyncio.sleep(min(POLL_SECONDS * 3, 15))


if __name__ == "__main__":
    asyncio.run(main())
