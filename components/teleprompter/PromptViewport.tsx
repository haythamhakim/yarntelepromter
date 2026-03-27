"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { ScriptLine } from "@/lib/teleprompter/script";

type LiveAudioVisualizerProps = {
  mediaStream: MediaStream;
  width: number | string;
  height: number;
  barWidth?: number;
  gap?: number;
  barColor?: string;
  backgroundColor?: string;
  smoothingTimeConstant?: number;
  fftSize?: number;
};

const LiveAudioVisualizer = memo(function LiveAudioVisualizer({
  mediaStream,
  width,
  height,
  barWidth = 2,
  gap = 1,
  barColor = "rgb(56, 189, 248)",
  backgroundColor = "transparent",
  smoothingTimeConstant = 0.4,
  fftSize = 512,
}: LiveAudioVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  const sizeRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const syncSize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const pw = Math.round(rect.width * dpr);
      const ph = Math.round(rect.height * dpr);
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
      }
      sizeRef.current = { w: pw, h: ph };
    };

    syncSize();
    const observer = new ResizeObserver(syncSize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const stream = mediaStream;
    if (!canvas || !stream || stream.getAudioTracks().length === 0) return;

    const audioCtx = new AudioContext();
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = fftSize;
    analyser.smoothingTimeConstant = smoothingTimeConstant;

    const source = audioCtx.createMediaStreamSource(stream);
    source.connect(analyser);

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const tick = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      analyser.getByteFrequencyData(dataArray);

      const dpr = window.devicePixelRatio || 1;
      const { w, h } = sizeRef.current;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const cssW = w / dpr;
      const cssH = h / dpr;
      ctx.clearRect(0, 0, cssW, cssH);

      if (backgroundColor !== "transparent") {
        ctx.fillStyle = backgroundColor;
        ctx.fillRect(0, 0, cssW, cssH);
      }

      const step = barWidth + gap;
      const barCount = Math.floor(cssW / step);
      const samplesPerBar = Math.floor(bufferLength / barCount) || 1;

      ctx.fillStyle = barColor;
      for (let i = 0; i < barCount; i++) {
        let sum = 0;
        for (let j = 0; j < samplesPerBar; j++) {
          sum += dataArray[i * samplesPerBar + j] ?? 0;
        }
        const avg = sum / samplesPerBar / 255;
        const barH = Math.max(1, avg * cssH);
        const x = i * step;
        const y = (cssH - barH) / 2;
        ctx.fillRect(x, y, barWidth, barH);
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafRef.current);
      source.disconnect();
      void audioCtx.close();
    };
  }, [
    mediaStream,
    fftSize,
    smoothingTimeConstant,
    barWidth,
    gap,
    barColor,
    backgroundColor,
  ]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        width: typeof width === "string" ? width : `${width}px`,
        height: `${height}px`,
        display: "block",
      }}
    />
  );
});

type PromptLineProps = {
  line: ScriptLine;
  isActive: boolean;
  isUpcoming: boolean;
  currentTokenIndex: number;
  spokenTokenIndices: ReadonlySet<number>;
  rowHeight: number;
  textSize: number;
  textAlign: "left" | "center" | "right";
};

const PromptLine = memo(function PromptLine({
  line,
  isActive,
  isUpcoming,
  currentTokenIndex,
  spokenTokenIndices,
  rowHeight,
  textSize,
  textAlign,
}: PromptLineProps) {
  const lineTokens =
    line.tokenStart >= 0 ? line.text.split(/\s+/).filter(Boolean) : [];

  return (
    <p
      className={`flex items-center whitespace-nowrap py-1 leading-tight tracking-tight transition-none ${
        isActive
          ? "font-medium text-zinc-50"
          : isUpcoming
            ? "text-zinc-400"
            : "text-zinc-400/80"
      }`}
      style={{
        minHeight: `${rowHeight}px`,
        fontSize: `${textSize}px`,
        textAlign,
        justifyContent:
          textAlign === "center"
            ? "center"
            : textAlign === "right"
              ? "flex-end"
              : "flex-start",
      }}
    >
      {lineTokens.length === 0
        ? line.text
        : lineTokens.map((token, tokenOffset) => {
            const tokenIndex = line.tokenStart + tokenOffset;
            const isCurrent = tokenIndex === currentTokenIndex;
            const isSpoken = spokenTokenIndices.has(tokenIndex);
            const tokenClass = isCurrent
              ? "text-sky-200"
              : isSpoken
                ? "text-emerald-400"
                : "";

            return (
              <span
                key={`${line.id}-${tokenIndex}`}
                className={`mr-3 inline-block max-w-full break-all rounded px-1 ${tokenClass}`}
              >
                {token}
              </span>
            );
          })}
    </p>
  );
});

function StatusDot({
  frozen,
  frozenReason,
}: {
  frozen: boolean;
  frozenReason: string;
}) {
  const dotRef = useRef<HTMLSpanElement>(null);
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  const updatePos = useCallback(() => {
    const el = dotRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      x: rect.left + rect.width / 2,
      y: rect.top,
    });
  }, []);

  const onEnter = useCallback(() => {
    if (!frozen) return;
    updatePos();
    setShow(true);
  }, [frozen, updatePos]);

  const onLeave = useCallback(() => setShow(false), []);

  return (
    <div className="inline-flex shrink-0">
      <span
        ref={dotRef}
        aria-label={frozen ? frozenReason : "Following speech"}
        tabIndex={frozen ? 0 : -1}
        onMouseEnter={onEnter}
        onFocus={onEnter}
        onMouseLeave={onLeave}
        onBlur={onLeave}
        className={`h-3.5 w-3.5 rounded-full ${
          frozen ? "bg-amber-400" : "bg-emerald-400"
        }`}
      />
      {frozen && show
        ? createPortal(
            <span
              role="tooltip"
              className="pointer-events-none fixed z-9999 w-max max-w-72 rounded-md border border-zinc-600/80 bg-zinc-950/95 px-2.5 py-1.5 text-xs text-zinc-100 shadow-lg ring-1 ring-white/10"
              style={{
                top: pos.y - 8,
                left: pos.x,
                transform: "translate(-50%, -100%)",
              }}
            >
              {frozenReason}
            </span>,
            document.body,
          )
        : null}
    </div>
  );
}

