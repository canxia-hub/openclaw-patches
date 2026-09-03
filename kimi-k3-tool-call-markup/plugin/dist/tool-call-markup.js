// Kimi K3 文本标签工具调用协议解析层（§3.1 重写版 v2，2026-09-03）
// 对齐目标：Kimi ChatML tool-call markup 与 OpenClaw toolCall 块的语义映射。
// 不变量：
//   I-1 每个产出的 toolCall 必须带 id（网关据此配对 toolResult）
//   I-2 协议标签原文任何情况下不得泄漏为可见文本（含流式半截标签）
//   I-3 名字归一：functions.<name>:<n> -> <name>（去计数后缀、去命名空间前缀）
//   I-4 单调用容错：坏段跳过并上报，好段照常产出（旧实现是整段判死）
//   I-5 尾段缺 <|tool_call_end|> 视为流未结束：只上报 truncated，绝不执行修复态参数
//   I-6 零硬编码偏移：全部用 marker.length 定位
//#region kimi tool-call markup parser
const TOOL_CALLS_SECTION_BEGIN = "<|tool_calls_section_begin|>";
const TOOL_CALLS_SECTION_END = "<|tool_calls_section_end|>";
const TOOL_CALL_BEGIN = "<|tool_call_begin|>";
const TOOL_CALL_ARGUMENT_BEGIN = "<|tool_call_argument_begin|>";
const TOOL_CALL_END = "<|tool_call_end|>";
const TOOL_NAME_NAMESPACE_PREFIXES = ["functions."];
const MARKER_RE = /<\|tool_(?:calls_section_(?:begin|end)|call_(?:begin|argument_begin|end))\|>/g;

function stripTaggedToolCallCounter(value) {
	return String(value ?? "").trim().replace(/:\d+$/, "").trim();
}

/** I-3：把标签协议里的原始调用名归一为 OpenClaw 工具名。 */
export function normalizeKimiToolCallName(rawName) {
	let name = stripTaggedToolCallCounter(rawName);
	const lower = name.toLowerCase();
	for (const prefix of TOOL_NAME_NAMESPACE_PREFIXES) {
		if (lower.startsWith(prefix)) {
			name = name.slice(prefix.length).trim();
			break;
		}
	}
	// 常见模板尾巴： "name()" / "name:" / "name ."
	name = name.replace(/\(\s*\)\s*$/, "").replace(/[\s:.,;]+$/, "").trim();
	return name;
}

/** 参数解析：严格 JSON 优先，失败时做保守修复（尾逗号/截断闭合），仍失败返回 null。 */
function parseToolCallArguments(rawArgs) {
	const trimmed = String(rawArgs ?? "").trim();
	if (!trimmed) return {};
	const attempts = [trimmed];
	const noTrailingComma = trimmed.replace(/,(\s*[}\]])/g, "$1");
	if (noTrailingComma !== trimmed) attempts.push(noTrailingComma);
	if (trimmed.startsWith("{") && !trimmed.endsWith("}")) {
		const cut = trimmed.replace(/,?\s*(?:"[^"]*"?\s*:|"[^"]*")$/, "");
		if (cut.trim() && cut.trim() !== trimmed) attempts.push(`${cut.trim().replace(/,\s*$/, "")}}`);
		attempts.push(`${trimmed}}`);
	}
	for (const text of attempts) {
		try {
			const value = JSON.parse(text);
			if (value && typeof value === "object" && !Array.isArray(value)) return value;
		} catch {}
	}
	return null;
}

/**
 * 提取一段文本中的全部合法 toolCall；返回剔除协议标记与调用段后的残余文本。
 * 不要求 section 包裹；坏段只丢坏段；半截/未闭合尾段只上报不执行。
 */
