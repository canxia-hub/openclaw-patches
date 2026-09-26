// 安装 §3.1 解析器补丁到 kimi 插件 dist（幂等）
const fs = require("fs");
const path = require("path");

// KIMI_PATCH_DIST 可覆盖补丁目标（用于 staging 验证/离线实例）；缺省仍为生产安装路径
const DIST = process.env.KIMI_PATCH_DIST
  ? path.resolve(process.env.KIMI_PATCH_DIST)
  : path.join(process.env.USERPROFILE || process.env.HOME, ".openclaw", "extensions", "kimi", "dist");
const SRC_MODULE = path.join(__dirname, "tool-call-markup.js");
const SRC_TEST = path.join(__dirname, "tool-call-markup.test.mjs");
const MOD_DEST = path.join(DIST, "tool-call-markup.js");
const TEST_DEST = path.join(DIST, "tool-call-markup.test.mjs");
const STREAM = path.join(DIST, "stream.js");

function log(msg) { console.log("[patch] " + msg); }

if (!fs.existsSync(STREAM)) { console.error("[patch] stream.js not found:", STREAM); process.exit(1); }

// 1. 模块与测试文件落位（内容相同则跳过）
for (const [src, dest] of [[SRC_MODULE, MOD_DEST], [SRC_TEST, TEST_DEST]]) {
  const content = fs.readFileSync(src, "utf8");
  if (fs.existsSync(dest) && fs.readFileSync(dest, "utf8") === content) { log(`unchanged: ${path.basename(dest)}`); continue; }
  fs.writeFileSync(dest, content);
  log(`installed: ${path.basename(dest)}`);
}

// 2. stream.js 接线
let s = fs.readFileSync(STREAM, "utf8");
if (s.includes("./tool-call-markup.js")) {
  log("stream.js already wired");
} else {
  const countOccurrences = (hay, needle) => hay.split(needle).length - 1;
  const ANCHOR_A = "function stripTaggedToolCallCounter(value) {";
  const ANCHOR_B = "function transformKimiStreamEvent(value, transformMessage) {";
  if (countOccurrences(s, ANCHOR_A) !== 1 || countOccurrences(s, ANCHOR_B) !== 1) {
    console.error("[patch] anchors not unique — aborting (dist changed upstream?)");
    process.exit(1);
  }
  const ia = s.indexOf(ANCHOR_A);
  const ib = s.indexOf(ANCHOR_B);
  if (ib <= ia) { console.error("[patch] anchor order wrong — aborting"); process.exit(1); }
  const bak = STREAM + ".bak.pre31";
  if (!fs.existsSync(bak)) fs.writeFileSync(bak, s);
  s = s.slice(0, ia) + "// §3.1 重写：旧版 stripTaggedToolCallCounter / parseKimiTaggedToolCalls /\n// rewriteKimiTaggedToolCallsInMessage 已移至 ./tool-call-markup.js（容错+归一+防泄漏）。\n" + s.slice(ib);
  // import 接线（放在最后一行 import 之后）
  const lines = s.split("\n");
  let lastImport = -1;
  for (let i = 0; i < lines.length; i++) if (lines[i].startsWith("import ")) lastImport = i;
  if (lastImport < 0) { console.error("[patch] no import lines found — aborting"); process.exit(1); }
  lines.splice(lastImport + 1, 0, `import { rewriteKimiTaggedToolCallsInMessage } from "./tool-call-markup.js";`);
  s = lines.join("\n");
  // 旧版硬编码偏移常量注释掉保留参考
  fs.writeFileSync(STREAM, s);
  log("stream.js rewired (backup: stream.js.bak.pre31)");
}

// 3. 语法校验
try {
  // ESM 校验：动态 import（Node >= 14）
  (async () => {
    await import("file:///" + MOD_DEST.replace(/\\/g, "/"));
    await import("file:///" + STREAM.replace(/\\/g, "/")).catch((e) => {
      // stream.js 依赖 openclaw/plugin-sdk/*，在 dist 外无法解析属预期；只报告非解析类错误
      if (/Cannot find (package|module) 'openclaw/.test(String(e && e.message))) return;
      console.error("[patch] stream.js import error:", e && e.message);
      process.exitCode = 1;
    });
    log("syntax OK");
  })();
} catch (e) { console.error("[patch] module syntax error:", e.message); process.exit(1); }
