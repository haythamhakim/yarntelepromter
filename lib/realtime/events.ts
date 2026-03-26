export type TranscriptUpdate = {
  id: string;
  text: string;
  kind: "partial" | "final";
  createdAt: number;
};

type RealtimeEventBase = {
  type: string;
  event_id?: string;
  [key: string]: unknown;
};

export type RealtimeErrorEvent = RealtimeEventBase & {
  type: "error";
  error?: string | { message?: string; code?: string; type?: string; [key: string]: unknown };
};

type TranscriptTextContainer = {
  transcript?: string;
  text?: string;
};

type TranscriptItemContent = TranscriptTextContainer & {
  type?: string;
};

type TranscriptItem = TranscriptTextContainer & {
  content?: TranscriptItemContent[];
};

export type RealtimeTranscriptEvent = RealtimeEventBase & {
  type: `${string}input_audio_transcription${string}`;
  transcript?: string;
  delta?: string | TranscriptTextContainer;
  text?: string;
  item?: TranscriptItem;
};

export type RealtimeResponseTextDeltaEvent = RealtimeEventBase & {
  type: "response.output_text.delta" | "response.text.delta";
  delta?: string;
};

export type RealtimeResponseTextDoneEvent = RealtimeEventBase & {
  type: "response.output_text.done" | "response.text.done" | "response.done";
  text?: string;
};

type UsageShape = {
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  input_token_details?: {
    text_tokens?: number;
    audio_tokens?: number;
    cached_tokens?: number;
  };
  output_token_details?: {
    text_tokens?: number;
    audio_tokens?: number;
  };
};

export type RealtimeResponseDoneEvent = RealtimeEventBase & {
  type: "response.done";
  response?: {
    id?: string;
    usage?: UsageShape;
    output?: unknown[];
    metadata?: Record<string, unknown>;
  };
};

export type RealtimeTranscriptionCompletedEvent = RealtimeEventBase & {
  type: "conversation.item.input_audio_transcription.completed";
  usage?: UsageShape;
};

export type RealtimeRateLimitsEvent = RealtimeEventBase & {
  type: "rate_limits.updated";
  rate_limits?: unknown;
};

export type RealtimeSpeechStartedEvent = RealtimeEventBase & {
  type: "input_audio_buffer.speech_started";
};

export type RealtimeOutputItemAddedEvent = RealtimeEventBase & {
  type: "response.output_item.added";
  item?: {
    id?: string;
    type?: string;
    content?: Array<{ type?: string }>;
  };
};

export type RealtimeOutputItemDoneEvent = RealtimeEventBase & {
  type: "response.output_item.done";
  item?: {
    id?: string;
    type?: string;
    content?: Array<{ type?: string }>;
  };
};

export type RealtimeResponseCreatedEvent = RealtimeEventBase & {
  type: "response.created";
  response?: {
    id?: string;
    status?: string;
  };
};

export type RealtimeResponseInterruptedEvent = RealtimeEventBase & {
  type: "response.cancelled" | "response.failed" | "response.incomplete";
  response?: {
    id?: string;
    status?: string;
  };
};

export type RealtimeEventEnvelope =
  | RealtimeErrorEvent
  | RealtimeTranscriptEvent
  | RealtimeResponseTextDeltaEvent
  | RealtimeResponseTextDoneEvent
  | RealtimeResponseCreatedEvent
  | RealtimeResponseDoneEvent
  | RealtimeResponseInterruptedEvent
  | RealtimeTranscriptionCompletedEvent
  | RealtimeRateLimitsEvent
  | RealtimeSpeechStartedEvent
  | RealtimeOutputItemAddedEvent
  | RealtimeOutputItemDoneEvent
  | RealtimeEventBase;

