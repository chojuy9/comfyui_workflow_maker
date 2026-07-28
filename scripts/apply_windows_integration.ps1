param(
  [string]$AuthRoot = "C:\Project\chatos-auth",
  [string]$SiteRoot = "C:\Project\litellm"
)

$ErrorActionPreference = "Stop"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Write-Utf8NoBom([string]$Path, [string]$Text) {
  [IO.File]::WriteAllText($Path, $Text.Replace("`r`n", "`n"), $utf8NoBom)
}
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$auth = (Resolve-Path -LiteralPath $AuthRoot).Path
$site = (Resolve-Path -LiteralPath $SiteRoot).Path

if (-not (Test-Path -LiteralPath (Join-Path $auth "worker.js"))) {
  throw "worker.js not found in $auth"
}
if (-not (Test-Path -LiteralPath (Join-Path $auth "wrangler.toml"))) {
  throw "wrangler.toml not found in $auth"
}
if (-not (Test-Path -LiteralPath (Join-Path $site "style.css"))) {
  throw "style.css not found in $site"
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backup = Join-Path $projectRoot "integration-backup\$stamp"
New-Item -ItemType Directory -Path (Join-Path $backup "chatos-auth") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $backup "litellm") -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $auth "worker.js") -Destination (Join-Path $backup "chatos-auth\worker.js")
Copy-Item -LiteralPath (Join-Path $auth "wrangler.toml") -Destination (Join-Path $backup "chatos-auth\wrangler.toml")
Get-ChildItem -LiteralPath $site -Filter "*.html" | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $backup "litellm\$($_.Name)")
}

New-Item -ItemType Directory -Path (Join-Path $auth "src") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $auth "config") -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot "src\workflow-compiler.mjs") -Destination (Join-Path $auth "src\workflow-compiler.mjs") -Force
Copy-Item -LiteralPath (Join-Path $projectRoot "config\generation-policy.json") -Destination (Join-Path $auth "config\generation-policy.json") -Force
Copy-Item -LiteralPath (Join-Path $projectRoot "config\lora-registry.json") -Destination (Join-Path $auth "config\lora-registry.json") -Force
Copy-Item -LiteralPath (Join-Path $projectRoot "config\service-policy.json") -Destination (Join-Path $auth "config\service-policy.json") -Force
Copy-Item -LiteralPath (Join-Path $projectRoot "integrations\chatos-auth\image-durable-objects.js") -Destination (Join-Path $auth "image-durable-objects.js") -Force
if (-not (Test-Path -LiteralPath (Join-Path $auth "package.json"))) {
  Copy-Item -LiteralPath (Join-Path $projectRoot "integrations\chatos-auth\package.json") -Destination (Join-Path $auth "package.json")
} else {
  $packageText = [IO.File]::ReadAllText((Join-Path $auth "package.json"), [Text.Encoding]::UTF8)
  if ($packageText.Contains('"name": "chatos-auth-worker"')) {
    Copy-Item -LiteralPath (Join-Path $projectRoot "integrations\chatos-auth\package.json") -Destination (Join-Path $auth "package.json") -Force
  }
}

$imageApi = Get-Content -Raw -Encoding UTF8 (Join-Path $projectRoot "integrations\chatos-auth\image-api.js")
$imageApi = $imageApi.Replace('../../src/workflow-compiler.mjs', './src/workflow-compiler.mjs')
Write-Utf8NoBom (Join-Path $auth "image-api.js") $imageApi

$workerPath = Join-Path $auth "worker.js"
$worker = Get-Content -Raw -Encoding UTF8 $workerPath
$worker = $worker.Replace("  async fetch(req, env) {", "  async fetch(req, env, ctx) {")
$importMarker = 'import { ImageQueue, ImageQuota } from "./image-durable-objects.js";'
if (-not $worker.Contains($importMarker)) {
  $imports = @'
import { ImageQueue, ImageQuota } from "./image-durable-objects.js";
import { cleanupImageRetention, getImageAdminStatus, handleImageApi } from "./image-api.js";
export { ImageQueue, ImageQuota };

'@
  $worker = $imports + $worker
}

$adminNeedle = "  if (action === 'queue') {"
if (-not $worker.Contains("action === 'image'")) {
  $adminBlock = @"
  if (action === 'image') {
    return json({ ok: true, ...(await getImageAdminStatus(env)) });
  }

"@
  $worker = $worker.Replace($adminNeedle, $adminBlock + "`n" + $adminNeedle)
}

