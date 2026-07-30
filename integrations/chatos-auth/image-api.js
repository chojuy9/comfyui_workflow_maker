import { compileWorkflow, publicCapabilities, ValidationError } from "../../src/workflow-compiler.mjs";

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function error(code, status = 400) {
  return json({ error: code }, status);
}

function queue(env) {
  return env.IMAGE_QUEUE.getByName("gpu:primary");
}

function quota(env, accountId) {
  return env.IMAGE_QUOTA.getByName(`account:${accountId}`);
}

function authorizedInternal(request, env) {
  const value = request.headers.get("Authorization") ?? "";
  const expected = `Bearer ${env.IMAGE_GATEWAY_TOKEN}`;
  if (value.length !== expected.length) return false;
  const encoder = new TextEncoder();
  return crypto.subtle.timingSafeEqual(encoder.encode(value), encoder.encode(expected));
}

function contentTypeAllowed(value) {
  return ["image/png", "image/jpeg", "image/webp", "image/avif"].includes(value);
}

export async function handleImageApi(request, env, ctx, account) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/api/image/capabilities" && request.method === "GET") {
    return json(publicCapabilities());
  }
  if (path.startsWith("/api/image/internal/")) {
    return handleInternal(request, env);
  }
  if (!account?.id) return error("authentication_required", 401);

  if (path === "/api/image/quota" && request.method === "GET") {
    const status = await quota(env, account.id).status();
    return json({
      dailyUsed: status.dailyUnits / 2,
      dailyLimit: 50,
      weeklyUsed: status.weeklyUnits / 2,
      weeklyLimit: 250,
      queued: status.queued,
      running: status.running
    });
  }

  if (path === "/api/image/presets" && request.method === "GET") {
    return json({ items: await quota(env, account.id).listPresets() });
  }

  if (path === "/api/image/presets" && request.method === "POST") {
    const body = await request.json();
    const name = String(body.name ?? "").trim();
    if (!name || name.length > 60) return error("invalid_preset_name", 400);
    try {
      compileWorkflow(body.spec ?? {});
    } catch (cause) {
      if (cause instanceof ValidationError) return json({ error: "invalid_request", field: cause.field }, 400);
      throw cause;
    }
    const id = /^[0-9a-f-]{36}$/.test(String(body.id ?? "")) ? body.id : crypto.randomUUID();
    const saved = await quota(env, account.id).savePreset({ id, name, spec: body.spec });
    return saved.ok ? json(saved, 201) : error(saved.reason, 409);
  }

  const presetMatch = path.match(/^\/api\/image\/presets\/([0-9a-f-]{36})$/);
  if (presetMatch && request.method === "DELETE") {
    await quota(env, account.id).deletePreset(presetMatch[1]);
    return json({ ok: true });
  }

  if (path === "/api/image/jobs" && request.method === "POST") {
    return submitJob(request, env, account);
  }

  if (path === "/api/image/history" && request.method === "GET") {
    const kind = url.searchParams.get("kind") === "gallery" ? "gallery" : "history";
    return json({ items: await queue(env).list(account.id, kind) });
  }

  const jobMatch = path.match(/^\/api\/image\/jobs\/([0-9a-f-]{36})$/);
  if (jobMatch && request.method === "GET") {
    const job = await queue(env).get(jobMatch[1], account.id);
    return job ? json(job) : error("job_not_found", 404);
  }

  const resultMatch = path.match(/^\/api\/image\/jobs\/([0-9a-f-]{36})\/result$/);
  if (resultMatch && request.method === "GET") {
    const job = await queue(env).get(resultMatch[1], account.id);
    if (!job?.hasResult || job.status !== "completed") return error("result_not_ready", 404);
    const key = `results/${account.id}/${job.id}`;
    const object = await env.CHATOS_IMAGES.get(key);
    if (!object) return error("result_not_found", 404);
    return new Response(object.body, {
      headers: {
        "Content-Type": object.httpMetadata?.contentType ?? job.outputType ?? "image/png",
        "Content-Length": String(object.size),
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": `inline; filename="${job.id}.${job.outputType === "image/webp" ? "webp" : "png"}"`
      }
    });
  }

  const collectionMatch = path.match(/^\/api\/image\/jobs\/([0-9a-f-]{36})\/(saved|pinned)$/);
  if (collectionMatch && request.method === "PUT") {
    const body = await request.json();
    const collection = collectionMatch[2] === "saved" ? "gallery" : "history";
    const changed = await queue(env).setCollection(collectionMatch[1], account.id, collection, body.enabled === true);
    return changed.ok ? json(changed) : error(changed.reason, changed.reason === "collection_limit" ? 409 : 404);
  }

  return error("not_found", 404);
}

