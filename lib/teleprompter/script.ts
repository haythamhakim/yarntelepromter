export type ScriptToken = {
  index: number;
  raw: string;
  normalized: string;
};

export type ScriptLine = {
  id: string;
  text: string;
  tokenStart: number;
  tokenEnd: number;
};

export type ScriptChunk = {
  id: string;
  text: string;
  normalizedText: string;
  tokenStart: number;
  tokenEnd: number;
};

export type PreparedScript = {
  rawText: string;
  tokens: ScriptToken[];
  lines: ScriptLine[];
  chunks: ScriptChunk[];
};

export const DEFAULT_WORDS_PER_LINE = 5;
export const DEFAULT_MAX_LINES = 3;

const NORMALIZE_REGEX = /[^\p{L}\p{N}'-]+/gu;

export function normalizeWord(value: string): string {
  return value.toLowerCase().replace(NORMALIZE_REGEX, "").trim();
}

export function normalizeText(value: string): string {
  return value
    .split(/\s+/)
    .map(normalizeWord)
    .filter(Boolean)
    .join(" ");
}

export function tokenizeScript(script: string): ScriptToken[] {
  const words = script.split(/\s+/).map((word) => word.trim()).filter(Boolean);

  return words.map((raw, index) => ({
    index,
    raw,
    normalized: normalizeWord(raw),
  }));
}

export function buildLines(
  tokens: ScriptToken[],
  wordsPerLine: number = DEFAULT_WORDS_PER_LINE,
): ScriptLine[] {
  if (tokens.length === 0) {
    return [];
  }

  const lines: ScriptLine[] = [];
  for (let i = 0; i < tokens.length; i += wordsPerLine) {
    const slice = tokens.slice(i, i + wordsPerLine);
    lines.push({
      id: `line-${i / wordsPerLine}`,
      text: slice.map((token) => token.raw).join(" "),
      tokenStart: slice[0].index,
      tokenEnd: slice[slice.length - 1].index,
    });
  }

  return lines;
}

export function getWordsPerLineForTextSize(textSize: number): number {
  if (textSize >= 120) {
    return 2;
  }
  if (textSize >= 96) {
    return 3;
  }
  if (textSize >= 72) {
    return 4;
  }
  return DEFAULT_WORDS_PER_LINE;
}

export function buildChunks(
  tokens: ScriptToken[],
  chunkSize: number = 20,
  stride: number = 10,
): ScriptChunk[] {
  if (tokens.length === 0) {
    return [];
  }

  const chunks: ScriptChunk[] = [];
  let chunkIndex = 0;

  for (let start = 0; start < tokens.length; start += stride) {
    const slice = tokens.slice(start, start + chunkSize);
    if (slice.length === 0) {
      break;
    }

    const text = slice.map((token) => token.raw).join(" ");
    chunks.push({
      id: `chunk-${chunkIndex}`,
      text,
      normalizedText: normalizeText(text),
      tokenStart: slice[0].index,
      tokenEnd: slice[slice.length - 1].index,
    });
    chunkIndex += 1;

    if (slice[slice.length - 1].index === tokens[tokens.length - 1].index) {
      break;
    }
  }

  return chunks;
}

export function prepareScript(
  script: string,
  wordsPerLine: number = DEFAULT_WORDS_PER_LINE,
): PreparedScript {
  const tokens = tokenizeScript(script);
  return {
    rawText: script,
    tokens,
    lines: buildLines(tokens, wordsPerLine),
    chunks: buildChunks(tokens),
  };
}

export function getLineIndexForToken(
  lines: ScriptLine[],
  tokenIndex: number,
): number {
  if (lines.length === 0) {
    return 0;
  }

  const lineIndex = lines.findIndex(
    (line) => tokenIndex >= line.tokenStart && tokenIndex <= line.tokenEnd,
  );

  if (lineIndex !== -1) {
    return lineIndex;
  }

  if (tokenIndex < lines[0].tokenStart) {
    return 0;
  }

  return lines.length - 1;
}

export function getLineProgressForToken(
  lines: ScriptLine[],
  tokenIndex: number,
): number {
  if (lines.length === 0) {
    return 0;
  }

  const clampedTokenIndex = Math.max(tokenIndex, lines[0].tokenStart);
  const lineIndex = getLineIndexForToken(lines, clampedTokenIndex);
  const line = lines[lineIndex];
  const lineLength = Math.max(1, line.tokenEnd - line.tokenStart + 1);
  const inLineProgress = Math.min(
    1,
    Math.max(0, (clampedTokenIndex - line.tokenStart) / lineLength),
  );

  return lineIndex + inLineProgress;
}

export function getVisibleLines(
  lines: ScriptLine[],
  tokenIndex: number,
  maxLines: number = DEFAULT_MAX_LINES,
): { visibleLines: ScriptLine[]; currentLineIndexInWindow: number } {
  if (lines.length === 0) {
    return { visibleLines: [], currentLineIndexInWindow: 0 };
  }

  const activeLineIndex = getLineIndexForToken(lines, tokenIndex);
  const maxStart = Math.max(0, lines.length - maxLines);
  const startIndex = Math.min(activeLineIndex, maxStart);
  const visibleLines = lines.slice(startIndex, startIndex + maxLines);

  return {
    visibleLines,
    currentLineIndexInWindow: Math.max(0, activeLineIndex - startIndex),
  };
}
