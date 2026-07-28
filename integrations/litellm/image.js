const $ = (selector) => document.querySelector(selector);
const state = {
  capabilities: null, model: "wai_v17", preset: "portrait",
  jobId: null, poll: null, presets: []
};

const formatNames = {
  euler_ancestral: "Euler a", euler: "Euler", dpmpp_2m: "DPM++ 2M",
  dpmpp_2m_sde: "DPM++ 2M SDE", dpmpp_3m_sde: "DPM++ 3M SDE",
  dpmpp_2m_sde_gpu: "DPM++ 2M SDE GPU", uni_pc: "UniPC", er_sde: "ER-SDE"
};

function randomSeed() {
  const values = new Uint32Array(2);
  const span = 9_000_000_000n;
  const space = 1n << 64n;
  const ceiling = space - (space % span);
  do {
    crypto.getRandomValues(values);
    const candidate = (BigInt(values[0]) << 32n) | BigInt(values[1]);
    if (candidate < ceiling) return String(1_000_000_000n + candidate % span);
  } while (true);
}

function optionButtons(container, entries, selected, callback) {
  container.replaceChildren(...entries.map(([id, item]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `choice${id === selected ? " on" : ""}`;
    button.dataset.value = id;
    button.innerHTML = `<strong>${item.label}</strong><span>${item.width ? `${item.width} × ${item.height}` : item.family.toUpperCase()}</span>`;
    button.addEventListener("click", () => callback(id));
    return button;
  }));
}

function selectOptions(element, values, selected) {
  element.replaceChildren(...values.map((value) => new Option(formatNames[value] ?? value, value, false, value === selected)));
}

function renderModel() {
  const model = state.capabilities.models[state.model];
  optionButtons($("#model-options"), Object.entries(state.capabilities.models), state.model, (id) => {
    state.model = id; renderModel(); updateTriggers();
  });
  const rules = model.generation;
  selectOptions($("#sampler"), rules.samplers.allowed, rules.samplers.default);
  selectOptions($("#scheduler"), rules.schedulers.allowed, rules.schedulers.default);
  for (const [id, rule] of [["steps", rules.steps], ["cfg", rules.cfg]]) {
    const input = $(`#${id}`);
    Object.assign(input, { min: rule.min, max: rule.max, step: rule.step, value: rule.default });
    $(`#${id}-value`).value = rule.default;
  }
  $("#cfg-warning").textContent = rules.cfg.warning;
  renderLoras(model.loras);
}

function renderLoras(loras) {
  $("#lora-options").replaceChildren(...loras.map((lora) => {
    const row = document.createElement("div");
    row.className = "lora-item";
    row.dataset.id = lora.id;
    row.dataset.triggers = JSON.stringify(lora.triggerWords);
    row.innerHTML = `<div class="lora-top">
      <input class="lora-enabled" type="checkbox" id="lora-${lora.id}">
      <label for="lora-${lora.id}">${lora.label}</label>${lora.nsfw ? '<span class="nsfw">성인</span>' : ""}
    </div><div class="range-row hidden">
      <input class="lora-strength" type="range" min="${lora.strength.min}" max="${lora.strength.max}" step="${lora.strength.step}" value="${lora.strength.defaultWhenEnabled}">
      <output>${lora.strength.defaultWhenEnabled}</output>
    </div>`;
    const enabled = row.querySelector(".lora-enabled");
    const range = row.querySelector(".range-row");
    enabled.addEventListener("change", () => {
      const checked = [...document.querySelectorAll(".lora-enabled:checked")];
      if (checked.length > 3) { enabled.checked = false; toast("LoRA는 최대 3개까지 선택할 수 있습니다."); }
      range.classList.toggle("hidden", !enabled.checked);
      updateTriggers();
    });
    row.querySelector(".lora-strength").addEventListener("input", (event) => {
      row.querySelector("output").value = event.target.value;
    });
    return row;
  }));
  updateTriggers();
}

function selectedLoras() {
  return [...document.querySelectorAll(".lora-item")].filter((row) => row.querySelector(".lora-enabled").checked)
    .map((row) => ({ id: row.dataset.id, strength: Number(row.querySelector(".lora-strength").value) }));
}

function updateTriggers() {
  const rows = [...document.querySelectorAll(".lora-item")].filter((row) => row.querySelector(".lora-enabled").checked);
  $("#lora-limit").textContent = `${rows.length} / 3`;
  const triggers = [...new Set(rows.flatMap((row) => JSON.parse(row.dataset.triggers)))];
  const preview = $("#inserted-triggers");
  preview.textContent = triggers.length ? `자동 입력: ${triggers.join(", ")}` : "";
  preview.classList.toggle("hidden", !$("#auto-triggers").checked || triggers.length === 0);
}

