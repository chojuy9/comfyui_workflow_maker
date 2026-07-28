# 히스토리를 새로 시작합니다 (윈도우)
#
#   .\reset-history.ps1
#
# 지금까지의 커밋을 전부 버리고 현재 상태로 커밋 하나만 남깁니다.
# 공개 저장소에 올라간 과거 커밋에서 내부 문서를 꺼내볼 수 없게 하려는 것입니다.
#
# 되돌릴 수 없습니다. 커밋 이력이 사라집니다.

# git 은 경고를 stderr 로 뱉습니다. Stop 으로 두면 경고에도 멈춰버려요.
$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot

$remote = & git config --get remote.origin.url 2>$null
if (-not $remote) {
  Write-Host "remote 가 없습니다. 먼저 origin 을 설정하세요." -ForegroundColor Red
  exit 1
}

$count = & git rev-list --count HEAD 2>$null

Write-Host ""
Write-Host "저장소     : $remote"
Write-Host "현재 커밋 수 : $count"
Write-Host ""
Write-Host "이 커밋들을 전부 버리고, 지금 상태로 커밋 하나만 남깁니다." -ForegroundColor Yellow
Write-Host "과거 이력은 되돌릴 수 없습니다." -ForegroundColor Yellow
Write-Host ""

$answer = Read-Host "계속할까요? (yes 를 입력하세요)"
if ($answer -ne "yes") {
  Write-Host "취소했습니다."
  exit 0
}

Write-Host ""
Write-Host "== 새 커밋에서 제외될 파일 =="
& git status --ignored --porcelain 2>$null |
  Where-Object { $_ -like '!!*' } |
  ForEach-Object { Write-Host ("  " + $_.Substring(3)) }

Remove-Item -Recurse -Force .git
& git init -b main | Out-Null
& git remote add origin $remote

$shellFiles = @()
$shellFiles += Get-ChildItem -Path scripts -Filter *.sh -ErrorAction SilentlyContinue
$shellFiles += Get-ChildItem -Path go.sh -ErrorAction SilentlyContinue
$shellFiles += Get-ChildItem -Path gateway/entrypoint.sh -ErrorAction SilentlyContinue

& git add -A 2>&1 | Out-Null
foreach ($f in $shellFiles) {
  $rel = (Resolve-Path -Relative $f.FullName) -replace '^\.\\', '' -replace '\\', '/'
  & git update-index --chmod=+x $rel 2>&1 | Out-Null
}

& git commit -m "chatos image generation package"
if ($LASTEXITCODE -ne 0) {
  Write-Host "커밋에 실패했습니다." -ForegroundColor Red
  exit 1
}

& git push --force -u origin main
if ($LASTEXITCODE -ne 0) {
  Write-Host "푸시에 실패했습니다." -ForegroundColor Red
  exit 1
}

Write-Host ""
Write-Host "== 올라간 파일 =="
& git ls-files | ForEach-Object { Write-Host "  $_" }
Write-Host ""
Write-Host "히스토리를 새로 시작했습니다." -ForegroundColor Cyan
Write-Host "GitHub 에서 커밋이 하나인지, 내부 문서가 안 보이는지 확인하세요."
Write-Host ""
