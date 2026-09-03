// §3.1 解析器单元测试 — 对齐计划文档的测试表
import { extractKimiTaggedToolCalls, normalizeKimiToolCallName, rewriteKimiTaggedToolCallsInMessage } from "./tool-call-markup.js";

const B = "<|tool_call_begin|>";
const A = "<|tool_call_argument_begin|>";
const E = "<|tool_call_end|>";
const SB = "<|tool_calls_section_begin|>";
const SE = "<|tool_calls_section_end|>";

let pass = 0, fail = 0;
function check(name, cond, extra) {
	if (cond) { pass++; console.log(`  ok  ${name}`); }
	else { fail++; console.error(`FAIL  ${name}${extra ? ` -> ${JSON.stringify(extra)}` : ""}`); }
}

// 1. 正常单调用
{
	const t = `${B}call_1${A}{"command":"echo hi"}${E}`;
	const r = extractKimiTaggedToolCalls(t);
	check("single call parsed", r.calls.length === 1 && r.calls[0].name === "call_1" && r.calls[0].arguments.command === "echo hi", r);
	check("single call full consumption leaves nothing", r.residualText === "", r);
}
// 2. 多调用
{
	const t = `${SB}${B}functions.read${A}{"path":"a.txt"}${E}${B}functions.exec${A}{"command":"ls"}${E}${SE}`;
	const r = extractKimiTaggedToolCalls(t);
	check("multi call parsed", r.calls.length === 2, r);
	check("namespace stripped (I-3)", r.calls[0].name === "read" && r.calls[1].name === "exec", r.calls);
	check("id preserved", r.calls[0].id === "functions.read", r);
	check("no leak (I-2)", !r.residualText.includes("<|"), r);
}
// 3. 缺 END 截断 → 修复/上报且不泄漏
{
	const t = `${B}functions.exec${A}{"command":"echo 1"}${E}${B}functions.read${A}{"path":"b.txt"`;
	const r = extractKimiTaggedToolCalls(t);
	check("truncated tail consumed, no leak", !r.residualText.includes("<|"), r);
	check("first good call kept (I-4)", r.calls.length >= 1 && r.calls[0].name === "exec", r);
	check("truncated flagged", r.truncated === true, r);
}
// 4. 参数嵌套花括号
{
	const t = `${B}sessions_spawn${A}{"task":{"a":{"b":1}},"mode":"run"}${E}`;
	const r = extractKimiTaggedToolCalls(t);
	check("nested braces ok", r.calls.length === 1 && r.calls[0].arguments.task.a.b === 1, r);
}
// 5. 空 args → {}
{
	const t = `${B}get_goal${A}${E}`;
	const r = extractKimiTaggedToolCalls(t);
	check("empty args -> {}", r.calls.length === 1 && JSON.stringify(r.calls[0].arguments) === "{}", r);
}
// 6. functions. 前缀 + 计数后缀（旧行为兼容）
{
	const t = `${B}functions.exec:3${A}{"command":"x"}${E}`;
	const r = extractKimiTaggedToolCalls(t);
	check("functions.exec:3 -> exec", r.calls.length === 1 && r.calls[0].name === "exec", r);
	check("id keeps raw with counter", r.calls[0].id === "functions.exec:3", r);
}
// 7. 未知工具名（原样保留，由网关校验反馈）
{
	const t = `${B}no_such_tool${A}{"a":1}${E}`;
	const r = extractKimiTaggedToolCalls(t);
	check("unknown name passes through", r.calls.length === 1 && r.calls[0].name === "no_such_tool", r);
}
// 8. 混合好坏段：坏段跳过、好段保留
{
	const t = `${B}good_tool${A}{"x":1}${E}${B}bad_tool${A}{not json!!!${E}`;
	const r = extractKimiTaggedToolCalls(t);
	check("mixed: good kept (I-4)", r.calls.length === 1 && r.calls[0].name === "good_tool", r);
	check("mixed: bad reported", r.dropped.length === 1 && r.dropped[0].reason === "unparseable-arguments", r);
}
// 9. 无尾标记的残缺半截标签（流式 partial 帧）不泄漏
{
	const t = `Some prose here ${B}functions.exec${A}{"comma`;
	const r = extractKimiTaggedToolCalls(t);
	check("partial frame: no marker leak", !r.residualText.includes("<|"), r);
	check("partial frame: prose kept", r.residualText.startsWith("Some prose here"), r);
}
// 10. rewrite：stopReason 仅在有调用时翻转为 toolUse
{
	const m = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: `${B}exec${A}{"command":"ls"}${E}` }] };
	rewriteKimiTaggedToolCallsInMessage(m);
	check("rewrite emits toolCall", m.content.some(b => b.type === "toolCall" && b.name === "exec"), m.content);
	check("rewrite flips stopReason", m.stopReason === "toolUse", m);

	const m2 = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: `${B}${A}{}${E}` }] };
	rewriteKimiTaggedToolCallsInMessage(m2);
	check("all-bad keeps stopReason", m2.stopReason === "stop", m2);
	check("all-bad strips markup (I-2)", !JSON.stringify(m2.content).includes("<|tool"), m2.content);
}
// 11. 普通文本不受影响
{
	const m = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "just normal prose" }] };
	rewriteKimiTaggedToolCallsInMessage(m);
	check("normal text untouched", m.content.length === 1 && m.content[0].text === "just normal prose" && m.stopReason === "stop", m);
}
// 12. normalize 直接单测
{
	check("norm a", normalizeKimiToolCallName("functions.exec:1") === "exec");
	check("norm b", normalizeKimiToolCallName("  read  ") === "read");
	check("norm c", normalizeKimiToolCallName("functions.sessions_spawn") === "sessions_spawn");
	check("norm d", normalizeKimiToolCallName("weird_tool()") === "weird_tool");
}
// 13. 旧实现的固定偏移场景：section 包裹缺失但含调用（旧版整段判死，新版应解析）
{
	const t = `${SB} preamble junk ${B}exec${A}{"command":"whoami"}${E}`;
	const r = extractKimiTaggedToolCalls(t);
	check("no-SE section still parses (old impl returned null)", r.calls.length === 1 && r.calls[0].name === "exec", r);
	check("no-SE preamble preserved", r.residualText.includes("preamble junk"), r);
}

// 14. 真实流式形态：散文 + 合法调用 + 半截尾标签
{
	const t = `I will run it now. ${B}exec${A}{"command":"ls"}${E}${B}read${A}{"path": "c.txt"}`;
	const r = extractKimiTaggedToolCalls(t);
	check("prose+call+dangling: call kept", r.calls.length === 1 && r.calls[0].name === "exec", r);
	check("prose+call+dangling: prose kept", r.residualText.startsWith("I will run it now"), r);
	check("prose+call+dangling: no marker leak", !r.residualText.includes("<|"), r);
}
// 15. 仅 section 包裹无实际调用 → 有标记但无调用，stopReason 不翻转、标记不泄漏
{
	const m = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: `${SB}thinking out loud${SE}` }] };
	rewriteKimiTaggedToolCallsInMessage(m);
	check("section-only: text survives clean", m.content.length === 1 && m.content[0].text === "thinking out loud" && !JSON.stringify(m.content).includes("<|"), m.content);
	check("section-only: stopReason stays", m.stopReason === "stop", m);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
