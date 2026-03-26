import { normalizeText, type ScriptChunk, type ScriptToken } from "@/lib/teleprompter/script";

export const FILLER_WORDS = new Set([
  "um",
  "uh",
  "hmm",
  "ah",
  "er",
  "like",
  "you",
  "know",
  "sort",
  "of",
  "kind",
  "actually",
  "basically",
  "right",
  "okay",
  "so",
]);

const WEAK_MATCH_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "if",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "to",
  "was",
  "we",
  "while",
  "with",
  "you",
  "your",
]);

export type AlignmentCandidate = {
  id: string;
  text: string;
  tokenStart: number;
  tokenEnd: number;
};

export type AlignmentResponse = {
  bestChunkId: string | null;
  confidence: number;
  notes: string;
};

export type AlignmentDecision = {
  nextTokenIndex: number;
  confidence: number;
  freeze: boolean;
};

export function buildAlignmentCandidates(
  chunks: ScriptChunk[],
  currentTokenIndex: number,
  count: number = 4,
): AlignmentCandidate[] {
  if (chunks.length === 0) {
    return [];
  }

  const startChunk = chunks.findIndex(
    (chunk) => currentTokenIndex >= chunk.tokenStart && currentTokenIndex <= chunk.tokenEnd,
  );
  const first = startChunk === -1 ? 0 : startChunk;
  return chunks.slice(first, first + count).map((chunk) => ({
    id: chunk.id,
    text: chunk.text,
    tokenStart: chunk.tokenStart,
    tokenEnd: chunk.tokenEnd,
  }));
}

function scoreTokenOverlap(a: string, b: string): number {
  const aTokens = normalizeText(a).split(" ").filter(Boolean);
  const bTokens = normalizeText(b).split(" ").filter(Boolean);

  if (aTokens.length === 0 || bTokens.length === 0) {
    return 0;
  }

  const aSet = new Set(aTokens);
  const bSet = new Set(bTokens);
  let overlap = 0;
  for (const token of aSet) {
    if (bSet.has(token)) {
      overlap += 1;
    }
  }

  return overlap / Math.max(aSet.size, bSet.size);
}

export function cleanTranscriptWindow(windowText: string): string {
  const words = normalizeText(windowText).split(" ").filter(Boolean);
  const cleaned: string[] = [];

  for (let i = 0; i < words.length; i += 1) {
    const current = words[i];
    const next = words[i + 1];
    if (FILLER_WORDS.has(current) && (next === undefined || FILLER_WORDS.has(next))) {
      continue;
    }
    cleaned.push(current);
  }

  return cleaned.join(" ");
}

export function buildAlignmentPrompt(
  transcriptWindow: string,
  candidates: AlignmentCandidate[],
): string {
  const cleanedWindow = cleanTranscriptWindow(transcriptWindow);
  const candidateList = candidates
    .map((candidate) => `- ${candidate.id}: ${candidate.text}`)
    .join("\n");

  return [
    "You are scoring script alignment for a teleprompter.",
    "Given a rolling transcript window and candidate script chunks, return strict JSON only.",
    'Schema: {"bestChunkId":"chunk-id-or-null","confidence":0..1,"notes":"short"}',
    "Guidelines:",
    "- Reward semantic similarity, not exact word match.",
    "- Ignore filler words and ad-lib snippets if core meaning aligns.",
    "- If no candidate is a solid match, use bestChunkId null and confidence <= 0.4.",
    "",
    `TranscriptWindow: ${cleanedWindow || "(empty)"}`,
    "Candidates:",
    candidateList || "- none",
  ].join("\n");
}

export function parseAlignmentResponse(rawText: string): AlignmentResponse | null {
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Partial<AlignmentResponse>;
    const confidence = Math.min(1, Math.max(0, Number(parsed.confidence ?? 0)));
    return {
      bestChunkId: parsed.bestChunkId ?? null,
      confidence,
      notes: String(parsed.notes ?? ""),
    };
  } catch {
    return null;
  }
}

function lexicalFallbackTarget(
  transcriptWindow: string,
  candidates: AlignmentCandidate[],
): { chunkId: string | null; confidence: number } {
  const cleanedWindow = cleanTranscriptWindow(transcriptWindow);
  let bestChunkId: string | null = null;
  let bestScore = 0;

  for (const candidate of candidates) {
    const score = scoreTokenOverlap(cleanedWindow, candidate.text);
    if (score > bestScore) {
      bestScore = score;
      bestChunkId = candidate.id;
    }
  }

  return { chunkId: bestChunkId, confidence: bestScore };
}

