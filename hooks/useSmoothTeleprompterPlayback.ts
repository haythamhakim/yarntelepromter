"use client";

import { useEffect, useRef, useState } from "react";

type UseSmoothTeleprompterPlaybackParams = {
  targetTokenIndex: number;
  maxTokenIndex: number;
  speed: number;
  isPlaying: boolean;
  frozen: boolean;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function useSmoothTeleprompterPlayback({
  targetTokenIndex,
  maxTokenIndex,
  speed,
  isPlaying,
  frozen,
}: UseSmoothTeleprompterPlaybackParams): number {
  const [smoothedTokenIndex, setSmoothedTokenIndex] = useState(0);
  const smoothedRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const lastFrameAtRef = useRef(0);

  useEffect(() => {
    if (!isPlaying || frozen) {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      return;
    }

    const normalizedSpeed = clamp(speed, 1, 50);
    const baseTokensPerSecond = 0.8 + normalizedSpeed * 0.08;
    const stiffness = 2.8 + normalizedSpeed * 0.08;

    const tick = (now: number) => {
      if (lastFrameAtRef.current === 0) {
        lastFrameAtRef.current = now;
      }
      const elapsedSeconds = Math.min(0.1, (now - lastFrameAtRef.current) / 1000);
      lastFrameAtRef.current = now;

      const target = clamp(targetTokenIndex, 0, Math.max(0, maxTokenIndex));
      if (target < smoothedRef.current) {
        smoothedRef.current = target;
        setSmoothedTokenIndex(target);
      }
      const gap = target - smoothedRef.current;
      if (gap <= 0.0001) {
        rafRef.current = window.requestAnimationFrame(tick);
        return;
      }

      const easedStep = gap * stiffness * elapsedSeconds;
      const baseStep = baseTokensPerSecond * elapsedSeconds;
      const next = clamp(smoothedRef.current + Math.min(gap, easedStep + baseStep), 0, target);

      smoothedRef.current = next;
      setSmoothedTokenIndex(next);
      rafRef.current = window.requestAnimationFrame(tick);
    };

    lastFrameAtRef.current = 0;
    rafRef.current = window.requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [frozen, isPlaying, maxTokenIndex, speed, targetTokenIndex]);

  return clamp(smoothedTokenIndex, 0, Math.max(0, maxTokenIndex));
}
