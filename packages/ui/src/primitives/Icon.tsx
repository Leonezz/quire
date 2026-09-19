import type { LucideIcon, LucideProps } from "lucide-react";
import { cx } from "../cx";

/** The three sizes a glyph is drawn at; the pixel values live in tokens.css (--icon-sm / md / lg). */
export type IconSize = "sm" | "md" | "lg";

/** Stroke weight in screen pixels at every size (mirrors --icon-stroke in tokens.css). */
export const ICON_STROKE = 1.75;

const sizeClass: Record<IconSize, string> = { sm: "size-icon-sm", md: "size-icon-md", lg: "size-icon-lg" };

export interface IconProps extends Omit<LucideProps, "size" | "strokeWidth" | "absoluteStrokeWidth" | "nonScalingStroke" | "role" | "aria-hidden" | "aria-label" | "ref"> {
  /** The lucide component to draw. */
  of: LucideIcon;
  /** `sm` inline in text (chevrons, chips, status marks), `md` in buttons and rows, `lg` in empty states. */
  size?: IconSize | undefined;
  /** Names the glyph for assistive tech (role="img"); without it the icon is decorative and hidden. */
  label?: string | undefined;
}

/**
 * A lucide glyph on the icon scale: its size comes from the scale, never from the call site, and its
 * stroke keeps the one weight on screen whatever the size (a non-scaling stroke, so a 14px chevron is not
 * drawn with a hairline). A primitive's icon slot sizes the raw glyphs it holds; an explicit <Icon size> wins.
 */
export function Icon({ of: Glyph, size = "md", label, className, ...props }: IconProps) {
  const a11y = label ? { role: "img", "aria-label": label } : { "aria-hidden": true };
  return <Glyph {...props} {...a11y} strokeWidth={ICON_STROKE} nonScalingStroke className={cx("icon", sizeClass[size], "shrink-0", className)} />;
}