export async function cleanupImageRetention(env) {
  const keys = await queue(env).cleanup(Date.now());
  if (keys.length) await env.CHATOS_IMAGES.delete(keys);
  return { deleted: keys.length };
}

export async function getImageAdminStatus(env) {
  return queue(env).stats();
}

async function submitJob(request, env, account) {
  const contentType = request.headers.get("Content-Type") ?? "";
  let raw;
  let image = null;
  if (contentType.startsWith("multipart/form-data")) {
    const form = await request.formData();
    raw = JSON.parse(String(form.get("spec") ?? "{}"));
    image = form.get("image");
  } else {
    raw = await request.json();
  }
  if (image instanceof File && (image.size > 10 * 1024 * 1024 || !contentTypeAllowed(image.type))) {
    return error("invalid_i2i_image", 400);
  }
  const moderation = await moderate(raw, env, account.id, image);
  if (!moderation.ok) {
    return error(moderation.reason, moderation.reason === "content_blocked" ? 403 : 503);
  }
  let compiled;
  try {
    compiled = compileWorkflow(raw);
  } catch (cause) {
    if (cause instanceof ValidationError) return json({ error: "invalid_request", field: cause.field }, 400);
    throw cause;
  }
  if (compiled.prompt && raw.img2img?.enabled === true) {
    if (!(image instanceof File)) return error("i2i_image_required", 400);
  } else if (image instanceof File) {
    return error("unexpected_image", 400);
  }

  const costUnits = raw.img2img?.enabled === true ? 3 : 2;
  const reserved = await quota(env, account.id).reserve(costUnits);
  if (!reserved.ok) return json({ error: reserved.reason }, 429);

  const id = crypto.randomUUID();
  const inputKey = image instanceof File ? `inputs/${account.id}/${id}` : null;
  try {
    if (inputKey) {
      await env.CHATOS_IMAGES.put(inputKey, image.stream(), {
        httpMetadata: { contentType: image.type },
        customMetadata: { accountId: account.id, jobId: id, temporary: "true" }
      });
    }
    await queue(env).enqueue({
      id,
      accountId: account.id,
      costUnits,
      quotaDayKey: reserved.dayKey,
      quotaWeekKey: reserved.weekKey,
      inputKey,
      spec: {
        prompt: compiled.prompt,
        metadata: {
          ...compiled.metadata,
          baseWidth: compiled.metadata.width / (raw.upscale === true ? 2 : 1),
          baseHeight: compiled.metadata.height / (raw.upscale === true ? 2 : 1),
          fitMode: raw.img2img?.fitMode ?? "center_crop"
        }
      }
    });
    return json({ id, status: "queued", cost: costUnits / 2 }, 202);
  } catch (cause) {
    if (inputKey) await env.CHATOS_IMAGES.delete(inputKey);
    await quota(env, account.id).release(costUnits, "queued", reserved.dayKey, reserved.weekKey);
    console.error(JSON.stringify({ event: "image_submit_failed", jobId: id, cause: String(cause) }));
    return error("submit_failed", 503);
  }
}

async function moderate(raw, env, accountId, image) {
  if (env.IMAGE_MODERATION_MODE === "disabled" && env.ENVIRONMENT !== "production") {
    return { ok: true };
  }
  if (!env.IMAGE_MODERATION) return { ok: false, reason: "moderation_unavailable" };
  try {
    const payload = {
      accountId,
      positive: String(raw.positive ?? ""),
      negative: String(raw.negative ?? ""),
      hasInputImage: image instanceof File,
      policy: {
        blockMinorSexual: true,
        blockRealPerson: true,
        blockIllegal: true,
        adultContent: "partially_allowed"
      }
    };
    let body;
    let headers;
    if (image instanceof File) {
      body = new FormData();
      body.set("request", JSON.stringify(payload));
      body.set("image", image);
      headers = {};
    } else {
      body = JSON.stringify(payload);
      headers = { "Content-Type": "application/json" };
    }
    const response = await env.IMAGE_MODERATION.fetch("https://moderation.internal/v1/image-prompt", {
      method: "POST",
      headers,
      body
    });
    if (!response.ok) return { ok: false, reason: "moderation_unavailable" };
    const result = await response.json();
    return result.allowed === true
      ? { ok: true }
      : { ok: false, reason: "content_blocked" };
  } catch (cause) {
    console.error(JSON.stringify({ event: "image_moderation_failed", cause: String(cause) }));
    return { ok: false, reason: "moderation_unavailable" };
  }
}

