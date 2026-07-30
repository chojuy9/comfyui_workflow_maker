import generationPolicy from "../config/generation-policy.json" with { type: "json" };
import loraRegistry from "../config/lora-registry.json" with { type: "json" };
import servicePolicy from "../config/service-policy.json" with { type: "json" };

export const PRESETS = Object.freeze({
  portrait: { width: 832, height: 1216, label: "2:3 세로" },
  landscape: { width: 1216, height: 832, label: "3:2 가로" },
  square: { width: 1024, height: 1024, label: "1:1 정사각형" }
});

export const MODELS = Object.freeze({
  wai_v17: {
    family: "sdxl",
    label: "WAI Illustrious SDXL v17.0",
    checkpoint: "waiIllustriousSDXL_v170.safetensors"
  },
  anima_base_10: {
    family: "anima",
    label: "Anima Base 1.0",
    diffusion: "anima-base-v1.0.safetensors",
    clip: "qwen_3_06b_base.safetensors",
    vae: "qwen_image_vae.safetensors"
  }
});

const registry = new Map(loraRegistry.entries.map((entry) => [entry.id, entry]));

export class ValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = "ValidationError";
    this.field = field;
  }
}

function assert(condition, message, field) {
  if (!condition) throw new ValidationError(message, field);
}

function boundedNumber(value, rule, field) {
  const number = Number(value);
  assert(Number.isFinite(number), `${field} 값이 숫자가 아닙니다.`, field);
  assert(number >= rule.min && number <= rule.max, `${field} 허용 범위는 ${rule.min}–${rule.max}입니다.`, field);
  return number;
}

function normalizeSeed(value) {
  const seed = value == null || value === "" || value === "random"
    ? randomTenDigitSeed()
    : String(value);
  assert(new RegExp(generationPolicy.seed.pattern).test(seed), "시드는 0으로 시작하지 않는 정확히 10자리 숫자여야 합니다.", "seed");
  return Number(seed);
}

function randomTenDigitSeed() {
  const span = 9_000_000_000n;
  const space = 1n << 64n;
  const ceiling = space - (space % span);
  const values = new Uint32Array(2);
  do {
    crypto.getRandomValues(values);
    const candidate = (BigInt(values[0]) << 32n) | BigInt(values[1]);
    if (candidate < ceiling) return String(1_000_000_000n + candidate % span);
  } while (true);
}

function validateLoras(model, selected = []) {
  assert(Array.isArray(selected), "LoRA 목록 형식이 잘못되었습니다.", "loras");
  assert(selected.length <= servicePolicy.generation.maxEnabledLorasPerJob, "LoRA는 최대 3개까지 사용할 수 있습니다.", "loras");
  const seen = new Set();
  return selected.map((choice) => {
    const entry = registry.get(choice.id);
    assert(entry?.enabled, "허용되지 않은 LoRA입니다.", "loras");
    assert(entry.family === model.family, "선택한 모델과 LoRA 계열이 다릅니다.", "loras");
    assert(!seen.has(entry.id), "같은 LoRA를 중복 선택할 수 없습니다.", "loras");
    seen.add(entry.id);
    const strength = boundedNumber(
      choice.strength ?? entry.strength.defaultWhenEnabled,
      entry.strength,
      `loras.${entry.id}.strength`
    );
    return { entry, strength };
  });
}

function makeNode(classType, inputs, title) {
  return { class_type: classType, inputs, _meta: { title } };
}

function appendTriggers(prompt, loras, enabled) {
  if (!enabled) return { text: prompt, inserted: [] };
  const inserted = [...new Set(loras.flatMap(({ entry }) => entry.triggerWords))];
  return {
    text: [inserted.join(", "), prompt.trim()].filter(Boolean).join(", "),
    inserted
  };
}

export function validateRequest(raw) {
  const model = MODELS[raw.model];
  const preset = PRESETS[raw.preset];
  assert(model, "지원하지 않는 모델입니다.", "model");
  assert(preset, "지원하지 않는 해상도 프리셋입니다.", "preset");
  const rules = generationPolicy.models[raw.model];
  const steps = boundedNumber(raw.steps ?? rules.steps.default, rules.steps, "steps");
  const cfg = boundedNumber(raw.cfg ?? rules.cfg.default, rules.cfg, "cfg");
  const sampler = raw.sampler ?? rules.samplers.default;
  const scheduler = raw.scheduler ?? rules.schedulers.default;
  assert(rules.samplers.allowed.includes(sampler), "지원하지 않는 샘플러입니다.", "sampler");
  assert(rules.schedulers.allowed.includes(scheduler), "지원하지 않는 스케줄러입니다.", "scheduler");
  const positive = String(raw.positive ?? "").trim();
  const negative = String(raw.negative ?? "").trim();
  assert(positive.length > 0, "Positive prompt는 비워둘 수 없습니다.", "positive");
  // Exact tokenizer limits are enforced by the GPU gateway before queueing ComfyUI.
  assert(positive.length <= 32768, "Positive prompt가 지나치게 깁니다.", "positive");
  assert(negative.length <= 65536, "Negative prompt가 지나치게 깁니다.", "negative");
  const loras = validateLoras(model, raw.loras);
  const triggerResult = appendTriggers(positive, loras, raw.autoInsertTriggers !== false);
  const img2img = raw.img2img?.enabled === true;
  const denoise = img2img ? boundedNumber(raw.img2img.denoise ?? 0.65, { min: 0.05, max: 1 }, "img2img.denoise") : 1;
  const outputFormat = raw.outputFormat ?? servicePolicy.output.defaultFormat;
  assert(servicePolicy.output.allowedFormats.includes(outputFormat), "지원하지 않는 출력 형식입니다.", "outputFormat");
  return {
    modelKey: raw.model,
    model,
    presetKey: raw.preset,
    preset,
    seed: normalizeSeed(raw.seed),
    steps,
    cfg,
    sampler,
    scheduler,
    positive: triggerResult.text,
    negative,
    insertedTriggers: triggerResult.inserted,
    loras,
    img2img,
    denoise,
    upscale: raw.upscale === true,
    outputFormat
  };
}

