# Kimi K3 Tool-Call Markup Patch

Local patched copy of `@openclaw/kimi-provider` `2026.8.2` for OpenClaw.

This patch was produced on 2026-09-03 from the locally modified plugin at:

```text
%USERPROFILE%\.openclaw\extensions\kimi
```

## Purpose

The stock Kimi K3 stream parser is fragile when Kimi emits tool calls as text markup instead of clean native `tool_use` blocks. This patched copy is intended to:

- Parse Kimi tool-call markup with per-call fault tolerance instead of dropping a whole assistant turn when one call segment is malformed.
- Normalize tool names such as `functions.exec:3` to `exec` while preserving the raw call id for result pairing.
- Strip protocol markup from visible assistant text, including partial streaming fragments such as `<|tool_call...`.
- Keep replayed thinking signatures enabled and reject empty signatures for Kimi K3 replay compatibility.
- Provide unit tests and reapply scripts so the patch can survive OpenClaw/plugin upgrades.

## What Changed

Primary changes are in `plugin/dist/`:

- `tool-call-markup.js` — new parser module for Kimi text tool-call markup.
- `tool-call-markup.test.mjs` — unit tests for parser behavior.
- `stream.js` — rewired to use `tool-call-markup.js`; Kimi K3 `allowEmptySignature` changed from `true` to `false`.
- `replay-policy.js` — `preserveSignatures` changed from `false` to `true`.

Support files:

- `docs/design-and-test-plan.md` — root-cause analysis, invariants, test matrix, rollback plan.
- `ops/install-kimi-parser-patch.cjs` — idempotent installer for the parser module and `stream.js` wiring.
- `ops/reapply-kimi-patch.ps1` — reapplies the full local patch after OpenClaw/plugin upgrades.

## Contents

```text
plugin/
  package.json
  openclaw.plugin.json
  README.md
  dist/
    api.js
    index.js
    onboard.js
    provider-catalog-DesMT16v.js
    provider-catalog.js
    provider-policy-api.js
    replay-policy.js
    stream.js
    tool-call-markup.js
    tool-call-markup.test.mjs
ops/
  install-kimi-parser-patch.cjs
  reapply-kimi-patch.ps1
docs/
  design-and-test-plan.md
```

## Installation

### Option A — install the patched plugin copy

Use this when you want to replace the currently installed Kimi provider plugin with the exact patched copy from this repository.

From this directory on Windows:

```powershell
$src = Join-Path (Get-Location) 'plugin'
$dst = Join-Path $env:USERPROFILE '.openclaw\extensions\kimi'

if (-not (Test-Path $dst)) {
  throw "Kimi plugin is not installed at $dst"
}

Copy-Item (Join-Path $src '*') $dst -Recurse -Force
node (Join-Path $dst 'dist\tool-call-markup.test.mjs')
openclaw gateway restart
```

Do not delete the existing `node_modules` directory. The patched copy only replaces plugin metadata and `dist/` runtime files.

### Option B — reapply the patch after an upgrade

Use this after `openclaw upgrade`, plugin reinstall, or any operation that restores upstream `dist` files.

From the repository root:

```powershell
node .\kimi-k3-tool-call-markup\ops\install-kimi-parser-patch.cjs
pwsh -File .\kimi-k3-tool-call-markup\ops\reapply-kimi-patch.ps1
openclaw gateway restart
```

`reapply-kimi-patch.ps1` performs the parser installation, flips the two signature-policy settings, and runs the parser unit tests.

## Verification

Expected parser test result:

```text
34 passed, 0 failed
```

Additional checks:

```powershell
$dist = Join-Path $env:USERPROFILE '.openclaw\extensions\kimi\dist'
Select-String -Path (Join-Path $dist 'stream.js') -Pattern './tool-call-markup.js'
Select-String -Path (Join-Path $dist 'stream.js') -Pattern 'allowEmptySignature: false'
Select-String -Path (Join-Path $dist 'replay-policy.js') -Pattern 'preserveSignatures: true'
```

Runtime acceptance criteria:

- Kimi K3 tool calls execute instead of disappearing when one tagged call segment is malformed.
- Assistant-visible output does not leak `<|tool_call_begin|>`, `<|tool_call_argument_begin|>`, or related protocol markers.
- Multi-turn thinking/tool-call loops do not fail with empty-signature replay errors.
- Gateway logs do not show repeated same-name tool-call retry loops caused by parser loss.

## Rollback

Restore the backups created during local patching, or reinstall the official plugin:

```powershell
openclaw plugins install @openclaw/kimi-provider
openclaw gateway restart
```

If restoring from backups manually, look for files such as:

```text
%USERPROFILE%\.openclaw\extensions\kimi\dist\stream.js.bak.20260903
%USERPROFILE%\.openclaw\extensions\kimi\dist\stream.js.bak.pre31
%USERPROFILE%\.openclaw\extensions\kimi\dist\replay-policy.js.bak.20260903
```

## Security Notes

- This package does not include Kimi API keys.
- Runtime authentication still requires the normal OpenClaw Kimi provider setup, typically `KIMI_API_KEY` or `KIMICODE_API_KEY`.
- Review `plugin/dist/stream.js` and `plugin/dist/tool-call-markup.js` before using this patch outside the original machine.

## Compatibility

- OpenClaw host: `>=2026.6.8`
- Plugin API: `>=2026.8.2`
- Base plugin: `@openclaw/kimi-provider` `2026.8.2`
- Model path: Kimi K3 through the Kimi coding provider

## Status

Local patch published for backup/reuse. Upstream PR is still pending; see `docs/design-and-test-plan.md` for the evidence chain and acceptance criteria.
