export type TranscriptUpdate = {
  id: string;
  text: string;
  kind: "partial" | "final";
  createdAt: number;
};

export type RealtimeEventEnvelope = {
  type?: string;
  [key: string]: unknown;
};

export function safeParseRealtimeEvent(data: string): RealtimeEventEnvelope | null {
  try {
    return JSON.parse(data) as RealtimeEventEnvelope;
  } catch {
    return null;
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function extractTranscriptText(event: RealtimeEventEnvelope): string {
  const transcript = str((event as { transcript?: unknown }).transcript);
  if (transcript) return transcript;

  const delta = (event as { delta?: unknown }).delta;
  if (typeof delta === "string" && delta) return delta;
  if (delta && typeof delta === "object") {
    const dt = str((delta as { transcript?: unknown }).transcript);
    if (dt) return dt;
    const dx = str((delta as { text?: unknown }).text);
    if (dx) return dx;
  }

  const text = str((event as { text?: unknown }).text);
  if (text) return text;

  const item = (event as { item?: unknown }).item;
  if (item && typeof item === "object") {
    const it = str((item as { transcript?: unknown }).transcript);
    if (it) return it;

    const content = (item as { content?: unknown }).content;
    if (Array.isArray(content)) {
      for (const entry of content) {
        if (!entry || typeof entry !== "object") continue;
        const ct = str((entry as { transcript?: unknown }).transcript);
        if (ct) return ct;
        const cx = str((entry as { text?: unknown }).text);
        if (cx) return cx;
      }
    }
  }

  return "";
}

export function eventToTranscriptUpdate(
  event: RealtimeEventEnvelope,
): TranscriptUpdate | null {
  const type = str(event.type);
  if (!type) return null;

  const isUserTranscript = type.includes("input_audio_transcription");
  if (!isUserTranscript) return null;

  const text = extractTranscriptText(event);
  if (!text) return null;

  const now = Date.now();
  const kind: "partial" | "final" =
    type.endsWith(".completed") || type.endsWith(".done") || type.endsWith(".final")
      ? "final"
      : "partial";

  return { id: `${kind}-${now}`, text, kind, createdAt: now };
}

export function collectRollingWindow(
  updates: TranscriptUpdate[],
  windowMs: number = 10_000,
): string {
  const cutoff = Date.now() - windowMs;
  return updates
    .filter((u) => u.createdAt >= cutoff)
    .map((u) => u.text.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