export function compileWorkflow(raw) {
  const request = validateRequest(raw);
  const nodes = {};
  let nextId = 1;
  const add = (classType, inputs, title) => {
    const id = String(nextId++);
    nodes[id] = makeNode(classType, inputs, title);
    return id;
  };

  let modelId;
  let clipId;
  let vaeId;
  if (request.model.family === "sdxl") {
    const loader = add("CheckpointLoaderSimple", { ckpt_name: request.model.checkpoint }, request.model.label);
    modelId = loader;
    clipId = loader;
    vaeId = loader;
  } else {
    modelId = add("UNETLoader", {
      unet_name: request.model.diffusion,
      weight_dtype: "default"
    }, "Anima diffusion model");
    clipId = add("CLIPLoader", {
      clip_name: request.model.clip,
      type: "stable_diffusion",
      device: "default"
    }, "Anima Qwen text encoder");
    vaeId = add("VAELoader", { vae_name: request.model.vae }, "Anima VAE");
  }

  for (const { entry, strength } of request.loras) {
    if (request.model.family === "anima") {
      modelId = add("LoraLoaderModelOnly", {
        model: [modelId, 0],
        lora_name: entry.file.name,
        strength_model: strength
      }, entry.label);
    } else {
      const lora = add("LoraLoader", {
        model: [modelId, 0],
        clip: [clipId, 1],
        lora_name: entry.file.name,
        strength_model: strength,
        strength_clip: strength
      }, entry.label);
      modelId = lora;
      clipId = lora;
    }
  }

  const positiveId = add("CLIPTextEncode", {
    text: request.positive,
    clip: [clipId, request.model.family === "sdxl" ? 1 : 0]
  }, "Positive prompt");
  const negativeId = add("CLIPTextEncode", {
    text: request.negative,
    clip: [clipId, request.model.family === "sdxl" ? 1 : 0]
  }, "Negative prompt");

  let latentId;
  if (request.img2img) {
    const imageId = add("LoadImage", { image: "__INPUT_IMAGE__" }, "Normalized I2I input");
    const scaleId = add("ImageScale", {
      image: [imageId, 0],
      upscale_method: "lanczos",
      width: request.preset.width,
      height: request.preset.height,
      crop: "center"
    }, "Fit input to preset");
    latentId = add("VAEEncode", {
      pixels: [scaleId, 0],
      vae: [vaeId, request.model.family === "sdxl" ? 2 : 0]
    }, "Encode I2I input");
  } else {
    latentId = add("EmptyLatentImage", {
      width: request.preset.width,
      height: request.preset.height,
      batch_size: 1
    }, request.preset.label);
  }

  const samplerId = add("KSampler", {
    seed: request.seed,
    steps: request.steps,
    cfg: request.cfg,
    sampler_name: request.sampler,
    scheduler: request.scheduler,
    denoise: request.denoise,
    model: [modelId, 0],
    positive: [positiveId, 0],
    negative: [negativeId, 0],
    latent_image: [latentId, 0]
  }, "Sampler");
  const decodedId = add("VAEDecode", {
    samples: [samplerId, 0],
    vae: [vaeId, request.model.family === "sdxl" ? 2 : 0]
  }, "Decode image");

  let finalImageId = decodedId;
  if (request.upscale) {
    const upscaleModel = add("UpscaleModelLoader", {
      model_name: "RealESRGAN_x2plus.pth"
    }, "Real-ESRGAN 2×");
    finalImageId = add("ImageUpscaleWithModel", {
      upscale_model: [upscaleModel, 0],
      image: [decodedId, 0]
    }, "2× upscale");
  }
  add("SaveImage", {
    filename_prefix: `chatos/${request.modelKey}/${request.presetKey}`,
    images: [finalImageId, 0]
  }, "Save result");

  return {
    prompt: nodes,
    metadata: {
      schemaVersion: 1,
      model: request.modelKey,
      preset: request.presetKey,
      width: request.preset.width * (request.upscale ? 2 : 1),
      height: request.preset.height * (request.upscale ? 2 : 1),
      positive: request.positive,
      negative: request.negative,
      seed: request.seed,
      steps: request.steps,
      cfg: request.cfg,
      sampler: request.sampler,
      scheduler: request.scheduler,
      loras: request.loras.map(({ id, strength }) => ({ id, strength })),
      upscale: request.upscale,
      insertedTriggers: request.insertedTriggers,
      outputFormat: request.outputFormat
    }
  };
}

export function publicCapabilities() {
  return {
    presets: PRESETS,
    models: Object.fromEntries(Object.entries(MODELS).map(([id, model]) => [
      id,
      {
        id,
        family: model.family,
        label: model.label,
        generation: generationPolicy.models[id],
        loras: loraRegistry.entries
          .filter((entry) => entry.enabled && entry.family === model.family)
          .map(({ id: loraId, label, nsfw = false, triggerWords, strength }) => ({
            id: loraId,
            label,
            nsfw,
            triggerWords,
            strength
          }))
      }
    ])),
    limits: {
      maxImagesPerRequest: servicePolicy.generation.maxImagesPerRequest,
      maxLoras: servicePolicy.generation.maxEnabledLorasPerJob,
      daily: servicePolicy.quota.dailyDisplayLimit,
      weekly: servicePolicy.quota.weeklyDisplayLimit
    },
    outputFormats: servicePolicy.output.allowedFormats
  };
}
