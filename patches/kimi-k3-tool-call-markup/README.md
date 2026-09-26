# Kimi K3 Tool-Call Markup Patch

Kimi tool-call markup fault-tolerance patch for the `@openclaw/kimi-provider` plugin on
OpenClaw. Originally produced 2026-09-03 against plugin `2026.8.2`; **rebased 2026-09-26
to the installer-only route and runtime-verified against `2026.9.3`** (see Verification).

## Purpose

The stock Kimi K3 stream parser is fragile when Kimi emits tool calls as text markup
instead of clean native `tool_use` blocks. This patch:

- Parses Kimi tool-call markup with per-call fault tolerance instead of dropping a whole
  assistant turn when one call segment is malformed.
- Normalizes tool names such as `functions.exec:3` to `exec` while preserving the raw call
  id for result pairing.
- Strips protocol markup from visible assistant text, including partial streaming
  fragments such as `<|tool_call...`.
- Keeps replayed thinking signatures enabled and rejects empty signatures for Kimi K3
  replay compatibility.
- Provides unit tests and reapply scripts so the patch survives OpenClaw/plugin upgrades.

## What Changed

Runtime changes applied into the installed plugin's `dist/`:

- `tool-call-markup.js` — new parser module for Kimi text tool-call markup.
- `stream.js` — rewired to use `tool-call-markup.js` (three inline legacy functions
  replaced); Kimi K3 `allowEmptySignature` changed from `true` to `false`.
- `replay-policy.js` — `preserveSignatures` changed from `false` to `true`.
- `tool-call-markup.test.mjs` — unit tests for parser behavior (installed alongside).

## Contents

```text
patches/kimi-k3-tool-call-markup/
  README.md
  ops/
    install-kimi-parser-patch.cjs   # idempotent installer: module placement + stream.js wiring + syntax check
    reapply-kimi-patch.ps1          # full post-upgrade reapply: installer + two policy flips + unit tests
    tool-call-markup.js             # parser module source-of-truth (copied into dist by the installer)
    tool-call-markup.test.mjs       # unit tests (self-contained; runs directly from ops/)
  docs/
    design-and-test-plan.md         # 2026-09-03 design archive (root cause, invariants, tests, rollback)
```

> **Removed snapshot (D1, rebase 2026-09-26).** This artifact previously carried a full
> patched plugin copy under `plugin/`, built from `@openclaw/kimi-provider` `2026.8.2`.
> That snapshot has been deleted: its chunk file `provider-catalog-DesMT16v.js` does not
> exist in the `2026.9.x` build (`provider-catalog-CLUjA3y1.js`), so a whole-directory
> copy would downgrade an installed `2026.9.3` plugin. The installer route above is
> version-agnostic (anchor-checked) and is the only supported application path.
> The `2026.8.2` snapshot remains recoverable from git history (commit `efa3459`).
>
> If a directory snapshot is ever needed again, generate it from the currently installed
> plugin instead of hand-editing:
>
> ```powershell
> $stage = "C:\path\to\staging\kimi-current"
> Copy-Item "$env:USERPROFILE\.openclaw\extensions\kimi\dist" "$stage\dist" -Recurse
> Copy-Item "$env:USERPROFILE\.openclaw\extensions\kimi\package.json" "$stage\package.json"
> $env:KIMI_PATCH_DIST = "$stage\dist"
> pwsh -File .\ops\reapply-kimi-patch.ps1
> ```

## Installation

### Installer route (supported)

Use after `openclaw upgrade`, plugin reinstall, or any operation that restores upstream
`dist` files. **Always install the plugin first, reapply the patch second, then restart.**

From the repository root:

```powershell
node .\patches\kimi-k3-tool-call-markup\ops\install-kimi-parser-patch.cjs
pwsh -File .\patches\kimi-k3-tool-call-markup\ops\reapply-kimi-patch.ps1
openclaw gateway restart
```

Both scripts default to `%USERPROFILE%\.openclaw\extensions\kimi\dist`. To patch or
validate a different copy (e.g. staging) without touching production, set
`KIMI_PATCH_DIST` to the target dist directory:

