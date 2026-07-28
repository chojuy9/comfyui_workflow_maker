# 원터치 푸시 (윈도우)
#
#   .\push.ps1
#   .\push.ps1 "커밋 메시지"
#
# 변경사항을 전부 커밋하고 밀어 올립니다.
# 셸 스크립트의 실행 권한 비트도 같이 맞춰서, 인스턴스에서 chmod 때문에
# pull 이 막히는 일이 안 생기게 합니다.

param([string]$Message = "")

# git 은 경고를 stderr 로 뱉습니다. ErrorActionPreference 를 Stop 으로 두면
# PowerShell 이 그 경고를 오류로 보고 멈춰버려요. 종료 코드로 판단합니다.
$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot

# git 은 반드시 & 로 직접 부릅니다. 함수로 감싸면 PowerShell 이 -A 같은 인자를
# 그 함수의 매개변수 이름으로 읽어버려서, git 에는 아무것도 안 넘어갑니다.

# 셸 스크립트는 실행 가능해야 합니다. 윈도우에서 만들면 비트가 안 붙어요.
$shellFiles = @()
$shellFiles += Get-ChildItem -Path scripts -Filter *.sh -ErrorAction SilentlyContinue
$shellFiles += Get-ChildItem -Path go.sh -ErrorAction SilentlyContinue
$shellFiles += Get-ChildItem -Path gateway/entrypoint.sh -ErrorAction SilentlyContinue

foreach ($f in $shellFiles) {
  $rel = (Resolve-Path -Relative $f.FullName) -replace '^\.\\', '' -replace '\\', '/'
  & git update-index --chmod=+x $rel 2>&1 | Out-Null
}

& git add -A 2>&1 | Out-Null

$staged = & git diff --cached --name-only 2>$null
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

& git commit -m $Message
if ($LASTEXITCODE -ne 0) {
  Write-Host "커밋에 실패했습니다." -ForegroundColor Red
  exit 1
}

& git push
if ($LASTEXITCODE -ne 0) {
  Write-Host "푸시에 실패했습니다." -ForegroundColor Red
  exit 1
}

Write-Host ""
Write-Host "올렸습니다. 인스턴스에서는 chatos 를 치세요." -ForegroundColor Cyan
Write-Host ""