export function resolveAlignmentDecision(params: {
  currentTokenIndex: number;
  transcriptWindow: string;
  candidates: AlignmentCandidate[];
  modelResponse: AlignmentResponse | null;
  scriptTokens: ScriptToken[];
}): AlignmentDecision {
  const { currentTokenIndex, transcriptWindow, candidates, modelResponse, scriptTokens } = params;
  const fallback = lexicalFallbackTarget(transcriptWindow, candidates);
  const response = modelResponse ?? null;
  const responseChunkExists = Boolean(
    response?.bestChunkId && candidates.some((item) => item.id === response.bestChunkId),
  );
  const fallbackChunkExists = Boolean(
    fallback.chunkId && candidates.some((item) => item.id === fallback.chunkId),
  );
  const shouldPreferFallback =
    fallbackChunkExists &&
    fallback.confidence >= 0.38 &&
    (!responseChunkExists || (response?.confidence ?? 0) < fallback.confidence + 0.08);
  const bestChunkId = shouldPreferFallback ? fallback.chunkId : response?.bestChunkId ?? fallback.chunkId;
  const confidence = shouldPreferFallback
    ? Math.max(fallback.confidence, (response?.confidence ?? 0) * 0.95)
    : Math.max(response?.confidence ?? 0, fallback.confidence * 0.85);

  if (!bestChunkId || confidence < 0.34) {
    return {
      nextTokenIndex: currentTokenIndex,
      confidence,
      freeze: true,
    };
  }

  const candidate = candidates.find((item) => item.id === bestChunkId);
  if (!candidate) {
    return {
      nextTokenIndex: currentTokenIndex,
      confidence: Math.min(confidence, fallback.confidence),
      freeze: true,
    };
  }

  const target = Math.max(candidate.tokenStart, currentTokenIndex);
  const maxAdvance = confidence >= 0.75 ? 10 : 5;
  const nextTokenIndex = Math.min(
    target + maxAdvance,
    candidate.tokenEnd,
    Math.max(0, scriptTokens.length - 1),
  );

  return {
    nextTokenIndex,
    confidence,
    freeze: confidence < 0.5 && fallback.confidence < 0.34,
  };
}

export function advanceCursorFromTranscript(params: {
  currentTokenIndex: number;
  transcriptWindow: string;
  scriptTokens: ScriptToken[];
  maxLookahead?: number;
  maxAdvancePerTick?: number;
}): number {
  const {
    currentTokenIndex,
    transcriptWindow,
    scriptTokens,
    maxLookahead = 48,
    maxAdvancePerTick = 8,
  } = params;

  if (scriptTokens.length === 0) {
    return 0;
  }

  const safeCurrentIndex = Math.max(0, Math.min(currentTokenIndex, scriptTokens.length - 1));
  const spokenWords = cleanTranscriptWindow(transcriptWindow).split(" ").filter(Boolean);
  if (spokenWords.length === 0) {
    return safeCurrentIndex;
  }

  const endOfSearch = Math.min(safeCurrentIndex + maxLookahead, scriptTokens.length);
  const upcoming = scriptTokens.slice(safeCurrentIndex, endOfSearch);
  if (upcoming.length === 0) {
    return safeCurrentIndex;
  }

  let bestRunEnd = 0;
  let scriptPointer = 0;
  let strongWordMatches = 0;

  for (const spoken of spokenWords) {
    if (scriptPointer >= upcoming.length) break;
    const weakSpoken = spoken.length <= 2 || WEAK_MATCH_WORDS.has(spoken);

    if (spoken === upcoming[scriptPointer].normalized) {
      scriptPointer += 1;
      bestRunEnd = scriptPointer;
      if (!weakSpoken) {
        strongWordMatches += 1;
      }
      continue;
    }

    const scanAhead = bestRunEnd === 0 ? 20 : 5;
    for (
      let scan = scriptPointer + 1;
      scan < Math.min(scriptPointer + scanAhead, upcoming.length);
      scan += 1
    ) {
      if (spoken === upcoming[scan].normalized) {
        scriptPointer = scan + 1;
        bestRunEnd = scriptPointer;
        if (!weakSpoken) {
          strongWordMatches += 1;
        }
        break;
      }
    }
  }

  if (bestRunEnd === 0) {
    const strongSpoken = spokenWords.filter(
      (word) => word.length > 2 && !WEAK_MATCH_WORDS.has(word),
    );
    const strongSpokenSet = new Set(strongSpoken);
    if (strongSpokenSet.size === 0) {
      return safeCurrentIndex;
    }

    let hitCount = 0;
    let lastHitIndex = 0;
    for (let i = 0; i < upcoming.length; i += 1) {
      if (strongSpokenSet.has(upcoming[i].normalized)) {
        hitCount += 1;
        lastHitIndex = i + 1;
      }
    }
    if (hitCount >= 2) {
      const denseEnough = hitCount / Math.max(1, Math.min(upcoming.length, 12)) >= 0.25;
      if (denseEnough) {
        bestRunEnd = Math.min(lastHitIndex, maxAdvancePerTick);
        strongWordMatches = hitCount;
      }
    }
  }

  if (bestRunEnd === 0 || strongWordMatches === 0) {
    return safeCurrentIndex;
  }

  const advance = Math.min(bestRunEnd, maxAdvancePerTick);
  return Math.min(safeCurrentIndex + advance, Math.max(0, scriptTokens.length - 1));
}