```powershell
$env:KIMI_PATCH_DIST = "C:\path\to\staging\kimi-9.3\dist"
pwsh -File .\patches\kimi-k3-tool-call-markup\ops\reapply-kimi-patch.ps1
```

The installer is idempotent and aborts safely (`anchors not unique`) if upstream rewrites
the parse region. `reapply-kimi-patch.ps1` then flips the two signature-policy settings
(with dated backups) and runs the parser unit tests.

### Option A (deprecated) — whole-directory plugin copy

Was only ever valid on hosts running `@openclaw/kimi-provider` `2026.8.2`. Do **not**
restore it onto `2026.9.x` installs.

## Verification

Parser unit tests: **`34 passed, 0 failed`** — re-run and confirmed on 2026-09-26 (the
2026-09-03 claim, now backed by runtime evidence instead of assertion).

Staged runtime verification on pristine `2026.9.3` (unpatched upstream copy, 2026-09-26):

- `install-kimi-parser-patch.cjs` exits 0: module + test installed, `stream.js` rewired,
  legacy `stripTaggedToolCallCounter` / `parseKimiTaggedToolCalls` /
  `rewriteKimiTaggedToolCallsInMessage` removed from `stream.js`,
  `transformKimiStreamEvent` retained.
- Post-reapply `stream.js` contains `allowEmptySignature: false`; `replay-policy.js`
  contains `preserveSignatures: true`.
- `node --check` passes on patched `stream.js` and `tool-call-markup.js`.
- Idempotency: second installer + reapply run are no-ops (`stream.js` byte-identical,
  single import, exit 0).

Additional checks against a live install:

```powershell
$dist = Join-Path $env:USERPROFILE '.openclaw\extensions\kimi\dist'
Select-String -Path (Join-Path $dist 'stream.js') -Pattern './tool-call-markup.js'
Select-String -Path (Join-Path $dist 'stream.js') -Pattern 'allowEmptySignature: false'
Select-String -Path (Join-Path $dist 'replay-policy.js') -Pattern 'preserveSignatures: true'
```

Runtime acceptance criteria (original, unchanged):

- Kimi K3 tool calls execute instead of disappearing when one tagged call segment is malformed.
- Assistant-visible output does not leak `<|tool_call_begin|>`,
  `<|tool_call_argument_begin|>`, or related protocol markers.
- Multi-turn thinking/tool-call loops do not fail with empty-signature replay errors.
- Gateway logs do not show repeated same-name tool-call retry loops caused by parser loss.

## Rollback

Restore the backups created during patching, or reinstall the official plugin:

```powershell
openclaw plugins install @openclaw/kimi-provider
openclaw gateway restart
```

Backup files created by the scripts:

```text
<dist>\stream.js.bak.pre31                     # installer
<dist>\stream.js.bak.YYYYMMDD                  # reapply (allowEmptySignature flip)
<dist>\replay-policy.js.bak.YYYYMMDD           # reapply (preserveSignatures flip)
```

## Security Notes

- This package does not include Kimi API keys.
- Runtime authentication still requires the normal OpenClaw Kimi provider setup, typically
  `KIMI_API_KEY` or `KIMICODE_API_KEY`.
- Review `ops/tool-call-markup.js` and `ops/install-kimi-parser-patch.cjs` before using
  this patch on another machine.

## Compatibility

- OpenClaw host: `>=2026.6.8`
- Plugin API: `>=2026.8.2`
- Base plugin: patch authored on `@openclaw/kimi-provider` `2026.8.2`;
  **installer route anchor-verified and staged against `2026.9.3` (2026-09-26)**.
  Re-run the staged verification after any plugin upgrade — the installer aborts with a
  clear message if its anchors are no longer unique.
- Model path: Kimi K3 through the Kimi coding provider

## Status

Rebased to installer-only route on branch `kimi-patch-rebase-2026-09` (2026-09-26).
Note: on this host, production `~\.openclaw\extensions\kimi` is currently **`2026.9.3`
unpatched** (patch lost to the 2026-09-09 reinstall); applying the reapply route + gateway
restart is a separate, approval-gated operation. Upstream PR still pending; see
`docs/design-and-test-plan.md` for the original evidence chain.
