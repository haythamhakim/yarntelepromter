"use client";

import { AnimatePresence, motion } from "framer-motion";
import { ALargeSmall, Gauge } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { PromptViewport } from "@/components/teleprompter/PromptViewport";
import { RangeSettingPopover } from "@/components/teleprompter/RangeSettingPopover";
import { SurfacePanel } from "@/components/teleprompter/TeleprompterPrimitives";
import { useDismissOnOutsideAndEscape } from "@/hooks/useDismissOnOutsideAndEscape";
import { useOpenAIRealtime } from "@/hooks/useOpenAIRealtime";
import { useSmoothTeleprompterPlayback } from "@/hooks/useSmoothTeleprompterPlayback";
import { collectRollingWindow } from "@/lib/realtime/events";
import {
  DEFAULT_MAX_LINES,
  getWordsPerLineForTextSize,
  getLineProgressForToken,
  prepareScript,
} from "@/lib/teleprompter/script";
import {
  advanceCursorFromTranscript,
  buildAlignmentCandidates,
  resolveAlignmentDecision,
} from "@/lib/teleprompter/semanticAligner";
import {
  DEFAULT_SETTINGS,
  limitToRange,
  parseSettings,
  SETTINGS_STORAGE_KEY,
  SPEED_MAX,
  SPEED_MIN,
  TEXT_SIZE_MAX,
  TEXT_SIZE_MIN,
  type TeleprompterSettings,
  type TextAlignMode,
} from "@/lib/teleprompter/settings";

const DEFAULT_SCRIPT_INTRO = `Welcome to your AI teleprompter.
Speak naturally while reading.
If you skip words, the prompter should still keep pace.
If you go off-script, it pauses until alignment recovers.
When you come back on track, it scrolls forward smoothly.`;

const DEFAULT_SCRIPT_PRACTICE = `Good morning, everyone.
Today I will walk you through the project update.
First, we improved reliability across the platform.
Second, we reduced response times in key workflows.
Finally, we are preparing the rollout for all teams next week.`;

const DEFAULT_SCRIPT_STORY = `Let me tell you a quick story.
Last year we tried a bold experiment with a tiny team.
The first version was rough, but users kept returning.
We listened closely, improved every week, and earned trust.
Now we are ready to scale what works.`;

const DEFAULT_SCRIPT_LONG = `Good morning, everyone.
Today I will walk you through the project update.
First, we improved reliability across the platform.
Second, we reduced response times in key workflows.
Finally, we are preparing the rollout for all teams next week.
Let me tell you a quick story.
Last year we tried a bold experiment with a tiny team.
The first version was rough, but users kept returning.
We listened closely, improved every week, and earned trust.
Now we are ready to scale what works.`;

const SCRIPT_STORY_VERY_LONG = `Let me tell you a quick story.
Last year we tried a bold experiment with a tiny team.
The first version was rough, but users kept returning.
We listened closely, improved every week, and earned trust.
Now we are ready to scale what works.`;

const DEFAULT_SCRIPTS = [
  DEFAULT_SCRIPT_INTRO,
  DEFAULT_SCRIPT_PRACTICE,
  DEFAULT_SCRIPT_STORY,
  DEFAULT_SCRIPT_LONG,
  SCRIPT_STORY_VERY_LONG,
];

const getRandomDefaultScript = () =>
  DEFAULT_SCRIPTS[Math.floor(Math.random() * DEFAULT_SCRIPTS.length)] ??
  DEFAULT_SCRIPT_INTRO;

type Mode = "compose" | "readback";

type KeyboardShortcut = {
  key: string;
  action: string;
  context: string;
};

const KEYBOARD_SHORTCUTS: KeyboardShortcut[] = [
  { key: "Space", action: "Play / pause", context: "Readback mode" },
  { key: "ArrowUp", action: "Increase text size", context: "Readback mode" },
  { key: "ArrowDown", action: "Decrease text size", context: "Readback mode" },
  { key: "Esc", action: "Close shortcuts", context: "When modal is open" },
];

