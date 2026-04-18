# OpenClaw Patches

This repository contains patches and hotfixes for OpenClaw that haven't been upstreamed yet.

## Patch List

### memory-wiki-cli-slot-loading.patch

**Issue**: `openclaw wiki status/doctor` shows misleading warning "Bridge: enabled (0 exported artifacts)" when memory plugin is working correctly.

**Root Cause**: 
- Wiki CLI commands only activate `memory-wiki` plugin
- Don't preload the currently selected memory slot plugin (`memory-lancedb-pro` or `memory-core`)
- `listActiveMemoryPublicArtifacts()` returns empty results because memory capability is not registered

**Fix**:
- Add helper `ensureActiveMemoryPluginLoaded()` that preloads the selected memory slot
- Call it before reading artifacts in `syncMemoryWikiBridgeSources()` and `resolveMemoryWikiStatus()`

**Files affected**:
- `extensions/memory-wiki/src/cli.ts`

**Verification**:
```bash
# Before fix
$ openclaw wiki status
Bridge: enabled (0 exported artifacts)  # WRONG

# After fix
$ openclaw wiki status
Bridge: enabled (88 exported artifacts)  # CORRECT
```

**Status**: Hot-patched in installed OpenClaw (2026-04-19)

**Upstream**: Pending - needs PR to openclaw repository

## How to Apply Patches

```bash
# Apply to OpenClaw source
cd openclaw
git apply /path/to/patches/memory-wiki-cli-slot-loading.patch

# Or patch installed OpenClaw directly
cd /usr/lib/node_modules/openclaw/dist
patch -p1 < /path/to/patches/memory-wiki-cli-slot-loading.patch
```

## Related Learnings

- LRN-20260418-001: Memory-wiki CLI can misreport bridge artifacts when command activation only loads memory-wiki and not the selected memory slot plugin