type PromptViewportProps = {
  lines: ScriptLine[];
  currentLineProgress: number;
  currentTokenIndex: number;
  spokenTokenIndices: ReadonlySet<number>;
  frozen: boolean;
  frozenReason: string;
  mediaStream?: MediaStream | null;
  maxVisibleRows: number;
  textSize: number;
  textAlign: "left" | "center" | "right";
  className?: string;
};

export const PromptViewport = memo(function PromptViewport({
  lines,
  currentLineProgress,
  currentTokenIndex,
  spokenTokenIndices,
  frozen,
  frozenReason,
  mediaStream,
  maxVisibleRows,
  textSize,
  textAlign,
  className,
}: PromptViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rowHeight = Math.max(80, textSize * 1.35 + 16);
  const viewportHeight = rowHeight * Math.max(1, maxVisibleRows);
  const anchorRow = Math.max(0, Math.min(maxVisibleRows - 1, 2));
  const activeLineIndex = Math.max(
    0,
    Math.min(lines.length - 1, Math.floor(currentLineProgress)),
  );
  const maxOffsetY = anchorRow * rowHeight;
  const minOffsetY = -Math.max(0, lines.length - maxVisibleRows) * rowHeight;
  const desiredOffsetY = (anchorRow - currentLineProgress) * rowHeight;
  const scrollOffsetY = Math.max(
    minOffsetY,
    Math.min(desiredOffsetY, maxOffsetY),
  );
  const innerMinHeight = Math.max(lines.length, maxVisibleRows) * rowHeight;
  const viewportShellHeight = viewportHeight + 344;
  const [animatedOffsetY, setAnimatedOffsetY] = useState(scrollOffsetY);
  const animatedOffsetRef = useRef(scrollOffsetY);
  const targetOffsetRef = useRef(scrollOffsetY);

  useEffect(() => {
    targetOffsetRef.current = scrollOffsetY;
  }, [scrollOffsetY]);

  useEffect(() => {
    let rafId = 0;
    let lastFrameAt = 0;

    const tick = (now: number) => {
      if (lastFrameAt === 0) {
        lastFrameAt = now;
      }
      const elapsedSeconds = Math.min(0.1, (now - lastFrameAt) / 1000);
      lastFrameAt = now;

      const target = targetOffsetRef.current;
      const current = animatedOffsetRef.current;
      const delta = target - current;

      if (Math.abs(delta) > 0.2) {
        const linesPerSecond = 0.9;
        const pixelsPerSecond = rowHeight * linesPerSecond;
        const maxStep = pixelsPerSecond * elapsedSeconds;
        const step = Math.max(-maxStep, Math.min(maxStep, delta));
        const next = current + step;
        animatedOffsetRef.current = next;
        setAnimatedOffsetY(next);
      } else if (current !== target) {
        animatedOffsetRef.current = target;
        setAnimatedOffsetY(target);
      }

      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, [rowHeight]);

  return (
    <section
      className={`flex max-h-[800px] w-full flex-col overflow-hidden rounded-2xl border border-zinc-700/80 bg-[#151515]/95 p-6 shadow-[0_18px_50px_-24px_rgba(0,0,0,0.55)] ring-1 ring-white/6 ${
        className ?? ""
      }`}
    >
      <div className="mb-3 flex w-full items-center gap-3 overflow-visible rounded-xl border border-zinc-700/60 bg-zinc-900/80 px-3 py-2">
        <StatusDot frozen={frozen} frozenReason={frozenReason} />
        <div className="flex h-6 flex-1 items-center justify-center">
          {mediaStream ? (
            <LiveAudioVisualizer
              mediaStream={mediaStream}
              width="100%"
              height={24}
              barWidth={2}
              gap={1}
              barColor="rgb(56, 189, 248)"
              backgroundColor="transparent"
              smoothingTimeConstant={0.4}
              fftSize={512}
            />
          ) : (
            <div className="h-6" />
          )}
        </div>
      </div>

      <div className="mb-4 flex w-full items-center justify-between">
        <h2 className=" uppercase tracking-[0.14em] text-zinc-400">
          Readback View
        </h2>
      </div>

      <div
        ref={containerRef}
        className="relative mx-auto min-h-0 w-full max-w-6xl flex-1 overflow-hidden rounded-2xl border border-zinc-700/60 bg-[#0E0E0E] p-5"
        style={{
          height: `${viewportShellHeight}px`,
          minHeight: `${viewportShellHeight}px`,
          maxHeight: `${viewportShellHeight}px`,
        }}
      >
        <div
          style={{
            transform: `translate3d(0, ${animatedOffsetY}px, 0)`,
            minHeight: `${innerMinHeight}px`,
          }}
        >
          {lines.map((line, index) => (
            <PromptLine
              key={line.id}
              line={line}
              isActive={index === activeLineIndex}
              isUpcoming={index > activeLineIndex}
              currentTokenIndex={currentTokenIndex}
              spokenTokenIndices={spokenTokenIndices}
              rowHeight={rowHeight}
              textSize={textSize}
              textAlign={textAlign}
            />
          ))}
        </div>
      </div>
    </section>
  );
});