function formSpec() {
  return {
    model: state.model, preset: state.preset, positive: $("#positive").value,
    negative: $("#negative").value, seed: $("#seed").value,
    steps: Number($("#steps").value), cfg: Number($("#cfg").value),
    sampler: $("#sampler").value, scheduler: $("#scheduler").value,
    loras: selectedLoras(), autoInsertTriggers: $("#auto-triggers").checked,
    img2img: {
      enabled: $("#i2i-enabled").checked,
      denoise: Number($("#denoise").value),
      fitMode: $("#fit-mode").value
    },
    upscale: $("#upscale").checked,
    outputFormat: $("#output-format").value
  };
}

async function api(path, options) {
  const response = await fetch(path, { credentials: "same-origin", ...options });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error ?? `HTTP ${response.status}`);
  }
  return response;
}

async function load() {
  try {
    const [capabilitiesResponse, quotaResponse, presetsResponse] = await Promise.all([
      api("/api/image/capabilities"),
      api("/api/image/quota"),
      api("/api/image/presets")
    ]);
    state.capabilities = await capabilitiesResponse.json();
    const quota = await quotaResponse.json();
    state.presets = (await presetsResponse.json()).items;
    $("#quota-label").textContent = `오늘 ${quota.dailyUsed} / ${quota.dailyLimit} · 이번 주 ${quota.weeklyUsed} / ${quota.weeklyLimit}`;
    renderPromptPresets();
    renderPresetOptions();
    renderModel();
    $("#gpu-status").className = "status up";
    $("#gpu-status").innerHTML = '<i class="dot"></i>대기열 사용 가능';
  } catch {
    $("#gpu-status").className = "status down";
    $("#gpu-status").innerHTML = '<i class="dot"></i>현재 사용할 수 없음';
    showMessage("서비스 정보를 불러오지 못했습니다. 로그인 상태를 확인하세요.", "err");
  }
}

function renderPromptPresets(selected = "") {
  const select = $("#prompt-preset");
  select.replaceChildren(
    new Option("저장한 프롬프트 불러오기", ""),
    ...state.presets.map((preset) => new Option(preset.name, preset.id))
  );
  select.value = selected;
  $("#delete-preset").disabled = !selected;
}

function applyPreset(spec) {
  state.model = spec.model;
  state.preset = spec.preset;
  renderPresetOptions();
  renderModel();
  for (const id of ["positive", "negative", "seed", "sampler", "scheduler"]) {
    if (spec[id] != null) $(`#${id}`).value = spec[id];
  }
  for (const id of ["steps", "cfg"]) {
    if (spec[id] != null) {
      $(`#${id}`).value = spec[id];
      $(`#${id}-value`).value = spec[id];
    }
  }
  $("#auto-triggers").checked = spec.autoInsertTriggers !== false;
  $("#upscale").checked = spec.upscale === true;
  $("#output-format").value = spec.outputFormat ?? "png";
  for (const choice of spec.loras ?? []) {
    const row = document.querySelector(`.lora-item[data-id="${CSS.escape(choice.id)}"]`);
    if (!row) continue;
    row.querySelector(".lora-enabled").checked = true;
    row.querySelector(".lora-strength").value = choice.strength;
    row.querySelector("output").value = choice.strength;
    row.querySelector(".range-row").classList.remove("hidden");
  }
  updateTriggers();
}

async function savePreset() {
  const name = window.prompt("프롬프트 프리셋 이름", "");
  if (!name) return;
  const spec = { ...formSpec(), img2img: { enabled: false } };
  try {
    const response = await api("/api/image/presets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, spec })
    });
    const saved = await response.json();
    state.presets.unshift({ id: saved.id, name, spec });
    renderPromptPresets(saved.id);
    toast("프롬프트를 저장했습니다.");
  } catch (error) {
    toast(humanError(error.message));
  }
}

function renderPresetOptions() {
  optionButtons($("#preset-options"), Object.entries(state.capabilities.presets), state.preset, (id) => {
    state.preset = id;
    renderPresetOptions();
  });
}

async function submit(event) {
  event.preventDefault();
  const button = $("#submit-button");
  button.disabled = true;
  button.innerHTML = '<span class="spin"></span>추가 중';
  try {
    const spec = formSpec();
    const body = new FormData();
    body.set("spec", JSON.stringify(spec));
    if (spec.img2img.enabled) {
      const file = $("#source-image").files[0];
      if (!file) throw new Error("I2I 원본 이미지를 선택하세요.");
      body.set("image", file);
    }
    const response = await api("/api/image/jobs", { method: "POST", body });
    const job = await response.json();
    state.jobId = job.id;
    $("#empty-result").classList.add("hidden");
    $("#result").classList.add("hidden");
    $("#job-state").classList.remove("hidden");
    $("#job-title").textContent = "대기열에 추가됨";
    $("#job-detail").textContent = `할당량 ${job.cost}장 사용 · 상태 확인 중`;
    await pollJob();
  } catch (error) {
    showMessage(humanError(error.message), "err");
  } finally {
    button.disabled = false;
    button.textContent = "대기열에 추가";
  }
}