async function handleInternal(request, env) {
  if (!authorizedInternal(request, env)) return error("unauthorized", 401);
  const url = new URL(request.url);
  if (url.pathname === "/api/image/internal/lease" && request.method === "POST") {
    const schedulerVersion = request.headers.get("X-Image-Scheduler") ?? "";
    let leased;
    if (schedulerVersion === "1") {
      const currentModel = request.headers.get("X-Current-Model") ?? "anima_base_10";
      const rawBurst = Number(request.headers.get("X-WAI-Burst-Count") ?? "0");
      const scheduled = await queue(env).leaseScheduled({
        currentModel,
        waiBurstCount: Number.isFinite(rawBurst) ? Math.max(0, Math.min(100, rawBurst)) : 0
      });
      leased = scheduled.lease;
      if (!leased) {
        const headers = scheduled.retryAfterMs > 0
          ? { "X-Retry-After-Ms": String(scheduled.retryAfterMs) }
          : undefined;
        return new Response(null, { status: 204, headers });
      }
    } else {
      leased = await queue(env).lease();
    }
    if (!leased) return new Response(null, { status: 204 });
    const running = await quota(env, leased.accountId).markRunning();
    if (!running.ok) {
      await queue(env).fail(leased.id, leased.leaseToken, "quota_state_conflict");
      return error("lease_conflict", 409);
    }
    return json(leased);
  }

  const inputMatch = url.pathname.match(/^\/api\/image\/internal\/jobs\/([0-9a-f-]{36})\/input$/);
  if (inputMatch && request.method === "GET") {
    const token = request.headers.get("X-Lease-Token") ?? "";
    const key = await queue(env).inputKey(inputMatch[1], token);
    if (!key) return error("input_not_found", 404);
    const object = await env.CHATOS_IMAGES.get(key);
    return object
      ? new Response(object.body, { headers: { "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream" } })
      : error("input_not_found", 404);
  }

  const resultMatch = url.pathname.match(/^\/api\/image\/internal\/jobs\/([0-9a-f-]{36})\/result$/);
  if (resultMatch && request.method === "PUT") {
    const contentType = request.headers.get("Content-Type") ?? "";
    if (!["image/png", "image/webp"].includes(contentType)) return error("invalid_result_type", 400);
    const token = request.headers.get("X-Lease-Token") ?? "";
    const target = await queue(env).resultTarget(resultMatch[1], token);
    if (!target) return error("invalid_lease", 409);
    const finalKey = `results/${target.accountId}/${resultMatch[1]}`;
    await env.CHATOS_IMAGES.put(finalKey, request.body, {
      httpMetadata: { contentType },
      customMetadata: { accountId: target.accountId, jobId: resultMatch[1], retention: "30d" }
    });
    const completed = await queue(env).complete(resultMatch[1], token, finalKey, contentType);
    if (!completed) {
      await env.CHATOS_IMAGES.delete(finalKey);
      return error("invalid_lease", 409);
    }
    if (completed.inputKey) await env.CHATOS_IMAGES.delete(completed.inputKey);
    await quota(env, completed.accountId).finish();
    return json({ ok: true });
  }

  const failMatch = url.pathname.match(/^\/api\/image\/internal\/jobs\/([0-9a-f-]{36})\/fail$/);
  if (failMatch && request.method === "POST") {
    const token = request.headers.get("X-Lease-Token") ?? "";
    const failed = await queue(env).fail(failMatch[1], token, "generation_failed");
    if (!failed) return error("invalid_lease", 409);
    if (failed.inputKey) await env.CHATOS_IMAGES.delete(failed.inputKey);
    await quota(env, failed.accountId).release(
      failed.costUnits,
      "running",
      failed.quotaDayKey,
      failed.quotaWeekKey
    );
    return json({ ok: true });
  }
  return error("not_found", 404);
}