export function extractKimiTaggedToolCalls(text) {
	const result = {
		calls: [],
		dropped: [],
		hadMarkup: false,
		truncated: false,
		residualText: typeof text === "string" ? text : ""
	};
	const source = typeof text === "string" ? text : "";
	if (!source.includes(TOOL_CALL_BEGIN) && !source.includes(TOOL_CALLS_SECTION_BEGIN)) return result;
	result.hadMarkup = true;
	// 被成功消费（整体移除）的文本区间 [start, end)
	const spans = [];

	let cursor = 0;
	while (cursor < source.length) {
		const beginIndex = source.indexOf(TOOL_CALL_BEGIN, cursor);
		if (beginIndex < 0) break;
		const bodyStart = beginIndex + TOOL_CALL_BEGIN.length;
		const argMarkerIndex = source.indexOf(TOOL_CALL_ARGUMENT_BEGIN, bodyStart);
		const callEndIndex = source.indexOf(TOOL_CALL_END, bodyStart);
		const nextBeginIndex = source.indexOf(TOOL_CALL_BEGIN, bodyStart);
		const sectionEndIndex = source.indexOf(TOOL_CALLS_SECTION_END, bodyStart);
		let bound = source.length;
		for (const idx of [nextBeginIndex, sectionEndIndex]) {
			if (idx >= 0 && idx < bound) bound = idx;
		}
		const unterminated = callEndIndex < 0 || callEndIndex > bound;
		const argsEnd = unterminated ? bound : callEndIndex;
		const hasArgMarker = argMarkerIndex >= 0 && argMarkerIndex < argsEnd;
		const rawId = hasArgMarker
			? source.slice(bodyStart, argMarkerIndex).trim()
			: source.slice(bodyStart, argsEnd).trim();
		const rawArgs = hasArgMarker
			? source.slice(argMarkerIndex + TOOL_CALL_ARGUMENT_BEGIN.length, argsEnd).trim()
			: "";
		const name = normalizeKimiToolCallName(rawId);

		if (unterminated) {
			// I-5：尾段未闭合 —— 流可能还在续写，绝不执行；消费到文本末尾防止泄漏
			result.truncated = true;
			result.dropped.push({ rawId: name || rawId || "<empty>", reason: "unterminated-call" });
			spans.push([beginIndex, source.length]);
			break;
		}
		const args = parseToolCallArguments(rawArgs);
		if (!name) {
			result.dropped.push({ rawId: rawId || "<empty>", reason: "empty-name" });
		} else if (!args) {
			result.dropped.push({ rawId: name, reason: "unparseable-arguments" });
		} else {
			// I-1：id 优先用原始标签 id（含计数后缀），保证与 toolResult 严格配对
			const id = rawId || `${name}:${result.calls.length + 1}`;
			result.calls.push({ type: "toolCall", id, name, arguments: args });
		}
		spans.push([beginIndex, callEndIndex + TOOL_CALL_END.length]);
		cursor = callEndIndex + TOOL_CALL_END.length;
	}

	// 残余文本 = 源文本 − 消费区间 − 全部标记（含孤立的 section_begin/end）
	let residual = "";
	let pos = 0;
	spans.sort((a, b) => a[0] - b[0]);
	for (const [start, end] of spans) {
		if (start > pos) residual += source.slice(pos, start);
		pos = Math.max(pos, end);
	}
	if (pos < source.length) residual += source.slice(pos);
	result.residualText = residual.replace(MARKER_RE, "").trim();
	return result;
}

/** 把消息里的 text 块中的 Kimi 标签协议改写为结构化 toolCall 块（保留文本→调用顺序）。 */
export function rewriteKimiTaggedToolCallsInMessage(message) {
	if (!message || typeof message !== "object") return;
	const content = message.content;
	if (!Array.isArray(content)) return;
	const nextContent = [];
	let changed = false;
	let emittedCalls = 0;
	for (const block of content) {
		if (!block || typeof block !== "object" || block.type !== "text" || typeof block.text !== "string") {
			nextContent.push(block);
			continue;
		}
		const parsed = extractKimiTaggedToolCalls(block.text);
		if (!parsed.hadMarkup) {
			nextContent.push(block);
			continue;
		}
		changed = true;
		if (parsed.residualText) nextContent.push({ ...block, text: parsed.residualText });
		nextContent.push(...parsed.calls);
		emittedCalls += parsed.calls.length;
		if (parsed.dropped.length > 0) {
			const detail = parsed.dropped.map((d) => `${d.rawId}(${d.reason})`).join(", ");
			console.warn(`[kimi] tagged tool-call parse report: kept=${parsed.calls.length} dropped=[${detail}]`);
		}
	}
	if (!changed) return;
	message.content = nextContent;
	// 仅在确有可执行调用时翻转为 toolUse；全坏段时保持原 stopReason，避免网关等待不存在的结果
	if (emittedCalls > 0 && message.stopReason === "stop") message.stopReason = "toolUse";
}
//#endregion
