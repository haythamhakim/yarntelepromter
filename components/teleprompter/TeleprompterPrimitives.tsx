import type { ComponentPropsWithoutRef, ReactNode } from "react";

type SurfacePanelProps = {
  children: ReactNode;
  className?: string;
};

const BASE_SURFACE_PANEL_CLASSNAME =
  "rounded-2xl border border-zinc-700/80 bg-[#151515]/95 ring-1 ring-white/6 shadow-[0_18px_50px_-24px_rgba(0,0,0,0.55)]";

export function SurfacePanel({ children, className }: SurfacePanelProps) {
  return <section className={`${BASE_SURFACE_PANEL_CLASSNAME} ${className ?? ""}`.trim()}>{children}</section>;
}

type StepperButtonProps = ComponentPropsWithoutRef<"button">;

export function StepperButton({ className, ...props }: StepperButtonProps) {
  return (
    <button
      type="button"
      className={`rounded-lg border border-zinc-600/80 bg-zinc-800/90 px-2.5 py-1 text-xs font-semibold text-zinc-200 transition hover:bg-zinc-700/80 hover:text-zinc-100 ${
        className ?? ""
      }`.trim()}
      {...props}
    />
  );
}
