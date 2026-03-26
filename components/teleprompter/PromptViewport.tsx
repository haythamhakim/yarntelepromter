"use client";

import { useEffect, useMemo, useState } from "react";

import type { ScriptLine } from "@/lib/teleprompter/script";

type PromptViewportProps = {
  lines: ScriptLine[];
  currentLineIndexInWindow: number;
  currentTokenIndex: number;
  frozen: boolean;
  speechLevel: number;
  lineProgressInWindow: number;
  anchorRow: number;
  maxVisibleRows: number;
  textSize: number;
  textAlign: "left" | "center" | "right";
  showGuideMarker: boolean;
  className?: string;
};

export function PromptViewport({
  lines,
  currentLineIndexInWindow,
  currentTokenIndex,
  frozen,
  speechLevel,
  lineProgressInWindow,
  anchorRow,
  maxVisibleRows,
  textSize,
  textAlign,
  showGuideMarker,
  className,
}: PromptViewportProps) {
  const [wavePhase, setWavePhase] = useState(0);
  const speechIntensity = Math.max(0, Math.min(1, speechLevel));
  const hasAudioActivity = speechIntensity > 0.04;

  useEffect(() => {
    if (!hasAudioActivity) {
      return;
    }

    const timer = window.setInterval(() => {
      setWavePhase((previous) => previous + 1);
    }, 120);

    return () => window.clearInterval(timer);
  }, [hasAudioActivity]);

  const waveHeights = useMemo(() => {
    return Array.from({ length: 14 }, (_, index) => {
      const oscillation = (Math.sin((wavePhase + index) * 0.75) + 1) / 2;
      const intensity = hasAudioActivity ? speechIntensity : 0;
      const normalizedHeight = 0.2 + oscillation * (0.25 + intensity * 0.75);
      return Math.max(4, Math.round(normalizedHeight * 20));
    });
  }, [hasAudioActivity, speechIntensity, wavePhase]);

  const activityWidth = `${Math.round(speechIntensity * 100)}%`;
  const rowHeight = 420 / Math.max(1, maxVisibleRows);
  const offsetRows = anchorRow - lineProgressInWindow;
  const translateY = offsetRows * rowHeight;

  return (
    <section
      className={`w-full rounded-3xl border border-zinc-200 bg-zinc-100/70 p-6 shadow-inner dark:border-zinc-800 dark:bg-zinc-900/70 ${
        className ?? ""
      }`}
    >
      <div className="mb-3 flex justify-center rounded-xl border border-zinc-200 bg-white/85 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-950/80">
        <div className="flex h-6 items-end gap-1">
          {waveHeights.map((height, index) => (
            <span
              key={`wave-${index}`}
              className="w-1.5 rounded-full bg-sky-500/70 transition-all duration-100 dark:bg-sky-300/90"
              style={{
                height: `${height}px`,
                opacity: hasAudioActivity ? 0.35 + speechIntensity * 0.65 : 0.2,
              }}
            />
          ))}
        </div>
      </div>

      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-medium tracking-wide text-zinc-700 dark:text-zinc-200">
          Readback View
        </h2>
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-zinc-200 bg-white/90 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-950/90">
        <div className="flex items-center gap-3">
          <span
            className={`rounded-full px-3 py-1 text-xs font-semibold ${
              frozen
                ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
            }`}
          >
            {frozen ? "Alignment paused" : "Following speech"}
          </span>
        </div>

        <div className="h-2 w-36 overflow-hidden rounded-full bg-zinc-300 dark:bg-zinc-700">
          <div
            className="h-full rounded-full bg-sky-500 transition-[width] duration-150 dark:bg-sky-400"
            style={{ width: activityWidth }}
          />
        </div>
      </div>

      <div className="relative min-h-[420px] overflow-hidden rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
        {showGuideMarker ? (
          <div
            className="pointer-events-none absolute left-3 right-3 z-10 border-t border-sky-400/60 dark:border-sky-300/60"
            style={{ top: `${rowHeight * (anchorRow + 0.5) + 20}px` }}
          />
        ) : null}

        <div
          className="transition-transform duration-150 ease-out"
          style={{ transform: `translateY(${translateY}px)` }}
        >
        {lines.map((line, index) => {
          const isActive = index === currentLineIndexInWindow;
          const isUpcoming = index > currentLineIndexInWindow;
          const lineTokens =
            line.tokenStart >= 0 ? line.text.split(/\s+/).filter(Boolean) : [];

          return (
            <p
              key={line.id}
              className={`flex items-center whitespace-nowrap py-1 leading-tight tracking-tight transition-all duration-150 ${
                isActive
                  ? "font-medium text-zinc-900 dark:text-white"
                  : isUpcoming
                    ? "text-zinc-600 dark:text-zinc-300"
                    : "text-zinc-400 dark:text-zinc-500"
              }`}
              style={{
                minHeight: `${rowHeight}px`,
                fontSize: `${textSize}px`,
                textAlign,
                justifyContent:
                  textAlign === "center" ? "center" : textAlign === "right" ? "flex-end" : "flex-start",
              }}
            >
              {lineTokens.length === 0
                ? line.text
                : lineTokens.map((token, tokenOffset) => {
                    const tokenIndex = line.tokenStart + tokenOffset;
                    const isRead = tokenIndex < currentTokenIndex;
                    const isCurrent = tokenIndex === currentTokenIndex;

                    return (
                      <span
                        key={`${line.id}-${tokenIndex}`}
                        className={`mr-3 inline-block rounded px-1 ${
                          isCurrent
                            ? "bg-sky-500/15 text-sky-700 dark:text-sky-100"
                            : isRead
                              ? "text-emerald-600 dark:text-emerald-300"
                              : undefined
                        }`}
                      >
                        {token}
                      </span>
                    );
                  })}
            </p>
          );
        })}
        </div>
      </div>
    </section>
  );
}
