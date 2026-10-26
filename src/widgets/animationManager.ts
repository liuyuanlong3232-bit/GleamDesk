import type { CSSProperties } from "react";

export type WidgetAnimationPhase = "enter" | "exit" | "expand" | "collapse" | "refresh" | "error";

const phases: WidgetAnimationPhase[] = ["enter", "exit", "expand", "collapse", "refresh", "error"];

/** Shared motion tokens and phase classes for dashboard widgets and desktop controls. */
export class WidgetAnimationManager {
  readonly duration = 180;
  readonly easing = "cubic-bezier(.2,.8,.2,1)";

  constructor(readonly enabled: boolean) {}

  classFor(phase: WidgetAnimationPhase) {
    return this.enabled && phases.includes(phase) ? `widget-motion widget-motion-${phase}` : "";
  }

  style(): CSSProperties {
    return {
      "--widget-motion-duration": `${this.duration}ms`,
      "--widget-motion-easing": this.easing,
    } as CSSProperties;
  }

  play(element: HTMLElement, phase: WidgetAnimationPhase) {
    if (!this.enabled || typeof element.animate !== "function") return undefined;
    const keyframes: Record<WidgetAnimationPhase, Keyframe[]> = {
      enter: [{ opacity: 0, transform: "translateY(5px) scale(.992)" }, { opacity: 1, transform: "translateY(0) scale(1)" }],
      exit: [{ opacity: 1, transform: "translateY(0) scale(1)" }, { opacity: 0, transform: "translateY(3px) scale(.994)" }],
      expand: [{ transform: "scale(.985)" }, { transform: "scale(1)" }],
      collapse: [{ opacity: 0.8 }, { opacity: 1 }],
      refresh: [{ opacity: 0.92 }, { opacity: 1 }],
      error: [{ borderColor: "rgba(255, 99, 99, .55)", boxShadow: "0 0 20px rgba(255, 70, 70, .12)" }, { borderColor: "var(--line)", boxShadow: "" }],
    };
    return element.animate(keyframes[phase], { duration: this.duration, easing: this.easing, fill: "none" });
  }
}

export function createWidgetAnimationManager(enabled: boolean) {
  return new WidgetAnimationManager(enabled);
}
