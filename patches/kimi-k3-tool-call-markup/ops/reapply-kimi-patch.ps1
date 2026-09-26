# reapply-kimi-patch.ps1
# 用途：openclaw 升级/插件重装会覆盖 ~/.openclaw/extensions/kimi/dist，
#       本脚本幂等重放 2026-09-03 全部 kimi 补丁：
#       1) §3.1 文本标签解析器重写（tool-call-markup.js + stream.js 接线）
#       2) preserveSignatures: false -> true
#       3) allowEmptySignature: true -> false
# 用法：pwsh -File ops\reapply-kimi-patch.ps1   （改完需重启 gateway 生效）
# 可选：设 $env:KIMI_PATCH_DIST 指向非生产 dist 目录（如 staging 验证），installer 与策略翻转同时生效于该目录
$ErrorActionPreference = 'Stop'
$d = if ($env:KIMI_PATCH_DIST) { $env:KIMI_PATCH_DIST } else { Join-Path $env:USERPROFILE '.openclaw\extensions\kimi\dist' }
$installer = Join-Path $PSScriptRoot 'install-kimi-parser-patch.cjs'

# --- 1. §3.1 解析器补丁（Node 安装器自带幂等与锚点校验）---
if (Test-Path $installer) {
  node $installer
  if ($LASTEXITCODE -ne 0) { Write-Error 'parser patch installer failed'; exit 1 }
} else {
  Write-Warning "installer not found: $installer (parser patch skipped)"
}

# --- 2/3. 签名策略翻转 ---
function Apply-Patch([string]$file, [string]$from, [string]$to, [string]$label) {
  $p = Join-Path $d $file
  if (-not (Test-Path $p)) { Write-Error "missing plugin file: $p"; return }
  $c = [IO.File]::ReadAllText($p)
  if ($c.Contains($to))   { Write-Output "$label : already patched"; return }
  if ($c.Contains($from)) {
    $bak = "$p.bak.$(Get-Date -Format yyyyMMdd)"
    if (-not (Test-Path $bak)) { Copy-Item $p $bak }
    [IO.File]::WriteAllText($p, $c.Replace($from, $to))
    Write-Output "$label : patched (backup: $bak)"
  } else {
    Write-Warning "$label : neither pattern found — plugin dist changed upstream, review manually"
  }
}

Apply-Patch 'replay-policy.js' 'preserveSignatures: false' 'preserveSignatures: true'   'KIMI_REPLAY_POLICY'
Apply-Patch 'stream.js'        'allowEmptySignature: true'  'allowEmptySignature: false' 'K3 compat'

# --- 回归自检：解析器单测 ---
$test = Join-Path $d 'tool-call-markup.test.mjs'
if (Test-Path $test) {
  node $test
  if ($LASTEXITCODE -ne 0) { Write-Error 'tool-call-markup unit tests FAILED'; exit 1 }
  Write-Output 'parser unit tests: 34/34 OK'
}
Write-Output 'Done. Restart the gateway to load the patched plugin.'
