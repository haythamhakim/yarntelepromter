import { NextResponse } from "next/server";

import {
  DEFAULT_REALTIME_MODEL,
  DEFAULT_REALTIME_VOICE,
  DEFAULT_TRANSCRIPTION_LANGUAGE,
  DEFAULT_TRANSCRIPTION_MODEL,
  DEFAULT_TRUNCATION_CONFIG,
} from "@/lib/realtime/config";
import { buildRealtimeSessionInstructions } from "@/lib/realtime/prompt";

export const runtime = "nodejs";

export async function POST() {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_REALTIME_MODEL ?? DEFAULT_REALTIME_MODEL;

  if (!apiKey) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY is not configured." },
      { status: 500 },
    );
  }

  try {
    const effectiveLanguage = DEFAULT_TRANSCRIPTION_LANGUAGE;

    const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        session: {
          type: "realtime",
          model,
          output_modalities: ["text"],
          instructions: buildRealtimeSessionInstructions(effectiveLanguage),
          truncation: DEFAULT_TRUNCATION_CONFIG,
          audio: {
            input: {
              format: {
                type: "audio/pcm",
                rate: 24000,
              },
              turn_detection: {
                type: "semantic_vad",
                create_response: false,
                interrupt_response: true,
              },
              transcription: {
                model: DEFAULT_TRANSCRIPTION_MODEL,
                language: effectiveLanguage,
              },
            },
            output: {
              voice: DEFAULT_REALTIME_VOICE,
              format: {
                type: "audio/pcm",
                rate: 24000,
              },
            },
          },
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
      value?: string;
      client_secret?: { value?: string };
      session?: { model?: string };
    };

    const clientSecret = data.value ?? data.client_secret?.value;
    if (!clientSecret) {
      return NextResponse.json(
        { error: "Realtime session did not include a client secret." },
        { status: 500 },
      );
    }

    return NextResponse.json({
      clientSecret,
      model: data.session?.model ?? model,
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
