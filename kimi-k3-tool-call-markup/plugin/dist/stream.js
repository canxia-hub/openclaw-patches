import { isKimiK3ModelId } from "./provider-policy-api.js";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { streamSimple } from "openclaw/plugin-sdk/llm";
import { createPayloadPatchStreamWrapper, normalizeOpenAICompatibleReasoningReplay } from "openclaw/plugin-sdk/provider-stream-shared";
import { rewriteKimiTaggedToolCallsInMessage } from "./tool-call-markup.js";
//#region extensions/kimi-coding/stream.ts
const TOOL_CALLS_SECTION_BEGIN = "<|tool_calls_section_begin|>";
const TOOL_CALLS_SECTION_END = "<|tool_calls_section_end|>";
const TOOL_CALL_BEGIN = "<|tool_call_begin|>";
const TOOL_CALL_ARGUMENT_BEGIN = "<|tool_call_argument_begin|>";
const TOOL_CALL_END = "<|tool_call_end|>";
const KIMI_ANTHROPIC_THINKING_BUDGETS = {
	minimal: 1024,
	low: 1024,
	medium: 4096,
	high: 8192,
	adaptive: 8192,
	xhigh: 8192,
	max: 8192
};
const KIMI_ANTHROPIC_VISIBLE_OUTPUT_RESERVE_TOKENS = 1024;
const KIMI_ANTHROPIC_MIN_OUTPUT_TOKENS = 16e3;
const KIMI_K3_THINKING_EFFORTS = {
	minimal: "low",
	low: "low",
	medium: "high",
	high: "high",
	adaptive: "high",
	xhigh: "max",
	max: "max"
};
function normalizeKimiThinkingBudgetTokens(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return;
	const normalized = Math.floor(value);
	return normalized >= 1024 ? normalized : void 0;
}
function normalizeKimiAnthropicMaxTokens(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return;
	const normalized = Math.floor(value);
	return normalized > 0 ? normalized : void 0;
}
function ensureKimiAnthropicMaxTokens(payloadObj, thinkingConfig) {
	if (thinkingConfig.type !== "enabled" || thinkingConfig.budget_tokens === void 0) return;
	const required = Math.max(KIMI_ANTHROPIC_MIN_OUTPUT_TOKENS, thinkingConfig.budget_tokens + KIMI_ANTHROPIC_VISIBLE_OUTPUT_RESERVE_TOKENS);
	const current = normalizeKimiAnthropicMaxTokens(payloadObj.max_tokens);
	payloadObj.max_tokens = current === void 0 ? required : Math.max(current, required);
}
function normalizeKimiThinkingType(value) {
	if (typeof value === "boolean") return value ? "enabled" : "disabled";
	if (typeof value === "string") {
		const normalized = normalizeOptionalLowercaseString(value);
		if (!normalized) return;
		if ([
			"enabled",
			"enable",
			"on",
			"true"
		].includes(normalized)) return "enabled";
		if ([
			"disabled",
			"disable",
			"off",
			"false"
		].includes(normalized)) return "disabled";
		return;
	}
	if (value && typeof value === "object" && !Array.isArray(value)) return normalizeKimiThinkingType(value.type);
}
function normalizeKimiThinkingConfig(value) {
	const type = normalizeKimiThinkingType(value);
	if (!type) return;
	if (type === "disabled") return { type: "disabled" };
	if (!value || typeof value !== "object" || Array.isArray(value)) return { type: "enabled" };
	const record = value;
	const budgetTokens = normalizeKimiThinkingBudgetTokens(record.budget_tokens ?? record.budgetTokens);
	return budgetTokens === void 0 ? { type: "enabled" } : {
		type: "enabled",
		budget_tokens: budgetTokens
	};
}
function resolveKimiAnthropicThinkingBudgetTokens(thinkingLevel) {
	if (!thinkingLevel || thinkingLevel === "off") return;
	return KIMI_ANTHROPIC_THINKING_BUDGETS[thinkingLevel];
}
function resolveKimiThinkingConfig(params) {
	const configured = normalizeKimiThinkingConfig(params.configuredThinking);
	const levelBudgetTokens = resolveKimiAnthropicThinkingBudgetTokens(params.thinkingLevel);
	if (configured) return configured.type === "enabled" && configured.budget_tokens === void 0 ? {
		type: "enabled",
		budget_tokens: levelBudgetTokens ?? 1024
	} : configured;
	if (!params.thinkingLevel || params.thinkingLevel === "off") return { type: "disabled" };
	return levelBudgetTokens === void 0 ? { type: "enabled" } : {
		type: "enabled",
		budget_tokens: levelBudgetTokens
	};
}
function resolveKimiK3ThinkingConfig(params) {
	const configured = normalizeKimiThinkingConfig(params.configuredThinking);
	if (configured?.type === "disabled") return { type: "disabled" };
	if (!configured && params.thinkingLevel === "off") return { type: "disabled" };
	return {
		type: "adaptive",
		effort: params.thinkingLevel && params.thinkingLevel !== "off" ? KIMI_K3_THINKING_EFFORTS[params.thinkingLevel] : "high"
	};
}
// §3.1 重写：旧版 stripTaggedToolCallCounter / parseKimiTaggedToolCalls /
// rewriteKimiTaggedToolCallsInMessage 已移至 ./tool-call-markup.js（容错+归一+防泄漏）。
function transformKimiStreamEvent(value, transformMessage) {
	const event = value && typeof value === "object" ? value : void 0;
	if (!event) return;
	for (const message of [event.partial, event.message]) transformMessage(message);
}
function wrapStreamMessageObjects(stream, transformMessage) {
	const readFinalMessage = stream.result.bind(stream);
	Object.assign(stream, { async result() {
		const message = await readFinalMessage();
		transformMessage(message);
		return message;
	} });
	const createIterator = stream[Symbol.asyncIterator].bind(stream);
	stream[Symbol.asyncIterator] = () => {
		const iterator = createIterator();
		return {
			async next() {
				const step = await iterator.next();
				if (!step.done) transformKimiStreamEvent(step.value, transformMessage);
				return step;
			},
			async return(value) {
				return iterator.return?.(value) ?? {
					done: true,
					value: void 0
				};
			},
			async throw(error) {
				return iterator.throw?.(error) ?? {
					done: true,
					value: void 0
				};
			}
		};
	};
	return stream;
}
function createKimiToolCallMarkupWrapper(baseStreamFn) {
	const underlying = baseStreamFn ?? streamSimple;
	return (model, context, options) => {
		const maybeStream = underlying(model, context, options);
		if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) return Promise.resolve(maybeStream).then((stream) => wrapStreamMessageObjects(stream, rewriteKimiTaggedToolCallsInMessage));
		return wrapStreamMessageObjects(maybeStream, rewriteKimiTaggedToolCallsInMessage);
	};
}
function createKimiThinkingWrapper(baseStreamFn, thinkingConfig, k3ThinkingConfig) {
	const payloadWrapper = createPayloadPatchStreamWrapper(baseStreamFn ?? streamSimple, ({ payload: payloadObj, model }) => {
		if (model.api === "anthropic-messages" && isKimiK3ModelId(model.id)) {
			const outputConfig = payloadObj.output_config;
			if (k3ThinkingConfig.type === "disabled") {
				payloadObj.thinking = { type: "disabled" };
				if (outputConfig && typeof outputConfig === "object" && !Array.isArray(outputConfig)) {
					const nextOutputConfig = { ...outputConfig };
					delete nextOutputConfig.effort;
					if (Object.keys(nextOutputConfig).length > 0) payloadObj.output_config = nextOutputConfig;
					else delete payloadObj.output_config;
				} else delete payloadObj.output_config;
			} else {
				payloadObj.thinking = {
					type: "adaptive",
					display: "summarized"
				};
				payloadObj.output_config = outputConfig && typeof outputConfig === "object" && !Array.isArray(outputConfig) ? {
					...outputConfig,
					effort: k3ThinkingConfig.effort
				} : { effort: k3ThinkingConfig.effort };
			}
			delete payloadObj.reasoning;
			delete payloadObj.reasoning_effort;
			delete payloadObj.reasoningEffort;
			stripAnthropicCacheControlMarkers(payloadObj);
			return;
		}
		const normalized = typeof thinkingConfig === "string" ? { type: thinkingConfig } : thinkingConfig;
		payloadObj.thinking = model.api === "anthropic-messages" ? { ...normalized } : { type: normalized.type };
		if (model.api === "anthropic-messages") ensureKimiAnthropicMaxTokens(payloadObj, normalized);
		else normalizeOpenAICompatibleReasoningReplay(payloadObj, {
			thinkingEnabled: normalized.type === "enabled",
			shouldBackfillAssistantMessage: (message) => Array.isArray(message.tool_calls) && message.tool_calls.length > 0
		});
		delete payloadObj.reasoning;
		delete payloadObj.reasoning_effort;
		delete payloadObj.reasoningEffort;
		stripAnthropicCacheControlMarkers(payloadObj);
	});
	return (model, context, options) => {
		const runtimeModel = model.api === "anthropic-messages" && isKimiK3ModelId(model.id) ? {
			...model,
			compat: {
				...model.compat,
				allowEmptySignature: false
			}
		} : model;
		return payloadWrapper(runtimeModel, context, options);
	};
}
function stripContentBlockCacheControl(block) {
	if (!block || typeof block !== "object") return;
	const record = block;
	delete record.cache_control;
	if (record.type === "tool_result" && Array.isArray(record.content)) for (const nestedBlock of record.content) stripContentBlockCacheControl(nestedBlock);
}
function stripContentArrayCacheControl(value) {
	if (!Array.isArray(value)) return;
	for (const block of value) stripContentBlockCacheControl(block);
}
function stripAnthropicCacheControlMarkers(payloadObj) {
	stripContentArrayCacheControl(payloadObj.system);
	if (!Array.isArray(payloadObj.messages)) return;
	for (const message of payloadObj.messages) {
		if (!message || typeof message !== "object") continue;
		stripContentArrayCacheControl(message.content);
	}
}
function wrapKimiProviderStream(ctx) {
	const thinkingConfig = resolveKimiThinkingConfig({
		configuredThinking: ctx.extraParams?.thinking,
		thinkingLevel: ctx.thinkingLevel
	});
	const k3ThinkingConfig = resolveKimiK3ThinkingConfig({
		configuredThinking: ctx.extraParams?.thinking,
		thinkingLevel: ctx.thinkingLevel
	});
	return createKimiToolCallMarkupWrapper(createKimiThinkingWrapper(ctx.streamFn, thinkingConfig, k3ThinkingConfig));
}
//#endregion
export { wrapKimiProviderStream };