export function TeleprompterApp() {
  const [mode, setMode] = useState<Mode>("compose");
  const [scriptInput, setScriptInput] = useState(() =>
    getRandomDefaultScript(),
  );
  const [cursorTokenIndex, setCursorTokenIndex] = useState(0);
  const [speechScrollTokenIndex, setSpeechScrollTokenIndex] = useState(0);
  const [isPlaybackPaused, setIsPlaybackPaused] = useState(false);
  const [readbackSettled, setReadbackSettled] = useState(false);
  const [isFrozen, setIsFrozen] = useState(false);
  const [isRealtimeStalled, setIsRealtimeStalled] = useState(false);
  const [, setAlignmentConfidence] = useState(0);
  const [settings, setSettings] =
    useState<TeleprompterSettings>(DEFAULT_SETTINGS);
  const [isSpeedControlOpen, setIsSpeedControlOpen] = useState(false);
  const [isTextSizeControlOpen, setIsTextSizeControlOpen] = useState(false);
  const [isShortcutsOpen, setIsShortcutsOpen] = useState(false);
  const [textSizeShortcutToast, setTextSizeShortcutToast] = useState<
    number | null
  >(null);

  const alignInFlightRef = useRef(false);
  const lastAlignedAtRef = useRef(0);
  const speedControlRef = useRef<HTMLDivElement | null>(null);
  const textSizeControlRef = useRef<HTMLDivElement | null>(null);
  const textSizeToastTimeoutRef = useRef<number | null>(null);

  const {
    status,
    error,
    updates,
    mediaStream,
    start,
    stop,
    requestSemanticAlignment,
  } = useOpenAIRealtime();

  const wordsPerLine = useMemo(
    () => getWordsPerLineForTextSize(settings.textSize),
    [settings.textSize],
  );
  const prepared = useMemo(
    () => prepareScript(scriptInput, wordsPerLine),
    [scriptInput, wordsPerLine],
  );
  const rollingWindow = useMemo(
    () => collectRollingWindow(updates, 10_000),
    [updates],
  );
  const maxTokenIndex = Math.max(0, prepared.tokens.length - 1);
  const playbackFrozen =
    isFrozen || isRealtimeStalled || isPlaybackPaused || status !== "connected";
  const smoothedTokenIndex = useSmoothTeleprompterPlayback({
    targetTokenIndex: speechScrollTokenIndex,
    maxTokenIndex,
    speed: settings.speed,
    isPlaying:
      mode === "readback" && status === "connected" && !isPlaybackPaused,
    frozen: playbackFrozen,
  });
  const lineProgress = useMemo(
    () => getLineProgressForToken(prepared.lines, smoothedTokenIndex),
    [prepared.lines, smoothedTokenIndex],
  );

  useEffect(() => {
    setSpeechScrollTokenIndex((previous) =>
      limitToRange(previous, 0, maxTokenIndex),
    );
  }, [maxTokenIndex]);

  // Hold the display at position 0 for a beat so the text is stable and
  // fully visible before scrolling begins.
  useEffect(() => {
    if (mode !== "readback") {
      setReadbackSettled(false);
      return;
    }
    const timer = window.setTimeout(() => setReadbackSettled(true), 1000);
    return () => window.clearTimeout(timer);
  }, [mode]);

  useEffect(() => {
    if (mode !== "readback" || isPlaybackPaused || !readbackSettled) {
      return;
    }
    setSpeechScrollTokenIndex(cursorTokenIndex);
  }, [cursorTokenIndex, isPlaybackPaused, mode, readbackSettled]);

  const latestTranscript = updates[updates.length - 1]?.text ?? "";
  const closeSpeedControl = useCallback(() => {
    setIsSpeedControlOpen(false);
  }, []);

  const closeTextSizeControl = useCallback(() => {
    setIsTextSizeControlOpen(false);
  }, []);

  const showTextSizeShortcutToast = useCallback((nextTextSize: number) => {
    setTextSizeShortcutToast(nextTextSize);
    if (textSizeToastTimeoutRef.current !== null) {
      window.clearTimeout(textSizeToastTimeoutRef.current);
    }
    textSizeToastTimeoutRef.current = window.setTimeout(() => {
      setTextSizeShortcutToast(null);
      textSizeToastTimeoutRef.current = null;
    }, 900);
  }, []);

  useDismissOnOutsideAndEscape({
    isOpen: isSpeedControlOpen,
    containerRef: speedControlRef,
    onDismiss: closeSpeedControl,
  });

  useDismissOnOutsideAndEscape({
    isOpen: isTextSizeControlOpen,
    containerRef: textSizeControlRef,
    onDismiss: closeTextSizeControl,
  });

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

    const candidates = buildAlignmentCandidates(
      prepared.chunks,
      cursorTokenIndex,
      4,
    );
    if (candidates.length === 0) {
      return;
    }

    alignInFlightRef.current = true;
    lastAlignedAtRef.current = now;

    try {
      const modelResponse = await requestSemanticAlignment(
        rollingWindow,
        candidates,
      );
      const decision = resolveAlignmentDecision({
        currentTokenIndex: cursorTokenIndex,
        transcriptWindow: rollingWindow,
        candidates,
        modelResponse,
        scriptTokens: prepared.tokens,
      });

      setAlignmentConfidence(decision.confidence);
      setIsFrozen(decision.freeze);

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
    setSpeechScrollTokenIndex(0);
    setIsPlaybackPaused(false);
    setAlignmentConfidence(0);
    setIsFrozen(false);
    setMode("readback");
    await start();
  };

  const onBackToEditor = () => {
    stop();
    setSpeechScrollTokenIndex(0);
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
      setSettings(parseSettings(raw));
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
        let nextTextSize = settings.textSize;
        setSettings((previous) => ({
          ...previous,
          textSize: (nextTextSize = limitToRange(
            previous.textSize + 1,
            TEXT_SIZE_MIN,
            TEXT_SIZE_MAX,
          )),
        }));
        showTextSizeShortcutToast(nextTextSize);
        return;
      }

      if (event.code === "ArrowDown") {
        event.preventDefault();
        let nextTextSize = settings.textSize;
        setSettings((previous) => ({
          ...previous,
          textSize: (nextTextSize = limitToRange(
            previous.textSize - 1,
            TEXT_SIZE_MIN,
            TEXT_SIZE_MAX,
          )),
        }));
        showTextSizeShortcutToast(nextTextSize);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mode, settings.textSize, showTextSizeShortcutToast, togglePlayback]);

  useEffect(() => {
    return () => {
      if (textSizeToastTimeoutRef.current !== null) {
        window.clearTimeout(textSizeToastTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && isShortcutsOpen) {
        event.preventDefault();
        setIsShortcutsOpen(false);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isShortcutsOpen]);

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
            className="flex flex-col min-h-screen w-full items-center justify-center px-6 py-10 "
          >
            <section className="w-full max-w-4xl overflow-hidden rounded-2xl border border-zinc-700/80 bg-[#151515]/95 shadow-[0_30px_80px_-28px_rgba(0,0,0,0.72)] ring-1 ring-white/10">
              <header className="border-b border-zinc-700/80 bg-linear-to-b from-zinc-800/90 to-zinc-900/90 px-8 py-6 text-center">
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-400">
                  AI Teleprompter
                </p>
                <h1 className="mt-1.5 text-2xl font-semibold tracking-tight text-zinc-100 md:text-3xl">
                  Script Editor
                </h1>
              </header>

              <div className="p-6">
                <label
                  htmlFor="script-input"
                  className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-400"
                >
                  Script
                </label>
                <textarea
                  id="script-input"
                  value={scriptInput}
                  onChange={(event) => setScriptInput(event.target.value)}
                  className="min-h-[340px] w-full resize-y rounded-xl border border-zinc-700/60 bg-[#0E0E0E] p-5 text-[15px] leading-7 text-zinc-100 outline-none transition placeholder:text-zinc-500 focus:border-zinc-500/80 focus:ring-2 focus:ring-zinc-600/40"
                  placeholder="Write or paste your script..."
                />

                <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
                  <button
                    type="button"
                    onClick={onStartReadback}
                    disabled={!scriptInput.trim() || status === "connecting"}
                    className="rounded-full bg-zinc-100 px-6 py-2.5 text-sm font-medium text-zinc-900 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {status === "connecting"
                      ? "Connecting..."
                      : "Read Back Script"}
                  </button>
                </div>
              </div>
            </section>
            <button
              type="button"
              onClick={() => setIsShortcutsOpen(true)}
              className="rounded-full mt-10 border border-zinc-600/80 bg-zinc-800/90 px-5 py-2.5 text-sm font-medium text-zinc-200 transition hover:bg-zinc-700/80 hover:text-zinc-100"
            >
              Shortcuts
            </button>
          </motion.main>
        ) : (
          <motion.main
            key="readback"
            initial={false}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 1.01 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
            className="fixed inset-0 z-20 flex min-h-screen w-full flex-col bg-[#0A0A0A] px-5 py-5"
          >
            <header className="mx-auto flex w-full max-w-7xl items-center justify-between gap-3 px-4 py-3">
              <button
                type="button"
                onClick={onBackToEditor}
                className="flex h-9 w-9 items-center justify-center rounded-full text-zinc-400 transition hover:bg-zinc-800/80 hover:text-zinc-100"
                aria-label="Back to editor"
              >
                <svg
                  viewBox="0 0 20 20"
                  className="h-5 w-5"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path
                    fillRule="evenodd"
                    d="M12.79 5.23a.75.75 0 01-.02 1.06L8.832 10l3.938 3.71a.75.75 0 11-1.04 1.08l-4.5-4.25a.75.75 0 010-1.08l4.5-4.25a.75.75 0 011.06.02z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>

              <div className="flex items-center gap-1">
                <div className="relative">
                  <AnimatePresence>
                    {textSizeShortcutToast !== null ? (
                      <motion.div
                        key={textSizeShortcutToast}
                        initial={{ opacity: 0, y: 7, scale: 0.95 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 5, scale: 0.97 }}
                        transition={{ duration: 0.18, ease: "easeOut" }}
                        className="pointer-events-none absolute -top-11 left-1/2 z-40 -translate-x-1/2 rounded-full border border-zinc-600/80 bg-zinc-900/95 px-2.5 py-1 text-xs font-semibold text-zinc-100 shadow-lg ring-1 ring-white/10"
                      >
                        {textSizeShortcutToast}px
                      </motion.div>
                    ) : null}
                  </AnimatePresence>
                  <RangeSettingPopover
                    rootRef={speedControlRef}
                    triggerLabel="Speed"
                    triggerIcon={<Gauge className="h-[20px] w-[20px]" aria-hidden="true" />}
                    compact
                    triggerAriaLabel={`Set speed, current ${settings.speed}`}
                    popoverId="speed-control-popover"
                    popoverLabel="Speed"
                    value={settings.speed}
                    valueDisplay={String(settings.speed)}
                    min={SPEED_MIN}
                    max={SPEED_MAX}
                    isOpen={isSpeedControlOpen}
                    onToggle={() => {
                      setIsTextSizeControlOpen(false);
                      setIsSpeedControlOpen((open) => !open);
                    }}
                    onRangeChange={(value) =>
                      setSettings((previous) => ({
                        ...previous,
                        speed: limitToRange(value, SPEED_MIN, SPEED_MAX),
                      }))
                    }
                    onStepDown={() =>
                      setSettings((previous) => ({
                        ...previous,
                        speed: limitToRange(
                          previous.speed - 1,
                          SPEED_MIN,
                          SPEED_MAX,
                        ),
                      }))
                    }
                    onStepUp={() =>
                      setSettings((previous) => ({
                        ...previous,
                        speed: limitToRange(
                          previous.speed + 1,
                          SPEED_MIN,
                          SPEED_MAX,
                        ),
                      }))
                    }
                    decreaseAriaLabel="Decrease speed"
                    increaseAriaLabel="Increase speed"
                  />
                </div>

                <button
                  type="button"
                  aria-label="Play or Pause"
                  onClick={() => void togglePlayback()}
                  disabled={status === "connecting"}
                  className="flex h-10 w-10 items-center justify-center rounded-full bg-zinc-100 text-zinc-900 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
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

                <div className="relative">
                  <RangeSettingPopover
                    rootRef={textSizeControlRef}
                    triggerLabel="Text size"
                    triggerIcon={
                      <ALargeSmall className="h-[20px] w-[20px]" aria-hidden="true" />
                    }
                    compact
                    triggerAriaLabel={`Set text size, current ${settings.textSize}`}
                    popoverId="text-size-control-popover"
                    popoverLabel="Text size"
                    value={settings.textSize}
                    valueDisplay={`${settings.textSize}px`}
                    min={TEXT_SIZE_MIN}
                    max={TEXT_SIZE_MAX}
                    isOpen={isTextSizeControlOpen}
                    onToggle={() => {
                      setIsSpeedControlOpen(false);
                      setIsTextSizeControlOpen((open) => !open);
                    }}
                    onRangeChange={(value) =>
                      setSettings((previous) => ({
                        ...previous,
                        textSize: limitToRange(value, TEXT_SIZE_MIN, TEXT_SIZE_MAX),
                      }))
                    }
                    onStepDown={() =>
                      setSettings((previous) => ({
                        ...previous,
                        textSize: limitToRange(
                          previous.textSize - 1,
                          TEXT_SIZE_MIN,
                          TEXT_SIZE_MAX,
                        ),
                      }))
                    }
                    onStepUp={() =>
                      setSettings((previous) => ({
                        ...previous,
                        textSize: limitToRange(
                          previous.textSize + 1,
                          TEXT_SIZE_MIN,
                          TEXT_SIZE_MAX,
                        ),
                      }))
                    }
                    decreaseAriaLabel="Decrease text size"
                    increaseAriaLabel="Increase text size"
                  />
                </div>
              </div>

              <button
                type="button"
                onClick={() =>
                  setSettings((previous) => {
                    const order: TextAlignMode[] = ["left", "center", "right"];
                    const currentIndex = order.indexOf(previous.textAlign);
                    const nextAlign = order[(currentIndex + 1) % order.length];
                    return { ...previous, textAlign: nextAlign };
                  })
                }
                aria-label={`Toggle text alignment, current ${settings.textAlign}`}
                className="flex h-9 w-9 items-center justify-center rounded-full text-zinc-400 transition hover:bg-zinc-800/80 hover:text-zinc-100"
              >
                {settings.textAlign === "left" ? (
                  <svg
                    viewBox="0 0 16 16"
                    className="h-[18px] w-[18px]"
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <path d="M2 3h9v1.6H2V3Zm0 4.2h12v1.6H2V7.2Zm0 4.2h7v1.6H2v-1.6Z" />
                  </svg>
                ) : settings.textAlign === "center" ? (
                  <svg
                    viewBox="0 0 16 16"
                    className="h-[18px] w-[18px]"
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <path d="M3.5 3h9v1.6h-9V3ZM2 7.2h12v1.6H2V7.2Zm1.5 4.2h9v1.6h-9v-1.6Z" />
                  </svg>
                ) : (
                  <svg
                    viewBox="0 0 16 16"
                    className="h-[18px] w-[18px]"
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <path d="M5 3h9v1.6H5V3ZM2 7.2h12v1.6H2V7.2Zm5 4.2h7v1.6H7v-1.6Z" />
                  </svg>
                )}
              </button>
            </header>

            <section className="mx-auto mt-4 flex w-full max-w-7xl flex-1 flex-col gap-4 overflow-hidden">
              {error ? (
                <div className="rounded-xl border border-rose-800/60 bg-rose-950/40 px-4 py-2 text-sm text-rose-200">
                  {error}
                </div>
              ) : null}

              <PromptViewport
                lines={prepared.lines}
                currentLineProgress={lineProgress}
                spokenTokenIndex={Math.floor(cursorTokenIndex)}
                frozen={playbackFrozen}
                mediaStream={mediaStream}
                maxVisibleRows={DEFAULT_MAX_LINES}
                textSize={settings.textSize}
                textAlign={settings.textAlign}
                className="flex-1"
              />

              <SurfacePanel className="p-4">
                <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-400">
                  Rolling transcript (last ~10s)
                </h2>
                <p className="min-h-16 text-sm leading-6 text-zinc-300">
                  {rollingWindow || latestTranscript || "Listening..."}
                </p>
              </SurfacePanel>
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
                      <p className="text-sm font-medium text-zinc-100">
                        {shortcut.action}
                      </p>
                      <p className="mt-0.5 text-xs text-zinc-400">
                        {shortcut.context}
                      </p>
                    </div>
                    <kbd className="rounded-md border border-zinc-600/80 bg-zinc-800/90 px-2.5 py-1 text-xs font-semibold text-zinc-200">
                      {shortcut.key}
                    </kbd>
                  </div>
                ))}
              </div>

              <div className="border-t border-zinc-700/80 px-5 py-3 text-xs text-zinc-400">
                Press{" "}
                <kbd className="rounded border border-zinc-600 px-1.5 py-0.5 text-zinc-200">
                  Esc
                </kbd>{" "}
                to close
              </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}
