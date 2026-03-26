export type TextAlignMode = "left" | "center" | "right";

export type TeleprompterSettings = {
  speed: number;
  textSize: number;
  textAlign: TextAlignMode;
};

export const SETTINGS_STORAGE_KEY = "teleprompter.settings.v1";
export const SPEED_MIN = 1;
export const SPEED_MAX = 50;
export const TEXT_SIZE_MIN = 32;
export const TEXT_SIZE_MAX = 180;

export const DEFAULT_SETTINGS: TeleprompterSettings = {
  speed: 10,
  textSize: 58,
  textAlign: "center",
};

export function limitToRange(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// Backward-compatible alias used by playback smoothing hooks.
export const clamp = limitToRange;

export function parseSettings(raw: string): TeleprompterSettings {
  const parsed = JSON.parse(raw) as Partial<TeleprompterSettings>;
  return {
    speed: limitToRange(Number(parsed.speed ?? DEFAULT_SETTINGS.speed), SPEED_MIN, SPEED_MAX),
    textSize: limitToRange(
      Number(parsed.textSize ?? DEFAULT_SETTINGS.textSize),
      TEXT_SIZE_MIN,
      TEXT_SIZE_MAX,
    ),
    textAlign:
      parsed.textAlign === "left" || parsed.textAlign === "center" || parsed.textAlign === "right"
        ? parsed.textAlign
        : DEFAULT_SETTINGS.textAlign,
  };
}