async function pollJob() {
  clearTimeout(state.poll);
  try {
    const response = await api(`/api/image/jobs/${state.jobId}`);
    const job = await response.json();
    if (job.status === "queued") {
      $("#job-title").textContent = "대기 중";
      $("#job-detail").textContent = job.position ? `현재 대기 순서 ${job.position}번` : "곧 시작합니다.";
    } else if (job.status === "running") {
      $("#job-title").textContent = "GPU에서 생성 중";
      $("#job-detail").textContent = "창을 닫아도 작업은 계속됩니다.";
    } else if (job.status === "completed") {
      showResult(job);
      return;
    } else if (job.status === "failed") {
      throw new Error("generation_failed");
    }
    state.poll = setTimeout(pollJob, 1800);
  } catch (error) {
    $("#job-state").classList.add("hidden");
    $("#empty-result").classList.remove("hidden");
    showMessage(humanError(error.message), "err");
  }
}

function showResult(job) {
  const src = `/api/image/jobs/${job.id}/result`;
  $("#job-state").classList.add("hidden");
  $("#result").classList.remove("hidden");
  $("#result-image").src = `${src}?v=${encodeURIComponent(job.updatedAt)}`;
  $("#download-result").href = src;
  $("#result-model").textContent = state.capabilities.models[state.model].label;
  const preset = state.capabilities.presets[state.preset];
  $("#result-meta").textContent = `${preset.width} × ${preset.height}${$("#upscale").checked ? " · 2×" : ""}`;
  toast("이미지 생성이 완료되었습니다.");
}

async function setCollection(kind, button) {
  if (!state.jobId) return;
  const enabled = button.dataset.enabled !== "true";
  try {
    await api(`/api/image/jobs/${state.jobId}/${kind}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled })
    });
    button.dataset.enabled = String(enabled);
    button.classList.toggle("done", enabled);
    button.textContent = kind === "saved"
      ? (enabled ? "갤러리 보관됨" : "갤러리 보관")
      : (enabled ? "기록 보관됨" : "기록 보관");
  } catch (error) {
    toast(humanError(error.message));
  }
}

function humanError(code) {
  return ({
    authentication_required: "로그인이 필요합니다.", daily_quota: "오늘 할당량 50장을 모두 사용했습니다.",
    weekly_quota: "이번 주 할당량 250장을 모두 사용했습니다.", queue_limit: "대기 중인 작업이 4개입니다.",
    generation_failed: "이미지 생성에 실패했습니다. 사용한 할당량은 복구됩니다.",
    invalid_request: "설정값을 다시 확인해 주세요."
  })[code] ?? code;
}

function showMessage(text, kind) {
  const element = $("#form-message");
  element.textContent = text; element.className = `msg show ${kind}`;
}
function toast(text) {
  $("#toast").textContent = text; $("#toast").classList.add("on");
  setTimeout(() => $("#toast").classList.remove("on"), 1800);
}

for (const id of ["steps", "cfg", "denoise"]) {
  $(`#${id}`).addEventListener("input", (event) => {
    $(`#${id}-value`).value = event.target.value;
    if (id === "cfg" && state.capabilities) {
      const rule = state.capabilities.models[state.model].generation.cfg;
      $("#cfg-warning").classList.toggle("hidden", Number(event.target.value) <= rule.warnAbove);
    }
  });
}
$("#random-seed").addEventListener("click", () => { $("#seed").value = randomSeed(); });
$("#seed").value = randomSeed();
$("#i2i-enabled").addEventListener("change", (event) => {
  $("#i2i-controls").classList.toggle("hidden", !event.target.checked);
  $("#cost-label").textContent = `할당량 ${event.target.checked ? "1.5" : "1"}장`;
});
$("#auto-triggers").addEventListener("change", updateTriggers);
$("#generation-form").addEventListener("submit", submit);
$("#save-result").addEventListener("click", (event) => setCollection("saved", event.currentTarget));
$("#pin-result").addEventListener("click", (event) => setCollection("pinned", event.currentTarget));
$("#save-preset").addEventListener("click", savePreset);
$("#prompt-preset").addEventListener("change", (event) => {
  const preset = state.presets.find((item) => item.id === event.target.value);
  $("#delete-preset").disabled = !preset;
  if (preset) applyPreset(preset.spec);
});
$("#delete-preset").addEventListener("click", async () => {
  const id = $("#prompt-preset").value;
  if (!id) return;
  try {
    await api(`/api/image/presets/${id}`, { method: "DELETE" });
    state.presets = state.presets.filter((preset) => preset.id !== id);
    renderPromptPresets();
    toast("프롬프트를 삭제했습니다.");
  } catch (error) {
    toast(humanError(error.message));
  }
});
$("#positive").addEventListener("input", (event) => { $("#positive-count").textContent = `약 ${Math.ceil(event.target.value.length / 3)} / 1024 tokens`; });
$("#negative").addEventListener("input", (event) => { $("#negative-count").textContent = `약 ${Math.ceil(event.target.value.length / 3)} / 2048 tokens`; });

await load();
