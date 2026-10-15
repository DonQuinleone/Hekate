import type { InputHTMLAttributes, TextareaHTMLAttributes } from "react";
import { cn } from "~/lib/cn";

export const fieldClass =
  "w-full rounded-control border border-line-strong bg-ground/70 px-3 text-[14px] text-ink shadow-1 transition-colors placeholder:text-ink-3 hover:border-edge focus:border-edge-strong focus:outline-none";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(fieldClass, "h-9", className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(fieldClass, "resize-y py-2", className)} {...props} />;
}

export function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(fieldClass, "h-9 pr-8", className)} {...props} />;
}
