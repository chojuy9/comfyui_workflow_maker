import { mkdir, writeFile } from "node:fs/promises";
import { compileWorkflow, MODELS, PRESETS } from "../src/workflow-compiler.mjs";

const uiDefs = {
  CheckpointLoaderSimple: { inputs: [], outputs: ["MODEL", "CLIP", "VAE"], widgets: ["ckpt_name"] },
  UNETLoader: { inputs: [], outputs: ["MODEL"], widgets: ["unet_name", "weight_dtype"] },
  CLIPLoader: { inputs: [], outputs: ["CLIP"], widgets: ["clip_name", "type", "device"] },
  VAELoader: { inputs: [], outputs: ["VAE"], widgets: ["vae_name"] },
  LoraLoader: { inputs: [["model", "MODEL"], ["clip", "CLIP"]], outputs: ["MODEL", "CLIP"], widgets: ["lora_name", "strength_model", "strength_clip"] },
  LoraLoaderModelOnly: { inputs: [["model", "MODEL"]], outputs: ["MODEL"], widgets: ["lora_name", "strength_model"] },
  CLIPTextEncode: { inputs: [["clip", "CLIP"]], outputs: ["CONDITIONING"], widgets: ["text"] },
  EmptyLatentImage: { inputs: [], outputs: ["LATENT"], widgets: ["width", "height", "batch_size"] },
  LoadImage: { inputs: [], outputs: ["IMAGE", "MASK"], widgets: ["image", "upload"] },
  ImageScale: { inputs: [["image", "IMAGE"]], outputs: ["IMAGE"], widgets: ["upscale_method", "width", "height", "crop"] },
  VAEEncode: { inputs: [["pixels", "IMAGE"], ["vae", "VAE"]], outputs: ["LATENT"], widgets: [] },
  KSampler: {
    inputs: [["model", "MODEL"], ["positive", "CONDITIONING"], ["negative", "CONDITIONING"], ["latent_image", "LATENT"]],
    outputs: ["LATENT"],
    widgets: ["seed", "control_after_generate", "steps", "cfg", "sampler_name", "scheduler", "denoise"]
  },
  VAEDecode: { inputs: [["samples", "LATENT"], ["vae", "VAE"]], outputs: ["IMAGE"], widgets: [] },
  UpscaleModelLoader: { inputs: [], outputs: ["UPSCALE_MODEL"], widgets: ["model_name"] },
  ImageUpscaleWithModel: { inputs: [["upscale_model", "UPSCALE_MODEL"], ["image", "IMAGE"]], outputs: ["IMAGE"], widgets: [] },
  SaveImage: { inputs: [["images", "IMAGE"]], outputs: [], widgets: ["filename_prefix"] }
};

function toUiWorkflow(prompt, metadata) {
  const depths = new Map();
  const depthOf = (id) => {
    if (depths.has(id)) return depths.get(id);
    const refs = Object.values(prompt[id].inputs).filter((value) => Array.isArray(value));
    const depth = refs.length ? Math.max(...refs.map(([source]) => depthOf(String(source)))) + 1 : 0;
    depths.set(id, depth);
    return depth;
  };
  for (const id of Object.keys(prompt)) depthOf(id);
  const rowsAtDepth = new Map();
  const nodes = [];
  const links = [];
  let linkId = 1;

  for (const [id, apiNode] of Object.entries(prompt)) {
    const def = uiDefs[apiNode.class_type];
    if (!def) throw new Error(`Missing UI definition for ${apiNode.class_type}`);
    const depth = depths.get(id);
    const row = rowsAtDepth.get(depth) ?? 0;
    rowsAtDepth.set(depth, row + 1);
    const inputs = def.inputs.map(([name, type], targetSlot) => {
      const reference = apiNode.inputs[name];
      let link = null;
      if (Array.isArray(reference)) {
        link = linkId++;
        links.push([link, Number(reference[0]), reference[1], Number(id), targetSlot, type]);
      }
      return { name, type, link };
    });
    const widgets = def.widgets.map((name) => {
      if (name === "control_after_generate") return "fixed";
      if (name === "upload") return "image";
      return apiNode.inputs[name];
    });
    nodes.push({
      id: Number(id),
      type: apiNode.class_type,
      pos: [60 + depth * 300, 80 + row * 230],
      size: [260, apiNode.class_type === "CLIPTextEncode" ? 200 : 150],
      flags: {},
      order: Number(id) - 1,
      mode: 0,
      inputs,
      outputs: def.outputs.map((type, slot) => ({
        name: type,
        type,
        links: links.filter((link) => link[1] === Number(id) && link[2] === slot).map((link) => link[0]),
        slot_index: slot
      })),
      properties: { "Node name for S&R": apiNode.class_type },
      widgets_values: widgets,
      title: apiNode._meta?.title
    });
  }
  // Output link arrays need the complete link list, including links created by later nodes.
  for (const node of nodes) {
    for (const output of node.outputs) {
      output.links = links.filter((link) => link[1] === node.id && link[2] === output.slot_index).map((link) => link[0]);
    }
  }
  return {
    last_node_id: Math.max(...nodes.map((node) => node.id)),
    last_link_id: links.length,
    nodes,
    links,
    groups: [],
    config: {},
    extra: { chatos: metadata },
    version: 0.4
  };
}

await mkdir(new URL("../workflows/api/", import.meta.url), { recursive: true });
await mkdir(new URL("../workflows/ui/", import.meta.url), { recursive: true });

for (const model of Object.keys(MODELS)) {
  for (const preset of Object.keys(PRESETS)) {
    const compiled = compileWorkflow({
      model,
      preset,
      positive: "masterpiece, best quality, 1girl, solo",
      negative: "worst quality, low quality, text, watermark",
      seed: "1234567890",
      loras: []
    });
    const basename = `${model}__${preset}`;
    await writeFile(
      new URL(`../workflows/api/${basename}.json`, import.meta.url),
      `${JSON.stringify(compiled.prompt, null, 2)}\n`
    );
    await writeFile(
      new URL(`../workflows/ui/${basename}.json`, import.meta.url),
      `${JSON.stringify(toUiWorkflow(compiled.prompt, compiled.metadata), null, 2)}\n`
    );
  }
}
