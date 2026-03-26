import type { ReactNode, RefObject } from "react";
import { AnimatePresence, motion } from "framer-motion";

import { StepperButton } from "@/components/teleprompter/TeleprompterPrimitives";

type RangeSettingPopoverProps = {
  rootRef: RefObject<HTMLDivElement | null>;
  triggerLabel: string;
  triggerIcon?: ReactNode;
  compact?: boolean;
  triggerAriaLabel: string;
  popoverId: string;
  popoverLabel: string;
  value: number;
  valueDisplay: string;
  min: number;
  max: number;
  isOpen: boolean;
  onToggle: () => void;
  onRangeChange: (value: number) => void;
  onStepDown: () => void;
  onStepUp: () => void;
  decreaseAriaLabel: string;
  increaseAriaLabel: string;
};

export function RangeSettingPopover({
  rootRef,
  triggerLabel,
  triggerIcon,
  compact = false,
  triggerAriaLabel,
  popoverId,
  popoverLabel,
  value,
  valueDisplay,
  min,
  max,
  isOpen,
  onToggle,
  onRangeChange,
  onStepDown,
  onStepUp,
  decreaseAriaLabel,
  increaseAriaLabel,
}: RangeSettingPopoverProps) {
  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label={triggerAriaLabel}
        aria-expanded={isOpen}
        aria-controls={popoverId}
        onClick={onToggle}
        className={
          compact
            ? `flex h-9 w-9 items-center justify-center rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500/50 ${
                isOpen
                  ? "bg-zinc-700/80 text-zinc-100"
                  : "text-zinc-400 hover:bg-zinc-800/80 hover:text-zinc-100"
              }`
            : "group flex w-full items-center justify-between rounded-xl border border-zinc-600/70 bg-zinc-800/60 px-3 py-2 text-left transition hover:border-zinc-500/80 hover:bg-zinc-800/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500/50"
        }
      >
        {compact ? (
          triggerIcon
        ) : (
          <>
            <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">
              {triggerIcon}
              {triggerLabel}
            </span>
            <motion.span
              key={value}
              initial={{ opacity: 0, y: 4, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="text-sm font-semibold text-zinc-100"
            >
              {valueDisplay}
            </motion.span>
          </>
        )}
      </button>

      <AnimatePresence>
        {isOpen ? (
          <motion.div
            id={popoverId}
            initial={{ opacity: 0, y: 8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className={
              compact
                ? "absolute left-1/2 z-30 mt-2 w-52 -translate-x-1/2 rounded-2xl border border-zinc-700/80 bg-[#151515]/95 p-3 shadow-[0_18px_40px_-24px_rgba(0,0,0,0.6)] ring-1 ring-white/6 backdrop-blur"
                : "absolute left-0 right-0 z-30 mt-2 rounded-2xl border border-zinc-700/80 bg-[#151515]/95 p-3 shadow-[0_18px_40px_-24px_rgba(0,0,0,0.6)] ring-1 ring-white/6 backdrop-blur"
            }
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">
                {popoverLabel}
              </span>
              <span className="text-sm font-semibold text-zinc-100">{valueDisplay}</span>
            </div>
            <input
              autoFocus
              type="range"
              min={min}
              max={max}
              step={1}
              value={value}
              onChange={(event) => onRangeChange(Number(event.target.value))}
              className="w-full"
            />
            <div className="mt-3 flex items-center justify-between">
              <StepperButton aria-label={decreaseAriaLabel} onClick={onStepDown}>
                -1
              </StepperButton>
              <StepperButton aria-label={increaseAriaLabel} onClick={onStepUp}>
                +1
              </StepperButton>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