$routeNeedle = "      if (p.startsWith('/api/admin/')) return await handleAdmin(req, env, url);"
if (-not $worker.Contains("p.startsWith('/api/image/')")) {
  $routeBlock = @"
      if (p.startsWith('/api/image/')) {
        const session = await sessionAccount(env, req);
        const account = session?.acct?.verified && !session.acct.blocked ? session.acct : null;
        return await handleImageApi(req, env, ctx, account);
      }
"@
  $worker = $worker.Replace($routeNeedle, $routeBlock + "`n" + $routeNeedle)
}
$worker = $worker.Replace(
  "      }      if (p.startsWith('/api/admin/'))",
  "      }`n      if (p.startsWith('/api/admin/'))"
)

if (-not $worker.Contains("image_cleanup_failed")) {
  $scheduleNeedle = "  async scheduled(event, env, ctx) {"
  $scheduleBlock = @"
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      cleanupImageRetention(env).catch((error) =>
        console.error(JSON.stringify({ event: 'image_cleanup_failed', error: error.name }))
      )
    );
"@
  $worker = $worker.Replace($scheduleNeedle, $scheduleBlock)
}
Write-Utf8NoBom $workerPath $worker

$wranglerPath = Join-Path $auth "wrangler.toml"
$wrangler = Get-Content -Raw -Encoding UTF8 $wranglerPath
if (-not $wrangler.Contains("nodejs_compat")) {
  $wrangler = $wrangler.Replace(
    'compatibility_date = "2026-07-01"',
    "compatibility_date = `"2026-07-27`"`r`ncompatibility_flags = [`"nodejs_compat`"]"
  )
}
if (-not $wrangler.Contains("IMAGE_MODERATION_MODE")) {
  $wrangler = $wrangler.Replace(
    "[vars]",
    "[vars]`r`nENVIRONMENT = `"production`"`r`nIMAGE_MODERATION_MODE = `"enforce`""
  )
}
if (-not $wrangler.Contains("binding = `"CHATOS_IMAGES`"")) {
  $wrangler += @'

# --- chatos image service -----------------------------------------------------
[[r2_buckets]]
binding = "CHATOS_IMAGES"
bucket_name = "chatos-images"
preview_bucket_name = "chatos-images-preview"

[durable_objects]
bindings = [
  { name = "IMAGE_QUEUE", class_name = "ImageQueue" },
  { name = "IMAGE_QUOTA", class_name = "ImageQuota" }
]

[[migrations]]
tag = "image-v1"
new_sqlite_classes = ["ImageQueue", "ImageQuota"]

# Create chatos-image-moderation first, then uncomment this binding.
# Production submissions fail closed while the binding is absent.
# [[services]]
# binding = "IMAGE_MODERATION"
# service = "chatos-image-moderation"
'@
}
Write-Utf8NoBom $wranglerPath $wrangler

foreach ($name in @("image.html", "image.css", "image.js")) {
  Copy-Item -LiteralPath (Join-Path $projectRoot "integrations\litellm\$name") -Destination (Join-Path $site $name) -Force
}

Get-ChildItem -LiteralPath $site -Filter "*.html" |
  Where-Object { $_.Name -ne "image.html" } |
  ForEach-Object {
    $html = Get-Content -Raw -Encoding UTF8 $_.FullName
    if (-not $html.Contains('href="/image.html"')) {
      $html = $html.Replace(
        '<a href="/models.html">',
        '<a href="/image.html">&#51060;&#48120;&#51648;</a>' + "`r`n      " + '<a href="/models.html">'
      )
      $html = $html.Replace(
        '<a href="/models.html" class="on">',
        '<a href="/image.html">&#51060;&#48120;&#51648;</a>' + "`r`n      " + '<a href="/models.html" class="on">'
      )
    }
    $html = [regex]::Replace(
      $html,
      '<a href="/image\.html">[^<]*</a>',
      '<a href="/image.html">&#51060;&#48120;&#51648;</a>'
    )
    Write-Utf8NoBom $_.FullName $html
  }

$adminPath = Join-Path $site "admin.html"
$adminHtml = [IO.File]::ReadAllText($adminPath, [Text.Encoding]::UTF8)
if (-not $adminHtml.Contains('id="imageGpu"')) {
  $imageCard = @'
    <!-- image GPU -->
    <div class="card">
      <div class="cardhead">
        <h3>&#51060;&#48120;&#51648; GPU</h3>
        <span class="status" id="imageGpu"><span class="dot"></span><span id="imageGpuText">&#54869;&#51064; &#51204;</span></span>
      </div>
      <div class="kv"><span>&#45824;&#44592;</span><span id="imageQueued">—</span></div>
      <div class="kv"><span>&#49892;&#54665;</span><span id="imageRunning">—</span></div>
      <div class="kv"><span>Last poll</span><span id="imageLastSeen">—</span></div>
    </div>

'@
  $adminHtml = $adminHtml.Replace('    <!-- 모델별 할당량 -->', $imageCard + "`n    <!-- 모델별 할당량 -->")
  $adminHtml = $adminHtml.Replace(
    'async function loadAll() { await Promise.all([loadQueue(), loadAccts()]); }',
    'async function loadAll() { await Promise.all([loadQueue(), loadAccts(), loadImageStatus()]); }'
  )
  $adminHtml = $adminHtml.Replace(
    '  loadQueue();',
    "  loadQueue();`n  loadImageStatus();"
  )
  $imageFunction = @'
async function loadImageStatus() {
  const r = await api('/api/admin/image');
  const box = $('imageGpu');
  if (!r.ok) {
    box.className = 'status down';
    $('imageGpuText').textContent = '\uD655\uC778 \uC2E4\uD328';
    return;
  }
  box.className = r.gpuOnline ? 'status up' : 'status down';
  $('imageGpuText').textContent = r.gpuOnline ? '\uC628\uB77C\uC778' : '\uC624\uD504\uB77C\uC778';
  $('imageQueued').textContent = (r.counts && r.counts.queued) || 0;
  $('imageRunning').textContent = (r.counts && r.counts.running) || 0;
  $('imageLastSeen').textContent = r.gpuLastSeenAt ? when(r.gpuLastSeenAt) : '\uC5C6\uC74C';
}

'@
  $adminHtml = $adminHtml.Replace('async function enforce() {', $imageFunction + "`nasync function enforce() {")
  Write-Utf8NoBom $adminPath $adminHtml
}

$usagePath = Join-Path $site "usage.html"
$usageHtml = [IO.File]::ReadAllText($usagePath, [Text.Encoding]::UTF8)
if (-not $usageHtml.Contains('id="imageDaily"')) {
  $imageQuotaCard = @'
  <!-- image quota -->
  <div class="card">
    <div class="cardhead"><h3>&#51060;&#48120;&#51648; &#49373;&#49457;</h3><em>T2I 1&#51109; · I2I 1.5&#51109;</em></div>
    <div class="kv"><span>&#50724;&#45720;</span><span id="imageDaily">— / 50&#51109;</span></div>
    <div class="bar"><i id="imageDailyBar" style="width:0%"></i></div>
    <div class="kv"><span>&#51060;&#48264; &#51452;</span><span id="imageWeekly">— / 250&#51109;</span></div>
    <div class="bar"><i id="imageWeeklyBar" style="width:0%"></i></div>
    <div class="meta"><span id="imageQueue">&#45824;&#44592; — · &#49892;&#54665; —</span><a class="link" href="/image.html">&#51060;&#48120;&#51648; &#49373;&#49457;</a></div>
  </div>

'@
  $usageHtml = $usageHtml.Replace('  <!-- 모델별 -->', $imageQuotaCard + "`n  <!-- 모델별 -->")
  $paintImage = @'
function paintImage(q) {
  const dailyPct = Math.min(100, (q.dailyUsed / q.dailyLimit) * 100);
  const weeklyPct = Math.min(100, (q.weeklyUsed / q.weeklyLimit) * 100);
  $('imageDaily').textContent = q.dailyUsed + ' / ' + q.dailyLimit + '\uC7A5';
  $('imageWeekly').textContent = q.weeklyUsed + ' / ' + q.weeklyLimit + '\uC7A5';
  $('imageDailyBar').style.width = dailyPct + '%';
  $('imageDailyBar').style.background = color(dailyPct);
  $('imageWeeklyBar').style.width = weeklyPct + '%';
  $('imageWeeklyBar').style.background = color(weeklyPct);
  $('imageQueue').textContent = '\uB300\uAE30 ' + q.queued + ' · \uC2E4\uD589 ' + q.running;
}

'@
  $usageHtml = $usageHtml.Replace('async function load(manual) {', $paintImage + "`nasync function load(manual) {")
  $usageHtml = $usageHtml.Replace(
    "  const u = await api('/api/usage');",
    "  const results = await Promise.all([api('/api/usage'), api('/api/image/quota')]);`n  const u = results[0];`n  paintImage(results[1]);"
  )
  Write-Utf8NoBom $usagePath $usageHtml
}

Write-Host "Integrated image service."
Write-Host "Backup: $backup"
Write-Host "Next: create R2 buckets, create moderation service, set IMAGE_GATEWAY_TOKEN, run wrangler types/test."
