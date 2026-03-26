export const DEFAULT_REALTIME_MODEL = "gpt-realtime";
export const DEFAULT_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
export const DEFAULT_TRANSCRIPTION_LANGUAGE = "en";
export const DEFAULT_REALTIME_VOICE = "marin";

export const DEFAULT_TRUNCATION_CONFIG = {
  type: "retention_ratio",
  retention_ratio: 0.8,
  token_limits: {
    post_instructions: 8000,
  },
} as const;

export function normalizeLanguageCode(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.toLowerCase();
  return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/.test(normalized) ? normalized : null;
}
