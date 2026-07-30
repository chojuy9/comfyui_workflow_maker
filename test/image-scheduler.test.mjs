import test from "node:test";
import assert from "node:assert/strict";
import {
  ANIMA_MODEL,
  WAI_MODEL,
  chooseNextImageModel
} from "../integrations/chatos-auth/image-scheduler.js";

const now = 1_000_000;

test("prefers Anima while a single young WAI job coalesces", () => {
  assert.deepEqual(chooseNextImageModel({
    currentModel: ANIMA_MODEL,
    animaAvailable: true,
    waiCount: 1,
    oldestWaiCreatedAt: now - 4_000,
    now
  }), {
    model: ANIMA_MODEL,
    retryAfterMs: 0,
    reason: "anima_preferred"
  });
});

test("switches to WAI at two jobs or after fifteen seconds", () => {
  assert.equal(chooseNextImageModel({
    currentModel: ANIMA_MODEL,
    animaAvailable: true,
    waiCount: 2,
    oldestWaiCreatedAt: now - 1_000,
    now
  }).model, WAI_MODEL);
  assert.equal(chooseNextImageModel({
    currentModel: ANIMA_MODEL,
    animaAvailable: true,
    waiCount: 1,
    oldestWaiCreatedAt: now - 15_000,
    now
  }).model, WAI_MODEL);
});

test("polls briefly while the GPU waits for a second WAI request", () => {
  assert.deepEqual(chooseNextImageModel({
    currentModel: ANIMA_MODEL,
    animaAvailable: false,
    waiCount: 1,
    oldestWaiCreatedAt: now - 14_500,
    now
  }), {
    model: null,
    retryAfterMs: 500,
    reason: "wai_coalescing"
  });
});

test("reuses WAI for a bounded burst then returns to Anima", () => {
  assert.equal(chooseNextImageModel({
    currentModel: WAI_MODEL,
    waiBurstCount: 3,
    animaAvailable: true,
    waiCount: 2,
    now
  }).model, WAI_MODEL);
  assert.deepEqual(chooseNextImageModel({
    currentModel: WAI_MODEL,
    waiBurstCount: 4,
    animaAvailable: true,
    waiCount: 2,
    now
  }), {
    model: ANIMA_MODEL,
    retryAfterMs: 0,
    reason: "return_to_anima"
  });
});

test("does not switch away from WAI when no Anima work exists", () => {
  assert.equal(chooseNextImageModel({
    currentModel: WAI_MODEL,
    waiBurstCount: 4,
    animaAvailable: false,
    waiCount: 1,
    now
  }).model, WAI_MODEL);
});

test("keeps legacy or unknown jobs on FIFO compatibility path", () => {
  assert.deepEqual(chooseNextImageModel({
    unknownAvailable: true,
    animaAvailable: true,
    waiCount: 2,
    now
  }), {
    model: null,
    retryAfterMs: 0,
    reason: "legacy_fifo"
  });
});
