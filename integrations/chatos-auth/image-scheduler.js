export const ANIMA_MODEL = "anima_base_10";
export const WAI_MODEL = "wai_v17";
export const WAI_WAIT_MS = 15_000;
export const WAI_BATCH_THRESHOLD = 2;
export const WAI_BURST_MAX = 4;
export const COALESCE_POLL_MS = 2_000;

export function chooseNextImageModel({
  currentModel = ANIMA_MODEL,
  waiBurstCount = 0,
  animaAvailable = false,
  waiCount = 0,
  oldestWaiCreatedAt = null,
  unknownAvailable = false,
  now = Date.now()
} = {}) {
  if (unknownAvailable) {
    return { model: null, retryAfterMs: 0, reason: "legacy_fifo" };
  }
  const current = currentModel === WAI_MODEL ? WAI_MODEL : ANIMA_MODEL;
  const burst = Number.isFinite(Number(waiBurstCount))
    ? Math.max(0, Math.floor(Number(waiBurstCount)))
    : 0;
  const waiQueued = Math.max(0, Number(waiCount) || 0);
  if (current === WAI_MODEL) {
    if (waiQueued > 0 && (burst < WAI_BURST_MAX || !animaAvailable)) {
      return { model: WAI_MODEL, retryAfterMs: 0, reason: "wai_burst" };
    }
    if (animaAvailable) {
      return { model: ANIMA_MODEL, retryAfterMs: 0, reason: "return_to_anima" };
    }
    return { model: null, retryAfterMs: 0, reason: "empty" };
  }
  const oldest = Number(oldestWaiCreatedAt);
  const waiAgeMs = Number.isFinite(oldest) ? Math.max(0, now - oldest) : 0;
  const waiReady = waiQueued >= WAI_BATCH_THRESHOLD || waiAgeMs >= WAI_WAIT_MS;
  if (waiQueued > 0 && waiReady) {
    return {
      model: WAI_MODEL,
      retryAfterMs: 0,
      reason: waiQueued >= WAI_BATCH_THRESHOLD ? "wai_batch_ready" : "wai_wait_expired"
    };
  }
  if (animaAvailable) {
    return { model: ANIMA_MODEL, retryAfterMs: 0, reason: "anima_preferred" };
  }
  if (waiQueued > 0) {
    return {
      model: null,
      retryAfterMs: Math.max(1, Math.min(COALESCE_POLL_MS, WAI_WAIT_MS - waiAgeMs)),
      reason: "wai_coalescing"
    };
  }
  return { model: null, retryAfterMs: 0, reason: "empty" };
}
