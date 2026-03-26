"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

import { PromptViewport } from "@/components/teleprompter/PromptViewport";
import { useOpenAIRealtime } from "@/hooks/useOpenAIRealtime";
import { useSmoothTeleprompterPlayback } from "@/hooks/useSmoothTeleprompterPlayback";
import { collectRollingWindow } from "@/lib/realtime/events";
import {
  advanceCursorFromTranscript,
  buildAlignmentCandidates,
  resolveAlignmentDecision,
} from "@/lib/teleprompter/semanticAligner";
import { inferScriptLanguageCode } from "@/lib/teleprompter/language";
import {
  DEFAULT_MAX_LINES,
  getLineProgressForToken,
  prepareScript,
} from "@/lib/teleprompter/script";

const DEFAULT_SCRIPT = `Welcome to your AI teleprompter.
Speak naturally while reading.
If you skip words, the prompter should still keep pace.
If you go off-script, it pauses until alignment recovers.
When you come back on track, it scrolls forward smoothly.`;

type Mode = "compose" | "readback";
type TextAlignMode = "left" | "center" | "right";

type TeleprompterSettings = {
  speed: number;
  textSize: number;
  textAlign: TextAlignMode;
  showGuideMarker: boolean;
};

const SETTINGS_STORAGE_KEY = "teleprompter.settings.v1";
const DEFAULT_SETTINGS: TeleprompterSettings = {
  speed: 10,
  textSize: 58,
  textAlign: "center",
  showGuideMarker: true,
};