export function safeParseRealtimeEvent(data: string): RealtimeEventEnvelope | null {
  try {
    const parsed = JSON.parse(data) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const type = (parsed as { type?: unknown }).type;
    if (typeof type !== "string" || !type) {
      return null;
    }
    return parsed as RealtimeEventEnvelope;
  } catch {
    return null;
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function extractTranscriptText(event: RealtimeEventEnvelope): string {
  const transcript = str(event.transcript);
  if (transcript) return transcript;

  const delta = event.delta;
  if (typeof delta === "string" && delta) return delta;
  if (delta && typeof delta === "object") {
    const dt = str((delta as TranscriptTextContainer).transcript);
    if (dt) return dt;
    const dx = str((delta as TranscriptTextContainer).text);
    if (dx) return dx;
  }

  const text = str(event.text);
  if (text) return text;

  const item = event.item;
  if (item && typeof item === "object") {
    const it = str((item as TranscriptItem).transcript);
    if (it) return it;

    const content = (item as TranscriptItem).content;
    if (Array.isArray(content)) {
      for (const entry of content) {
        if (!entry || typeof entry !== "object") continue;
        const ct = str((entry as TranscriptItemContent).transcript);
        if (ct) return ct;
        const cx = str((entry as TranscriptItemContent).text);
        if (cx) return cx;
      }
    }
  }

  return "";
}

export function eventToTranscriptUpdate(
  event: RealtimeEventEnvelope,
): TranscriptUpdate | null {
  if (!isTranscriptEvent(event)) return null;

  const text = extractTranscriptText(event);
  if (!text) return null;

  const now = Date.now();
  const kind: "partial" | "final" =
    event.type.endsWith(".completed") || event.type.endsWith(".done") || event.type.endsWith(".final")
      ? "final"
      : "partial";

  return { id: `${kind}-${now}`, text, kind, createdAt: now };
}

export function isTranscriptEvent(event: RealtimeEventEnvelope): event is RealtimeTranscriptEvent {
  return event.type.includes("input_audio_transcription");
}

export function isRealtimeErrorEvent(event: RealtimeEventEnvelope): event is RealtimeErrorEvent {
  return event.type === "error";
}

export function extractRealtimeErrorMessage(event: RealtimeErrorEvent): string {
  if (typeof event.error === "string") {
    return event.error;
  }
  if (event.error && typeof event.error === "object") {
    const message = (event.error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
    return JSON.stringify(event.error);
  }
  return JSON.stringify(event);
}

export function isRealtimeAlignmentTextDeltaEvent(
  event: RealtimeEventEnvelope,
): event is RealtimeResponseTextDeltaEvent {
  return event.type === "response.output_text.delta" || event.type === "response.text.delta";
}

export function isRealtimeAlignmentTextDoneEvent(
  event: RealtimeEventEnvelope,
): event is RealtimeResponseTextDoneEvent {
  return (
    event.type === "response.output_text.done" ||
    event.type === "response.text.done" ||
    event.type === "response.done"
  );
}

export function extractRealtimeAlignmentTextDelta(event: RealtimeResponseTextDeltaEvent): string {
  return typeof event.delta === "string" ? event.delta : "";
}

export function extractRealtimeAlignmentDoneText(event: RealtimeResponseTextDoneEvent): string {
  return typeof event.text === "string" ? event.text : "";
}

export function isRealtimeResponseDoneEvent(
  event: RealtimeEventEnvelope,
): event is RealtimeResponseDoneEvent {
  return event.type === "response.done";
}

export function isRealtimeResponseCreatedEvent(
  event: RealtimeEventEnvelope,
): event is RealtimeResponseCreatedEvent {
  return event.type === "response.created";
}

export function isRealtimeResponseInterruptedEvent(
  event: RealtimeEventEnvelope,
): event is RealtimeResponseInterruptedEvent {
  return (
    event.type === "response.cancelled" ||
    event.type === "response.failed" ||
    event.type === "response.incomplete"
  );
}

export function isRealtimeTranscriptionCompletedEvent(
  event: RealtimeEventEnvelope,
): event is RealtimeTranscriptionCompletedEvent {
  return event.type === "conversation.item.input_audio_transcription.completed";
}

export function isRealtimeRateLimitsUpdatedEvent(
  event: RealtimeEventEnvelope,
): event is RealtimeRateLimitsEvent {
  return event.type === "rate_limits.updated";
}

export function isRealtimeInputSpeechStartedEvent(
  event: RealtimeEventEnvelope,
): event is RealtimeSpeechStartedEvent {
  return event.type === "input_audio_buffer.speech_started";
}

export function isRealtimeOutputItemAddedEvent(
  event: RealtimeEventEnvelope,
): event is RealtimeOutputItemAddedEvent {
  return event.type === "response.output_item.added";
}

export function isRealtimeOutputItemDoneEvent(
  event: RealtimeEventEnvelope,
): event is RealtimeOutputItemDoneEvent {
  return event.type === "response.output_item.done";
}

export function hasRealtimeAudioContent(item: unknown): boolean {
  if (!item || typeof item !== "object") {
    return false;
  }
  const content = (item as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some((entry) => {
    if (!entry || typeof entry !== "object") {
      return false;
    }
    const contentType = (entry as { type?: unknown }).type;
    return typeof contentType === "string" && contentType.toLowerCase().includes("audio");
  });
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
