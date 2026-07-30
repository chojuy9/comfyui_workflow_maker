import unittest

from scheduler import ANIMA_MODEL, WAI_MODEL, SchedulerState, retry_after_seconds


class SchedulerStateTest(unittest.TestCase):
    def test_tracks_wai_burst_and_resets_on_anima(self) -> None:
        state = SchedulerState()
        self.assertEqual(state.lease_headers()["X-Current-Model"], ANIMA_MODEL)
        state.record_completed_model(WAI_MODEL)
        state.record_completed_model(WAI_MODEL)
        self.assertEqual(state.current_model, WAI_MODEL)
        self.assertEqual(state.wai_burst_count, 2)
        state.record_completed_model(ANIMA_MODEL)
        self.assertEqual(state.current_model, ANIMA_MODEL)
        self.assertEqual(state.wai_burst_count, 0)

    def test_ignores_unknown_model(self) -> None:
        state = SchedulerState()
        state.record_completed_model("future_model")
        self.assertEqual(state.current_model, ANIMA_MODEL)
        self.assertEqual(state.wai_burst_count, 0)

    def test_reads_bounded_retry_header(self) -> None:
        self.assertEqual(retry_after_seconds("500", 15), 0.5)
        self.assertEqual(retry_after_seconds("999999", 15), 15)


if __name__ == "__main__":
    unittest.main()
