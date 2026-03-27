import { NextResponse } from "next/server";
import WebSocket from "ws";

import {
  DEFAULT_REALTIME_MODEL,
  DEFAULT_TRANSCRIPTION_LANGUAGE,
  DEFAULT_TRANSCRIPTION_MODEL,
  DEFAULT_TRUNCATION_CONFIG,
} from "@/lib/realtime/config";
import {
  buildRealtimeSessionInstructions,
  buildTranscriptionPrompt,
} from "@/lib/realtime/prompt";

export const runtime = "nodejs";

type SidebandRequestBody = {
  callId?: unknown;
  scriptText?: unknown;
};

function normalizeCallId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed;
}

export async function POST(request: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY is not configured." },
      { status: 500 },
    );
  }

  let parsedBody: SidebandRequestBody;
  try {
    parsedBody = (await request.json()) as SidebandRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const callId = normalizeCallId(parsedBody.callId);
  if (!callId) {
    return NextResponse.json({ error: "callId is required." }, { status: 400 });
  }

  const model = process.env.OPENAI_REALTIME_MODEL ?? DEFAULT_REALTIME_MODEL;
  const effectiveLanguage = DEFAULT_TRANSCRIPTION_LANGUAGE;
  const scriptText =
    typeof parsedBody.scriptText === "string"
      ? parsedBody.scriptText
      : undefined;
  const transcriptionPrompt = buildTranscriptionPrompt(scriptText);

  const transcriptionConfig: Record<string, unknown> = {
    model: DEFAULT_TRANSCRIPTION_MODEL,
    language: effectiveLanguage,
  };
  if (transcriptionPrompt) {
    transcriptionConfig.prompt = transcriptionPrompt;
  }

  const result = await new Promise<{ ok: boolean; error?: string }>(
    (resolve) => {
      const ws = new WebSocket(
        `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`,
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "OpenAI-Beta": "realtime=v1",
          },
        },
      );
      let settled = false;

      const settle = (value: { ok: boolean; error?: string }) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(value);
      };

      const timeout = setTimeout(() => {
        ws.close();
        settle({
          ok: false,
          error: "Timed out while waiting for sideband session update.",
        });
      }, 7000);

      ws.on("open", () => {
        ws.send(
          JSON.stringify({
            type: "session.update",
            session: {
              type: "realtime",
              model,
              instructions: buildRealtimeSessionInstructions(
                effectiveLanguage,
                scriptText,
              ),
              truncation: DEFAULT_TRUNCATION_CONFIG,
              audio: {
                input: {
                  turn_detection: {
                    type: "server_vad",
                    threshold: 0.35,
                    prefix_padding_ms: 200,
                    silence_duration_ms: 400,
                    create_response: false,
                    interrupt_response: true,
                  },
                  transcription: transcriptionConfig,
                },
              },
            },
          }),
        );
      });

      ws.on("message", (buffer) => {
        try {
          const payload = JSON.parse(buffer.toString()) as { type?: string };
          if (
            payload.type === "session.updated" ||
            payload.type === "session.created"
          ) {
            clearTimeout(timeout);
            ws.close();
            settle({ ok: true });
          }
        } catch {}
      });

      ws.on("error", (error) => {
        clearTimeout(timeout);
        settle({ ok: false, error: error.message });
      });

      ws.on("close", (code, reasonBuffer) => {
        clearTimeout(timeout);
        if (!settled) {
          const reason = reasonBuffer.toString();
          settle({
            ok: false,
            error: reason
              ? `Sideband websocket closed before confirmation (${code}: ${reason}).`
              : `Sideband websocket closed before confirmation (${code}).`,
          });
        }
      });
    },
  );

  if (!result.ok) {
    return NextResponse.json(
      {
        ok: false,
        warning: "Sideband controls were not confirmed in time.",
        details: result.error,
      },
      { status: 202 },
    );
  }

  return NextResponse.json({ ok: true });
}
