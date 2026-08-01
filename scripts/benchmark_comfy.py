#!/usr/bin/env python3
"""운영 Worker와 연결하지 않고 로컬 ComfyUI 성능만 측정합니다."""

from __future__ import annotations

import argparse
import copy
import csv
import json
import subprocess
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


def request_json(url: str, *, method: str = "GET", payload: dict | None = None) -> dict:
    body = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(
        url,
        data=body,
        method=method,
        headers={"Content-Type": "application/json"} if body is not None else {},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def wait_ready(base_url: str, timeout: float = 300) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            request_json(f"{base_url}/system_stats")
            return
        except Exception:
            time.sleep(1)
    raise TimeoutError("ComfyUI did not become ready")


def gpu_values() -> tuple[float, float, float]:
    output = subprocess.check_output(
        [
            "nvidia-smi",
            "--query-gpu=memory.used,utilization.gpu,power.draw",
            "--format=csv,noheader,nounits",
        ],
        text=True,
        timeout=5,
    ).strip().splitlines()[0]
    memory, utilization, power = (float(value.strip()) for value in output.split(","))
    return memory, utilization, power


class GpuSampler:
    def __init__(self) -> None:
        self.stop_event = threading.Event()
        self.max_memory_mib = 0.0
        self.max_utilization = 0.0
        self.max_power_w = 0.0
        self.thread = threading.Thread(target=self._sample, daemon=True)

    def _sample(self) -> None:
        while not self.stop_event.is_set():
            try:
                memory, utilization, power = gpu_values()
                self.max_memory_mib = max(self.max_memory_mib, memory)
                self.max_utilization = max(self.max_utilization, utilization)
                self.max_power_w = max(self.max_power_w, power)
            except Exception:
                pass
            self.stop_event.wait(0.2)

    def __enter__(self) -> "GpuSampler":
        self.thread.start()
        return self

    def __exit__(self, *_: object) -> None:
        self.stop_event.set()
        self.thread.join(timeout=2)


def prepared_workflow(path: Path, *, seed: int, batch_size: int) -> dict[str, Any]:
    workflow = copy.deepcopy(json.loads(path.read_text(encoding="utf-8")))
    for node in workflow.values():
        if node.get("class_type") == "KSampler":
            node["inputs"]["seed"] = seed
        elif node.get("class_type") == "EmptyLatentImage":
            node["inputs"]["batch_size"] = batch_size
    return workflow


def run_prompt(base_url: str, workflow: dict[str, Any], timeout: float = 900) -> None:
    submitted = request_json(
        f"{base_url}/prompt",
        method="POST",
        payload={"prompt": workflow},
    )
    prompt_id = submitted.get("prompt_id")
    if not prompt_id:
        raise RuntimeError(f"ComfyUI rejected prompt: {submitted}")
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        history = request_json(f"{base_url}/history/{prompt_id}")
        entry = history.get(prompt_id)
        if entry:
            status = entry.get("status", {})
            if status.get("status_str") == "error":
                messages = status.get("messages", [])
                raise RuntimeError(f"ComfyUI execution failed: {messages[-1:]}")
            if entry.get("outputs"):
                return
        time.sleep(0.25)
    raise TimeoutError(f"generation timed out after {timeout}s")


def benchmark(
    base_url: str,
    model: str,
    phase: str,
    workflow_path: Path,
    *,
    batch_size: int,
    seed: int,
) -> dict[str, Any]:
    workflow = prepared_workflow(workflow_path, seed=seed, batch_size=batch_size)
    started = time.perf_counter()
    error = ""
    with GpuSampler() as gpu:
        try:
            run_prompt(base_url, workflow)
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
    elapsed = time.perf_counter() - started
    return {
        "model": model,
        "phase": phase,
        "batch_size": batch_size,
        "seconds": round(elapsed, 3),
        "seconds_per_image": round(elapsed / batch_size, 3),
        "max_vram_mib": round(gpu.max_memory_mib),
        "max_gpu_util_pct": round(gpu.max_utilization),
        "max_power_w": round(gpu.max_power_w, 1),
        "error": error,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8188")
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument(
        "--smoke-only",
        action="store_true",
        help="Run one batch-1 request for Anima and WAI, then stop.",
    )
    parser.add_argument("--output", default="/workspace/benchmark-results.csv")
    parser.add_argument(
        "--repo",
        type=Path,
        default=Path(__file__).resolve().parents[1],
    )
    args = parser.parse_args()
    if not 1 <= args.runs <= 10:
        parser.error("--runs must be between 1 and 10")

    wait_ready(args.base_url)
    workflows = {
        "anima": args.repo / "workflows/api/anima_base_10__square.json",
        "wai": args.repo / "workflows/api/wai_v17__square.json",
    }
    rows: list[dict[str, Any]] = []
    seed = 7_300_000_000

    def measured(model: str, phase: str, batch_size: int) -> None:
        nonlocal seed
        seed += 1
        row = benchmark(
            args.base_url,
            model,
            phase,
            workflows[model],
            batch_size=batch_size,
            seed=seed,
        )
        rows.append(row)
        print(json.dumps(row, ensure_ascii=False), flush=True)

    # 운영 선호 순서와 동일하게 Anima를 먼저 예열합니다.
    measured("anima", "cold_or_switch", 1)
    if args.smoke_only:
        measured("wai", "switch_from_anima", 1)
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        with output.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
            writer.writeheader()
            writer.writerows(rows)
        print(f"RESULT_CSV={output}", flush=True)
        return 1 if any(row["error"] for row in rows) else 0
    for index in range(args.runs):
        measured("anima", f"warm_{index + 1}", 1)
    measured("wai", "switch_from_anima", 1)
    for index in range(args.runs):
        measured("wai", f"warm_{index + 1}", 1)
    measured("anima", "switch_back_from_wai", 1)

    # 배치 2는 한 번의 전환/예열과 두 번의 측정만 수행합니다.
    for model in ("anima", "wai"):
        measured(model, "batch2_cold_or_switch", 2)
        if not rows[-1]["error"]:
            for index in range(2):
                measured(model, f"batch2_warm_{index + 1}", 2)

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    print(f"RESULT_CSV={output}", flush=True)
    return 1 if any(row["error"] for row in rows) else 0


if __name__ == "__main__":
    raise SystemExit(main())
