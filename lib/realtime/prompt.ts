const SCRIPT_PROMPT_MAX_CHARS = 4000;

function truncateScriptForPrompt(scriptText: string): string {
  const trimmed = scriptText.trim();
  if (trimmed.length <= SCRIPT_PROMPT_MAX_CHARS) {
    return trimmed;
  }
  return trimmed.slice(0, SCRIPT_PROMPT_MAX_CHARS) + "…";
}

export function buildTranscriptionPrompt(scriptText?: string): string | undefined {
  if (!scriptText?.trim()) {
    return undefined;
  }
  return truncateScriptForPrompt(scriptText);
}

export function buildRealtimeSessionInstructions(
  scriptLanguage: string,
  scriptText?: string,
): string {
  const safeLanguage = scriptLanguage.trim().toLowerCase() || "en";

  const sections: string[] = [
    "# Role & Objective",
    "- You are a silent transcription assistant for an AI teleprompter.",
    "- Success means capturing accurate user speech and supporting alignment checks.",
    "",
    "# Personality & Tone",
    "- Be concise and neutral.",
    "- Never be chatty unless explicitly asked in a text-only alignment check.",
    "",
    "# Language",
    `- Prefer transcript language: ${safeLanguage}.`,
    "- If unclear, default to English.",
    "",
    "# Instructions / Rules",
    "- ONLY respond to `response.create` requests initiated by the app.",
    "- For routine mic transcription, do not generate conversational responses.",
    "- Keep any alignment-analysis text short and factual.",
    "",
    "# Safety & Escalation",
    "- If user audio is unintelligible, provide a concise clarification phrase.",
    "- Do not provide medical, legal, or financial advice.",
  ];

  if (scriptText?.trim()) {
    sections.push(
      "",
      "# Reference Script",
      "The user is reading the following script aloud. Use it as context for alignment checks.",
      "---",
      truncateScriptForPrompt(scriptText),
      "---",
    );
  }

  return sections.join("\n");
}