export function TeleprompterApp() {
  const [mode, setMode] = useState<Mode>("compose");
  const [scriptInput, setScriptInput] = useState(DEFAULT_SCRIPT);
  const [cursorTokenIndex, setCursorTokenIndex] = useState(0);
  const [isPlaybackPaused, setIsPlaybackPaused] = useState(false);
  const [isFrozen, setIsFrozen] = useState(false);
  const [isRealtimeStalled, setIsRealtimeStalled] = useState(false);
  const [alignmentConfidence, setAlignmentConfidence] = useState(0);
  const [settings, setSettings] = useState<TeleprompterSettings>(DEFAULT_SETTINGS);
  const [isSpeedControlOpen, setIsSpeedControlOpen] = useState(false);
  const [isTextSizeControlOpen, setIsTextSizeControlOpen] = useState(false);

  const alignInFlightRef = useRef(false);
  const lastAlignedAtRef = useRef(0);
  const speedControlRef = useRef<HTMLDivElement | null>(null);
  const textSizeControlRef = useRef<HTMLDivElement | null>(null);

  const scriptLanguage = useMemo(() => inferScriptLanguageCode(scriptInput), [scriptInput]);

  const {
    status,
    error,
    updates,
    speechLevel,
    start,
    stop,
    requestSemanticAlignment,
  } = useOpenAIRealtime({ scriptLanguage });

  const prepared = useMemo(() => prepareScript(scriptInput), [scriptInput]);
  const rollingWindow = useMemo(() => collectRollingWindow(updates, 10_000), [updates]);
  const maxTokenIndex = Math.max(0, prepared.tokens.length - 1);
  const playbackFrozen = isFrozen || isRealtimeStalled || isPlaybackPaused || status !== "connected";
  const smoothedTokenIndex = useSmoothTeleprompterPlayback({
    targetTokenIndex: cursorTokenIndex,
    maxTokenIndex,
    speed: settings.speed,
    isPlaying: mode === "readback" && status === "connected" && !isPlaybackPaused,
    frozen: playbackFrozen,
  });
  const lineProgress = useMemo(
    () => getLineProgressForToken(prepared.lines, smoothedTokenIndex),
    [prepared.lines, smoothedTokenIndex],
  );
  const viewportConfig = useMemo(() => {
    const anchorRow = 1.5;
    const overscan = 2;
    const renderRows = DEFAULT_MAX_LINES + overscan;
    const maxStart = Math.max(0, prepared.lines.length - renderRows);
    const preferredStart = Math.floor(lineProgress - anchorRow);
    const windowStart = Math.max(0, Math.min(preferredStart, maxStart));
    const lines = prepared.lines.slice(windowStart, windowStart + renderRows);
    const lineProgressInWindow = Math.max(0, lineProgress - windowStart);
    const missing = Math.max(0, renderRows - lines.length);
    const placeholders = Array.from({ length: missing }, (_, index) => ({
      id: `placeholder-${index}`,
      text: " ",
      tokenStart: -1,
      tokenEnd: -1,
    }));

    return {
      anchorRow,
      lineProgressInWindow,
      lines: [...lines, ...placeholders],
    };
  }, [lineProgress, prepared.lines]);

  const latestTranscript = updates[updates.length - 1]?.text ?? "";
  const progress = prepared.tokens.length
    ? Math.min(100, Math.round((smoothedTokenIndex / prepared.tokens.length) * 100))
    : 0;

  const maybeAlign = useCallback(async () => {
    if (mode !== "readback" || status !== "connected") {
      return;
    }

    if (prepared.tokens.length === 0 || rollingWindow.length < 8) {
      return;
    }

    if (alignInFlightRef.current) {
      return;
    }

    const now = Date.now();
    if (now - lastAlignedAtRef.current < 500) {
      return;
    }

    const candidates = buildAlignmentCandidates(prepared.chunks, cursorTokenIndex, 4);
    if (candidates.length === 0) {
      return;
    }

    alignInFlightRef.current = true;
    lastAlignedAtRef.current = now;

    try {
      const modelResponse = await requestSemanticAlignment(rollingWindow, candidates);
      const decision = resolveAlignmentDecision({
        currentTokenIndex: cursorTokenIndex,
        transcriptWindow: rollingWindow,
        candidates,
        modelResponse,
        scriptTokens: prepared.tokens,
      });

      setAlignmentConfidence(decision.confidence);
      setIsFrozen(decision.freeze);

      if (process.env.NODE_ENV === "development") {
        // Keep this light to help tune thresholds during local testing.
        console.debug("teleprompter-alignment", {
          confidence: decision.confidence,
          freeze: decision.freeze,
          nextTokenIndex: decision.nextTokenIndex,
          currentTokenIndex: cursorTokenIndex,
        });
      }

      setCursorTokenIndex((previous) => {
        if (decision.nextTokenIndex <= previous) {
          return previous;
        }
        return decision.nextTokenIndex;
      });
    } finally {
      alignInFlightRef.current = false;
    }
  }, [
    cursorTokenIndex,
    mode,
    prepared.chunks,
    prepared.tokens,
    requestSemanticAlignment,
    rollingWindow,
    status,
  ]);

  const onStartReadback = async () => {
    if (prepared.tokens.length === 0) {
      return;
    }
    setCursorTokenIndex(0);
    setIsPlaybackPaused(false);
    setAlignmentConfidence(0);
    setIsFrozen(false);
    setMode("readback");
    await start();
  };

  const onBackToEditor = () => {
    stop();
    setIsPlaybackPaused(false);
    setMode("compose");
  };

  const togglePlayback = useCallback(async () => {
    if (status === "connecting") {
      return;
    }
    if (status === "connected") {
      stop();
      setIsPlaybackPaused(true);
      return;
    }
    setIsPlaybackPaused(false);
    await start();
  }, [start, status, stop]);

  useEffect(() => {
    void maybeAlign();
  }, [maybeAlign]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) {
      return;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<TeleprompterSettings>;
      setSettings({
        speed: Math.max(1, Math.min(50, Number(parsed.speed ?? DEFAULT_SETTINGS.speed))),
        textSize: Math.max(32, Math.min(180, Number(parsed.textSize ?? DEFAULT_SETTINGS.textSize))),
        textAlign:
          parsed.textAlign === "left" || parsed.textAlign === "center" || parsed.textAlign === "right"
            ? parsed.textAlign
            : DEFAULT_SETTINGS.textAlign,
        showGuideMarker:
          typeof parsed.showGuideMarker === "boolean"
            ? parsed.showGuideMarker
            : DEFAULT_SETTINGS.showGuideMarker,
      });
    } catch {
      setSettings(DEFAULT_SETTINGS);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    if (mode !== "readback" || status !== "connected") {
      return;
    }

    if (!rollingWindow.trim() || prepared.tokens.length === 0) {
      return;
    }

    setCursorTokenIndex((previous) =>
      advanceCursorFromTranscript({
        currentTokenIndex: previous,
        transcriptWindow: rollingWindow,
        scriptTokens: prepared.tokens,
      }),
    );
  }, [mode, prepared.tokens, rollingWindow, status]);

  useEffect(() => {
    if (mode !== "readback" || status !== "connected") {
      setIsRealtimeStalled(false);
      return;
    }

    const timer = window.setInterval(() => {
      if (updates.length === 0) {
        setIsRealtimeStalled(false);
        return;
      }
      const lastUpdateAt = updates[updates.length - 1]?.createdAt ?? 0;
      setIsRealtimeStalled(Date.now() - lastUpdateAt > 2_000);
    }, 500);

    return () => window.clearInterval(timer);
  }, [mode, status, updates]);

  useEffect(() => {
    if (mode !== "readback") {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.getAttribute("contenteditable") === "true")
      ) {
        return;
      }

      if (event.code === "Space") {
        event.preventDefault();
        void togglePlayback();
        return;
      }

      if (event.code === "ArrowUp") {
        event.preventDefault();
        setSettings((previous) => ({ ...previous, speed: Math.min(50, previous.speed + 1) }));
        return;
      }

      if (event.code === "ArrowDown") {
        event.preventDefault();
        setSettings((previous) => ({ ...previous, speed: Math.max(1, previous.speed - 1) }));
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mode, togglePlayback]);

  useEffect(() => {
    if (!isSpeedControlOpen) {
      return;
    }

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) {
        return;
      }
      if (speedControlRef.current?.contains(target)) {
        return;
      }
      setIsSpeedControlOpen(false);
    };

    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsSpeedControlOpen(false);
      }
    };

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onEscape);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onEscape);
    };
  }, [isSpeedControlOpen]);

  useEffect(() => {
    if (!isTextSizeControlOpen) {
      return;
    }

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) {
        return;
      }
      if (textSizeControlRef.current?.contains(target)) {
        return;
      }
      setIsTextSizeControlOpen(false);
    };

    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsTextSizeControlOpen(false);
      }
    };

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onEscape);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onEscape);
    };
  }, [isTextSizeControlOpen]);

  return (
    <>
      <AnimatePresence mode="wait" initial={false}>
      {mode === "compose" ? (
        <motion.main
          key="compose"
          initial={{ opacity: 0, scale: 0.985, y: 16 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.985, y: -14 }}
          transition={{ duration: 0.3, ease: "easeOut" }}
          className="flex min-h-screen w-full items-center justify-center px-6 py-10"
        >
          <section className="w-full max-w-4xl rounded-[28px] border border-zinc-200/90 bg-white/90 p-8 shadow-[0_26px_70px_-44px_rgba(0,0,0,0.42)] backdrop-blur dark:border-zinc-800/90 dark:bg-zinc-950/85">
            <header className="space-y-2 text-center">
              <h1 className="text-3xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50 md:text-4xl">
                AI Teleprompter
              </h1>
            </header>

            <div className="mt-6 rounded-2xl border border-zinc-200/90 bg-zinc-50/80 p-5 shadow-inner dark:border-zinc-800 dark:bg-zinc-900/60">
              <label
                htmlFor="script-input"
                className="mb-2 block text-sm font-medium text-zinc-700 dark:text-zinc-200"
              >
                Script
              </label>
              <textarea
                id="script-input"
                value={scriptInput}
                onChange={(event) => setScriptInput(event.target.value)}
                className="min-h-[340px] w-full resize-y rounded-2xl border border-zinc-200 bg-white p-5 text-[15px] leading-7 text-zinc-900 outline-none transition focus:border-zinc-400 focus:ring-2 focus:ring-zinc-200 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-zinc-500 dark:focus:ring-zinc-800"
                placeholder="Write or paste your script..."
              />

              <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={onStartReadback}
                  disabled={!scriptInput.trim() || status === "connecting"}
                  className="rounded-full bg-zinc-900 px-6 py-2.5 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
                >
                  {status === "connecting" ? "Connecting..." : "Read Back Script"}
                </button>
                <button
                  type="button"
                  onClick={() => setIsShortcutsOpen(true)}
                  className="rounded-full border border-zinc-300 bg-white px-5 py-2.5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-900"
                >
                  Shortcuts
                </button>
              </div>
            </div>
          </section>
        </motion.main>
      ) : (
        <motion.main
          key="readback"
          initial={{ opacity: 0, scale: 0.98 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 1.01 }}
          transition={{ duration: 0.35, ease: "easeOut" }}
          className="fixed inset-0 z-20 flex min-h-screen w-full flex-col bg-[#f7f7f5] px-5 py-5 dark:bg-[#09090b]"
        >
          <header className="mx-auto flex w-full max-w-7xl items-center justify-between gap-3 rounded-2xl border border-zinc-200/90 bg-white/90 px-4 py-3 shadow-[0_14px_40px_-32px_rgba(0,0,0,0.45)] backdrop-blur dark:border-zinc-800/90 dark:bg-zinc-950/90">
            <button
              type="button"
              onClick={onBackToEditor}
              className="rounded-full border border-zinc-300 px-3.5 py-2 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
            >
              Back
            </button>

            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-label="Play or Pause"
                onClick={() => void togglePlayback()}
                disabled={status === "connecting"}
                className="flex h-10 w-10 items-center justify-center rounded-full border border-zinc-300 bg-white text-zinc-800 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:hover:bg-zinc-900"
              >
                {status === "connected" ? (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-4 w-1.5 rounded-sm bg-current" />
                    <span className="h-4 w-1.5 rounded-sm bg-current" />
                  </span>
                ) : (
                  <span className="ml-0.5 h-0 w-0 border-y-8 border-y-transparent border-l-12 border-l-current" />
                )}
              </button>
              <button
                type="button"
                onClick={() => setIsShortcutsOpen(true)}
                className="rounded-full border border-zinc-300 px-3.5 py-2 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
              >
                Shortcuts
              </button>
            </div>

            <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
              {status} | {progress}% | confidence {alignmentConfidence.toFixed(2)}
            </p>
          </header>

          <section className="mx-auto mt-4 flex w-full max-w-7xl flex-1 flex-col gap-4 overflow-hidden">
            <section className="grid gap-3 rounded-2xl border border-zinc-200/90 bg-white/90 p-4 md:grid-cols-2 xl:grid-cols-4 dark:border-zinc-800 dark:bg-zinc-950/90">
              <div ref={speedControlRef} className="relative">
                <button
                  type="button"
                  aria-label={`Set speed, current ${settings.speed}`}
                  aria-expanded={isSpeedControlOpen}
                  aria-controls="speed-control-popover"
                  onClick={() => {
                    setIsTextSizeControlOpen(false);
                    setIsSpeedControlOpen((open) => !open);
                  }}
                  className="group flex w-full items-center justify-between rounded-xl border border-zinc-300/90 bg-white px-3 py-2 text-left transition hover:border-zinc-400 hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-300 dark:border-zinc-700 dark:bg-zinc-950 dark:hover:border-zinc-500 dark:hover:bg-zinc-900 dark:focus-visible:ring-zinc-700"
                >
                  <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                    Speed
                  </span>
                  <motion.span
                    key={settings.speed}
                    initial={{ opacity: 0, y: 4, scale: 0.96 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    transition={{ duration: 0.2, ease: "easeOut" }}
                    className="text-sm font-semibold text-zinc-900 dark:text-zinc-100"
                  >
                    {settings.speed}
                  </motion.span>
                </button>

                <AnimatePresence>
                  {isSpeedControlOpen ? (
                    <motion.div
                      id="speed-control-popover"
                      initial={{ opacity: 0, y: 8, scale: 0.96 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 8, scale: 0.98 }}
                      transition={{ duration: 0.18, ease: "easeOut" }}
                      className="absolute left-0 right-0 z-30 mt-2 rounded-2xl border border-zinc-200/90 bg-white/95 p-3 shadow-[0_18px_40px_-24px_rgba(0,0,0,0.35)] backdrop-blur dark:border-zinc-700/90 dark:bg-zinc-950/95"
                    >
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                          Playback speed
                        </span>
                        <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                          {settings.speed}
                        </span>
                      </div>
                      <input
                        autoFocus
                        type="range"
                        min={1}
                        max={50}
                        step={1}
                        value={settings.speed}
                        onChange={(event) =>
                          setSettings((previous) => ({
                            ...previous,
                            speed: Number(event.target.value),
                          }))
                        }
                        className="w-full accent-zinc-900 dark:accent-zinc-100"
                      />
                      <div className="mt-3 flex items-center justify-between">
                        <button
                          type="button"
                          aria-label="Decrease speed"
                          onClick={() =>
                            setSettings((previous) => ({
                              ...previous,
                              speed: Math.max(1, previous.speed - 1),
                            }))
                          }
                          className="rounded-lg border border-zinc-300 px-2.5 py-1 text-xs font-semibold text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
                        >
                          -1
                        </button>
                        <button
                          type="button"
                          aria-label="Increase speed"
                          onClick={() =>
                            setSettings((previous) => ({
                              ...previous,
                              speed: Math.min(50, previous.speed + 1),
                            }))
                          }
                          className="rounded-lg border border-zinc-300 px-2.5 py-1 text-xs font-semibold text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
                        >
                          +1
                        </button>
                      </div>
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </div>

              <div ref={textSizeControlRef} className="relative">
                <button
                  type="button"
                  aria-label={`Set text size, current ${settings.textSize}`}
                  aria-expanded={isTextSizeControlOpen}
                  aria-controls="text-size-control-popover"
                  onClick={() => {
                    setIsSpeedControlOpen(false);
                    setIsTextSizeControlOpen((open) => !open);
                  }}
                  className="group flex w-full items-center justify-between rounded-xl border border-zinc-300/90 bg-white px-3 py-2 text-left transition hover:border-zinc-400 hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-300 dark:border-zinc-700 dark:bg-zinc-950 dark:hover:border-zinc-500 dark:hover:bg-zinc-900 dark:focus-visible:ring-zinc-700"
                >
                  <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                    Text size
                  </span>
                  <motion.span
                    key={settings.textSize}
                    initial={{ opacity: 0, y: 4, scale: 0.96 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    transition={{ duration: 0.2, ease: "easeOut" }}
                    className="text-sm font-semibold text-zinc-900 dark:text-zinc-100"
                  >
                    {settings.textSize}px
                  </motion.span>
                </button>

                <AnimatePresence>
                  {isTextSizeControlOpen ? (
                    <motion.div
                      id="text-size-control-popover"
                      initial={{ opacity: 0, y: 8, scale: 0.96 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 8, scale: 0.98 }}
                      transition={{ duration: 0.18, ease: "easeOut" }}
                      className="absolute left-0 right-0 z-30 mt-2 rounded-2xl border border-zinc-200/90 bg-white/95 p-3 shadow-[0_18px_40px_-24px_rgba(0,0,0,0.35)] backdrop-blur dark:border-zinc-700/90 dark:bg-zinc-950/95"
                    >
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                          Text size
                        </span>
                        <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                          {settings.textSize}px
                        </span>
                      </div>
                      <input
                        autoFocus
                        type="range"
                        min={32}
                        max={180}
                        step={1}
                        value={settings.textSize}
                        onChange={(event) =>
                          setSettings((previous) => ({
                            ...previous,
                            textSize: Number(event.target.value),
                          }))
                        }
                        className="w-full accent-zinc-900 dark:accent-zinc-100"
                      />
                      <div className="mt-3 flex items-center justify-between">
                        <button
                          type="button"
                          aria-label="Decrease text size"
                          onClick={() =>
                            setSettings((previous) => ({
                              ...previous,
                              textSize: Math.max(32, previous.textSize - 1),
                            }))
                          }
                          className="rounded-lg border border-zinc-300 px-2.5 py-1 text-xs font-semibold text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
                        >
                          -1
                        </button>
                        <button
                          type="button"
                          aria-label="Increase text size"
                          onClick={() =>
                            setSettings((previous) => ({
                              ...previous,
                              textSize: Math.min(180, previous.textSize + 1),
                            }))
                          }
                          className="rounded-lg border border-zinc-300 px-2.5 py-1 text-xs font-semibold text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
                        >
                          +1
                        </button>
                      </div>
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </div>

              <button
                type="button"
                onClick={() =>
                  setSettings((previous) => {
                    const order: TextAlignMode[] = ["left", "center", "right"];
                    const currentIndex = order.indexOf(previous.textAlign);
                    const nextAlign = order[(currentIndex + 1) % order.length];
                    return {
                      ...previous,
                      textAlign: nextAlign,
                    };
                  })
                }
                aria-label={`Toggle text alignment, current ${settings.textAlign}`}
                className="flex items-center justify-center gap-2 rounded-xl border border-zinc-300 px-3 py-2 text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
              >
                <span
                  className={`inline-flex h-7 w-7 items-center justify-center rounded-md transition ${
                    settings.textAlign === "left"
                      ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                      : "bg-zinc-200/70 text-zinc-500 dark:bg-zinc-800/80 dark:text-zinc-400"
                  }`}
                >
                  <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true">
                    <path
                      fill="currentColor"
                      d="M2 3h9v1.6H2V3Zm0 4.2h12v1.6H2V7.2Zm0 4.2h7v1.6H2v-1.6Z"
                    />
                  </svg>
                </span>
                <span
                  className={`inline-flex h-7 w-7 items-center justify-center rounded-md transition ${
                    settings.textAlign === "center"
                      ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                      : "bg-zinc-200/70 text-zinc-500 dark:bg-zinc-800/80 dark:text-zinc-400"
                  }`}
                >
                  <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true">
                    <path
                      fill="currentColor"
                      d="M3.5 3h9v1.6h-9V3ZM2 7.2h12v1.6H2V7.2Zm1.5 4.2h9v1.6h-9v-1.6Z"
                    />
                  </svg>
                </span>
                <span
                  className={`inline-flex h-7 w-7 items-center justify-center rounded-md transition ${
                    settings.textAlign === "right"
                      ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                      : "bg-zinc-200/70 text-zinc-500 dark:bg-zinc-800/80 dark:text-zinc-400"
                  }`}
                >
                  <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true">
                    <path
                      fill="currentColor"
                      d="M5 3h9v1.6H5V3ZM2 7.2h12v1.6H2V7.2Zm5 4.2h7v1.6H7v-1.6Z"
                    />
                  </svg>
                </span>
              </button>

              <button
                type="button"
                onClick={() =>
                  setSettings((previous) => ({
                    ...previous,
                    showGuideMarker: !previous.showGuideMarker,
                  }))
                }
                aria-label={`Toggle guide marker, currently ${
                  settings.showGuideMarker ? "on" : "off"
                }`}
                className={`inline-flex h-[42px] items-center justify-center rounded-xl border px-3 py-2 text-zinc-700 transition hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-900 ${
                  settings.showGuideMarker
                    ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                    : "border-zinc-300 dark:border-zinc-700"
                }`}
              >
                <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true">
                  <path
                    fill="currentColor"
                    d="M2 8.8h12V10H2V8.8Zm0-2.8h12v1.2H2V6Z"
                  />
                  {settings.showGuideMarker ? (
                    <circle cx="8" cy="4" r="1.2" fill="currentColor" />
                  ) : (
                    <path
                      fill="currentColor"
                      d="M3.2 3.6l.84-.84L12.8 11.5l-.84.84L3.2 3.6Z"
                    />
                  )}
                </svg>
              </button>
            </section>

            {error ? (
              <div className="rounded-xl border border-rose-300 bg-rose-100 px-4 py-2 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200">
                {error}
              </div>
            ) : null}

            <PromptViewport
              lines={viewportConfig.lines}
              currentLineIndexInWindow={Math.max(
                0,
                Math.min(viewportConfig.lines.length - 1, Math.floor(viewportConfig.lineProgressInWindow)),
              )}
              currentTokenIndex={Math.floor(smoothedTokenIndex)}
              frozen={playbackFrozen}
              speechLevel={speechLevel}
              lineProgressInWindow={viewportConfig.lineProgressInWindow}
              anchorRow={viewportConfig.anchorRow}
              maxVisibleRows={DEFAULT_MAX_LINES}
              textSize={settings.textSize}
              textAlign={settings.textAlign}
              showGuideMarker={settings.showGuideMarker}
              className="flex-1"
            />

            <section className="rounded-2xl border border-zinc-200/90 bg-white/90 p-4 dark:border-zinc-800 dark:bg-zinc-950/90">
              <h2 className="mb-2 text-sm font-semibold text-zinc-700 dark:text-zinc-200">
                Rolling transcript (last ~10s)
              </h2>
              <p className="min-h-16 text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                {rollingWindow || latestTranscript || "Listening..."}
              </p>
            </section>
          </section>
        </motion.main>
      )}
      </AnimatePresence>
      <AnimatePresence>
        {isShortcutsOpen ? (
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Keyboard shortcuts"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16, ease: "easeOut" }}
            className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 p-4 pt-[12vh] backdrop-blur-sm"
            onClick={() => setIsShortcutsOpen(false)}
          >
            <motion.div
              initial={{ opacity: 0, y: 16, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 14, scale: 0.985 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className="w-full max-w-2xl overflow-hidden rounded-2xl border border-zinc-700/80 bg-[#151515]/95 shadow-[0_30px_80px_-28px_rgba(0,0,0,0.72)] ring-1 ring-white/10"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="border-b border-zinc-700/80 bg-linear-to-b from-zinc-800/90 to-zinc-900/90 px-5 py-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-400">
                  Command Center
                </p>
                <h2 className="mt-1 text-lg font-semibold tracking-tight text-zinc-100">
                  Keyboard Shortcuts
                </h2>
                <p className="mt-1 text-sm text-zinc-400">
                  Quick controls for your teleprompter workflow.
                </p>
              </div>

              <div className="divide-y divide-zinc-800/80">
                {KEYBOARD_SHORTCUTS.map((shortcut) => (
                  <div
                    key={shortcut.key}
                    className="flex items-center justify-between gap-3 px-5 py-3.5 transition hover:bg-zinc-800/70"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-zinc-100">{shortcut.action}</p>
                      <p className="mt-0.5 text-xs text-zinc-400">{shortcut.context}</p>
                    </div>
                    <kbd className="rounded-md border border-zinc-600/80 bg-zinc-800/90 px-2.5 py-1 text-xs font-semibold text-zinc-200">
                      {shortcut.key}
                    </kbd>
                  </div>
                ))}
              </div>

              <div className="border-t border-zinc-700/80 px-5 py-3 text-xs text-zinc-400">
                Press <kbd className="rounded border border-zinc-600 px-1.5 py-0.5 text-zinc-200">Esc</kbd> to
                close
              </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}
