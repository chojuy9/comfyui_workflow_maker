# 원터치 푸시 (윈도우)
#
#   .\push.ps1
#   .\push.ps1 "커밋 메시지"
#
# 변경사항을 전부 커밋하고 밀어 올립니다.
# 셸 스크립트의 실행 권한 비트도 같이 맞춰서, 인스턴스에서 chmod 때문에
# pull 이 막히는 일이 안 생기게 합니다.

param([string]$Message = "")

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

# 셸 스크립트는 실행 가능해야 합니다. 윈도우에서 만들면 비트가 안 붙어요.
$shellFiles = @()
$shellFiles += Get-ChildItem -Path scripts -Filter *.sh -ErrorAction SilentlyContinue
$shellFiles += Get-ChildItem -Path go.sh -ErrorAction SilentlyContinue
$shellFiles += Get-ChildItem -Path gateway/entrypoint.sh -ErrorAction SilentlyContinue

foreach ($f in $shellFiles) {
  $rel = (Resolve-Path -Relative $f.FullName) -replace '^\.\\', '' -replace '\\', '/'
  git update-index --chmod=+x $rel 2>$null | Out-Null
}

git add -A

$staged = git diff --cached --name-only
if (-not $staged) {
  Write-Host "바뀐 게 없습니다."
  exit 0
}

Write-Host ""
Write-Host "== 올릴 파일 =="
$staged | ForEach-Object { Write-Host "  $_" }

if (-not $Message) {
  $Message = "update " + (Get-Date -Format 'yyyy-MM-dd HH:mm')
}

git commit -m $Message
git push

Write-Host ""
Write-Host "올렸습니다. 인스턴스에서는 chatos 를 치세요." -ForegroundColor Cyan
Write-Host ""
