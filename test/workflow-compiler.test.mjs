import test from "node:test";
import assert from "node:assert/strict";
import { compileWorkflow, publicCapabilities, ValidationError } from "../src/workflow-compiler.mjs";
import { readFile } from "node:fs/promises";

const base = {
  model: "wai_v17",
  preset: "portrait",
  positive: "1girl",
  negative: "bad quality",
  seed: "1234567890"
};

test("compiles all six model/preset combinations", () => {
  for (const model of ["wai_v17", "anima_base_10"]) {
    for (const preset of ["portrait", "landscape", "square"]) {
      const result = compileWorkflow({ ...base, model, preset });
      assert.equal(result.metadata.model, model);
      assert.ok(Object.values(result.prompt).some((node) => node.class_type === "KSampler"));
      assert.ok(Object.values(result.prompt).some((node) => node.class_type === "SaveImage"));
    }
  }
});

test("adds I2I, dynamic LoRA and upscale nodes", () => {
  const result = compileWorkflow({
    ...base,
    loras: [{ id: "wai_748cm_style_v1", strength: 0.7 }],
    autoInsertTriggers: true,
    img2img: { enabled: true, denoise: 0.55 },
    upscale: true,
    outputFormat: "webp"
  });
  const classes = Object.values(result.prompt).map((node) => node.class_type);
  assert.ok(classes.includes("LoadImage"));
  assert.ok(classes.includes("LoraLoader"));
  assert.ok(classes.includes("ImageUpscaleWithModel"));
  assert.deepEqual(result.metadata.insertedTriggers, ["748cmstyle"]);
});

test("rejects invalid controls and cross-family LoRA", () => {
  assert.throws(() => compileWorkflow({ ...base, steps: 31 }), ValidationError);
  assert.throws(() => compileWorkflow({
    ...base,
    loras: [{ id: "anima_atomsphere_style_v12", strength: 0.8 }]
  }), ValidationError);
  assert.throws(() => compileWorkflow({ ...base, seed: "42" }), ValidationError);
});

test("public capabilities do not expose filenames or download URLs", () => {
  const serialized = JSON.stringify(publicCapabilities());
  assert.equal(serialized.includes("safetensors"), false);
  assert.equal(serialized.includes("civitai"), false);
});

test("generated ComfyUI UI workflow uses canvas schema", async () => {
  const workflow = JSON.parse(await readFile(
    new URL("../workflows/ui/wai_v17__portrait.json", import.meta.url),
    "utf8"
  ));
  assert.equal(workflow.version, 0.4);
  assert.ok(Array.isArray(workflow.nodes));
  assert.ok(Array.isArray(workflow.links));
  assert.ok(workflow.nodes.some((node) => node.type === "KSampler"));
});
