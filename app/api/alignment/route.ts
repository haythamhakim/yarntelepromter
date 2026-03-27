import { NextResponse } from "next/server";

import {
  buildSemanticMatchPrompt,
  parseSemanticMatchResponse,
} from "@/lib/teleprompter/semanticAligner";

export const runtime = "nodejs";

type AlignmentRequestBody = {
  transcript?: unknown;
  scriptTokens?: unknown;
};

type TokenInput = { index: number; raw: string };

function validateTokens(value: unknown): TokenInput[] | null {
  if (!Array.isArray(value)) return null;
  const tokens: TokenInput[] = [];
  for (const item of value) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof (item as TokenInput).index !== "number" ||
      typeof (item as TokenInput).raw !== "string"
    ) {
      return null;
    }
    tokens.push({ index: (item as TokenInput).index, raw: (item as TokenInput).raw });
  }
  return tokens.length > 0 ? tokens : null;
}

export async function POST(request: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY is not configured." },
      { status: 500 },
    );
  }

  let body: AlignmentRequestBody;
  try {
    body = (await request.json()) as AlignmentRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const transcript =
    typeof body.transcript === "string" ? body.transcript.trim() : "";
  const scriptTokens = validateTokens(body.scriptTokens);

  if (!transcript || !scriptTokens) {
    return NextResponse.json(
      { error: "transcript (string) and scriptTokens (array) are required." },
      { status: 400 },
    );
  }

  const prompt = buildSemanticMatchPrompt(transcript, scriptTokens);

  try {
    const response = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          temperature: 0,
          max_tokens: 256,
          messages: [
            {
              role: "system",
              content:
                "You are a teleprompter alignment assistant. Return ONLY valid JSON, no markdown fences.",
            },
            { role: "user", content: prompt },
          ],
        }),
      },
    );

    if (!response.ok) {
      const detail = await response.text();
      return NextResponse.json(
        { error: "OpenAI API error.", details: detail },
        { status: response.status },
      );
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const raw = data.choices?.[0]?.message?.content ?? "";
    const parsed = parseSemanticMatchResponse(raw);

    if (!parsed) {
      return NextResponse.json(
        { matchedIndices: [], confidence: 0 },
        { status: 200 },
      );
    }

    return NextResponse.json(parsed);
  } catch (err) {
    return NextResponse.json(
      {
        error: "Failed to call alignment API.",
        details: err instanceof Error ? err.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
