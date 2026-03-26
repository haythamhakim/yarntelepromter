"use client";

import { useEffect, useRef, useState } from "react";
import { limitToRange, SPEED_MAX, SPEED_MIN } from "@/lib/teleprompter/settings";

type UseSmoothTeleprompterPlaybackParams = {
  targetTokenIndex: number;
  maxTokenIndex: number;
  speed: number;
  isPlaying: boolean;
  frozen: boolean;
};

export function useSmoothTeleprompterPlayback({
  targetTokenIndex,
  maxTokenIndex,
  speed,
  isPlaying,
  frozen,
}: UseSmoothTeleprompterPlaybackParams): number {
  const [smoothedTokenIndex, setSmoothedTokenIndex] = useState(0);
  const smoothedRef = useRef(0);
  const targetRef = useRef(targetTokenIndex);
  const maxTokenIndexRef = useRef(maxTokenIndex);
  const speedRef = useRef(speed);
  const rafRef = useRef<number | null>(null);
  const lastFrameAtRef = useRef(0);

  useEffect(() => {
    maxTokenIndexRef.current = maxTokenIndex;
  }, [maxTokenIndex]);

  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);

  // When the target decreases (e.g. readback restarted), snap the display
  // position back immediately so the text is always in a known-good position.
  useEffect(() => {
    targetRef.current = targetTokenIndex;
    if (targetTokenIndex < smoothedRef.current) {
      smoothedRef.current = targetTokenIndex;
      window.requestAnimationFrame(() => {
        setSmoothedTokenIndex(targetTokenIndex);
      });
    }
  }, [targetTokenIndex]);

  useEffect(() => {
    if (!isPlaying || frozen) {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      return;
    }

    const tick = (now: number) => {
      if (lastFrameAtRef.current === 0) {
        lastFrameAtRef.current = now;
      }
      const elapsedSeconds = Math.min(0.1, (now - lastFrameAtRef.current) / 1000);
      lastFrameAtRef.current = now;

      const target = limitToRange(
        targetRef.current,
        0,
        Math.max(0, maxTokenIndexRef.current),
      );

      if (target < smoothedRef.current) {
        smoothedRef.current = target;
        setSmoothedTokenIndex(target);
        rafRef.current = window.requestAnimationFrame(tick);
        return;
      }

      const gap = target - smoothedRef.current;
      if (gap <= 0.001) {
        if (smoothedRef.current !== target) {
          smoothedRef.current = target;
          setSmoothedTokenIndex(target);
        }
        rafRef.current = window.requestAnimationFrame(tick);
        return;
      }

      const normalizedSpeed = limitToRange(speedRef.current, SPEED_MIN, SPEED_MAX);
      // Keep a predictable, bounded forward velocity for line-by-line smoothness.
      const speedRatio =
        (normalizedSpeed - SPEED_MIN) / Math.max(1, SPEED_MAX - SPEED_MIN);
      const minTokensPerSecond = 0.9;
      const maxTokensPerSecond = 10;
      const tokensPerSecond =
        minTokensPerSecond +
        (maxTokensPerSecond - minTokensPerSecond) * speedRatio;
      const next = limitToRange(
        smoothedRef.current + Math.min(gap, tokensPerSecond * elapsedSeconds),
        0,
        target,
      );

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
  }, [frozen, isPlaying]);

  return limitToRange(smoothedTokenIndex, 0, Math.max(0, maxTokenIndex));
}
