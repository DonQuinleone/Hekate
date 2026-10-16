import type { InputHTMLAttributes } from "react";
import { cn } from "~/lib/cn";

/**
 * A value along a range: a level, a position. The track and thumb come from the tokens
 * (`.hk-slider` in app.css); the native input stays for keyboard and assistive technology.
 */
export function Slider({
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  return <input type="range" className={cn("hk-slider", className)} {...props} />;
}
