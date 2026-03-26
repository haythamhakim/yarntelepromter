"use client";

import {
  limitToRange,
  SPEED_MAX,
  SPEED_MIN,
} from "@/lib/teleprompter/settings";
import { useEffect, useRef, useState } from "react";

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
      const elapsedSeconds = Math.min(
        0.066,
        (now - lastFrameAtRef.current) / 1000,
      );
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
      if (gap <= 0.00001) {
        if (smoothedRef.current !== target) {
          smoothedRef.current = target;
          setSmoothedTokenIndex(target);
        }
        rafRef.current = window.requestAnimationFrame(tick);
        return;
      }

      const normalizedSpeed = limitToRange(
        speedRef.current,
        SPEED_MIN,
        SPEED_MAX,
      );
      const speedRatio =
        (normalizedSpeed - SPEED_MIN) / Math.max(1, SPEED_MAX - SPEED_MIN);
      const minTokensPerSecond = 0.9;
      const maxTokensPerSecond = 10.5;
      const baseTokensPerSecond =
        minTokensPerSecond +
        (maxTokensPerSecond - minTokensPerSecond) * speedRatio;
      // Avoid easing-to-stop near the target to prevent micro-pauses.
      const catchUpMultiplier = 1 + Math.min(3.5, gap * 2.2);
      const step = baseTokensPerSecond * catchUpMultiplier * elapsedSeconds;
      const next = limitToRange(
        smoothedRef.current + Math.min(gap, step),
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
