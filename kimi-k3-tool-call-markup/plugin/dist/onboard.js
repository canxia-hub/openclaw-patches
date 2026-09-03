import { i as buildKimiCodingProvider, n as KIMI_CODING_DEFAULT_MODEL_ID, t as KIMI_CODING_BASE_URL } from "./provider-catalog-DesMT16v.js";
import { createDefaultModelPresetAppliers } from "openclaw/plugin-sdk/provider-onboard";
//#region extensions/kimi-coding/onboard.ts
const KIMI_MODEL_REF = `kimi/${KIMI_CODING_DEFAULT_MODEL_ID}`;
const KIMI_CODING_MODEL_REF = KIMI_MODEL_REF;
function resolveKimiCodingDefaultModel() {
	return buildKimiCodingProvider().models.find((model) => model.id === KIMI_CODING_DEFAULT_MODEL_ID);
}
const kimiCodingPresetAppliers = createDefaultModelPresetAppliers({
	primaryModelRef: KIMI_MODEL_REF,
	resolveParams: (_cfg) => {
		const defaultModel = resolveKimiCodingDefaultModel();
		if (!defaultModel) return null;
		return {
			providerId: "kimi",
			api: "anthropic-messages",
			baseUrl: KIMI_CODING_BASE_URL,
			defaultModel,
			defaultModelId: KIMI_CODING_DEFAULT_MODEL_ID,
			aliases: [{
				modelRef: KIMI_MODEL_REF,
				alias: "Kimi"
			}]
		};
	}
});
function applyKimiCodeConfig(cfg) {
	return kimiCodingPresetAppliers.applyConfig(cfg);
}
//#endregion
export { KIMI_CODING_MODEL_REF, KIMI_MODEL_REF, applyKimiCodeConfig };
