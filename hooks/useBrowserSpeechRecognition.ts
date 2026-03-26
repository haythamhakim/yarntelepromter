"use client";

import type { TranscriptUpdate } from "@/lib/realtime/events";
import { useCallback, useEffect, useRef, useState } from "react";

type SpeechRecognitionResult = {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: { transcript: string; confidence: number };
};

type SpeechRecognitionResultList = {
  readonly length: number;
  [index: number]: SpeechRecognitionResult;
};

type SpeechRecognitionEvent = Event & {
  readonly results: SpeechRecognitionResultList;
  readonly resultIndex: number;
};

type SpeechRecognitionErrorEvent = Event & {
  readonly error: string;
  readonly message?: string;
};

type SpeechRecognitionInstance = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;

function getConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  return (w.SpeechRecognition ??
    w.webkitSpeechRecognition ??
    null) as SpeechRecognitionConstructor | null;
}

export function useBrowserSpeechRecognition(
  options: {
    language?: string;
    enabled?: boolean;
  } = {},
) {
  const { language = "en-US", enabled = false } = options;
  const [updates, setUpdates] = useState<TranscriptUpdate[]>([]);
  const [isSupported] = useState(() => getConstructor() !== null);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const isRunningRef = useRef(false);
  const shouldRunRef = useRef(false);

  const startRecognition = useCallback(() => {
    const Ctor = getConstructor();
    if (!Ctor || isRunningRef.current) return;

    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = language;

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      const now = Date.now();
      const batch: TranscriptUpdate[] = [];

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0]?.transcript ?? "";
        if (!transcript.trim()) continue;

        batch.push({
          id: `browser-${result.isFinal ? "final" : "partial"}-${now}-${i}`,
          text: transcript,
          kind: result.isFinal ? "final" : "partial",
          createdAt: now,
        });
      }

      if (batch.length === 0) return;

      setUpdates((prev) => {
        const next = prev.slice(-120);
        for (const update of batch) {
          const last = next[next.length - 1];
          if (update.kind === "partial" && last?.kind === "partial") {
            next[next.length - 1] = update;
          } else {
            next.push(update);
          }
        }
        return next;
      });
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (event.error === "no-speech" || event.error === "aborted") return;
      console.warn("[BrowserSpeechRecognition]", event.error);
    };

    recognition.onend = () => {
      isRunningRef.current = false;
      recognitionRef.current = null;
      if (shouldRunRef.current) {
        window.setTimeout(() => {
          if (shouldRunRef.current) startRecognition();
        }, 150);
      }
    };

    recognitionRef.current = recognition;
    isRunningRef.current = true;
    recognition.start();
  }, [language]);

  const stopRecognition = useCallback(() => {
    shouldRunRef.current = false;
    const recognition = recognitionRef.current;
    if (recognition) {
      recognition.onend = null;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.abort();
      recognitionRef.current = null;
      isRunningRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (enabled && isSupported) {
      shouldRunRef.current = true;
      startRecognition();
    } else {
      stopRecognition();
    }
    return () => stopRecognition();
  }, [enabled, isSupported, startRecognition, stopRecognition]);

  const clear = useCallback(() => setUpdates([]), []);

  return { updates, isSupported, clear };
}
