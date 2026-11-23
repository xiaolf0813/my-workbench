export const SUPPORTED_MODEL_REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export type ModelReasoningEffort = string;

export type ModelCatalog = {
  models: ModelOption[];
  supportedReasoningEfforts: readonly string[];
  allowCustomSlug: false;
};

export type ModelOption = {
  slug: string;
  displayName: string;
  supportedReasoningEfforts: string[];
  available: boolean | null;
};
