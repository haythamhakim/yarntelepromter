import { NextResponse } from "next/server";

export const runtime = "nodejs";

const DEFAULT_REALTIME_MODEL = "gpt-4o-realtime-preview";

type RealtimeSessionRequestBody = {
  scriptLanguage?: unknown;
};

function normalizeLanguageCode(value: unknown): string | null {
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

export async function POST(request: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_REALTIME_MODEL ?? DEFAULT_REALTIME_MODEL;

  if (!apiKey) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY is not configured." },
      { status: 500 },
    );
  }

  try {
    let scriptLanguage: string | null = null;
    const rawBody = await request.text();
    if (rawBody.trim()) {
      let parsedBody: RealtimeSessionRequestBody;
      try {
        parsedBody = JSON.parse(rawBody) as RealtimeSessionRequestBody;
      } catch {
        return NextResponse.json(
          { error: "Invalid JSON body." },
          { status: 400 },
        );
      }
      scriptLanguage = normalizeLanguageCode(parsedBody.scriptLanguage);
    }

    const response = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        modalities: ["text", "audio"],
        input_audio_transcription: {
          model: "gpt-4o-mini-transcribe",
          ...(scriptLanguage ? { language: scriptLanguage } : {}),
        },
        turn_detection: {
          type: "server_vad",
        },
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      return NextResponse.json(
        { error: "Failed to create Realtime session.", details: body },
        { status: response.status },
      );
    }

    const data = (await response.json()) as {
      client_secret?: { value?: string };
      model?: string;
    };

    const clientSecret = data.client_secret?.value;
    if (!clientSecret) {
      return NextResponse.json(
        { error: "Realtime session did not include a client secret." },
        { status: 500 },
      );
    }

    return NextResponse.json({
      clientSecret,
      model: data.model ?? model,
    });
  } catch (caughtError) {
    return NextResponse.json(
      {
        error: "Unexpected failure while creating Realtime session.",
        details: caughtError instanceof Error ? caughtError.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
