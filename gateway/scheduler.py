from __future__ import annotations

from dataclasses import dataclass

ANIMA_MODEL = "anima_base_10"
WAI_MODEL = "wai_v17"
SCHEDULER_VERSION = "1"


@dataclass
class SchedulerState:
    """GPU에 현재 올라간 모델과 이번 WAI 연속 처리 수를 기억합니다."""

    current_model: str = ANIMA_MODEL
    wai_burst_count: int = 0

    def lease_headers(self) -> dict[str, str]:
        return {
            "X-Image-Scheduler": SCHEDULER_VERSION,
            "X-Current-Model": self.current_model,
            "X-WAI-Burst-Count": str(self.wai_burst_count),
        }

    def record_completed_model(self, model: str | None) -> None:
        if model == WAI_MODEL:
            self.wai_burst_count = (
                self.wai_burst_count + 1 if self.current_model == WAI_MODEL else 1
            )
            self.current_model = WAI_MODEL
        elif model == ANIMA_MODEL:
            self.current_model = ANIMA_MODEL
            self.wai_burst_count = 0


def retry_after_seconds(raw_milliseconds: str | None, poll_seconds: float) -> float:
    """Worker가 WAI 합류를 기다리라고 한 짧은 재확인 시간을 읽습니다."""
    if raw_milliseconds is None:
        return poll_seconds
    try:
        seconds = float(raw_milliseconds) / 1000
    except (TypeError, ValueError):
        return poll_seconds
    return max(0.05, min(poll_seconds, seconds))
