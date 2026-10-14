import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const merge = extendTailwindMerge({
  extend: { classGroups: { "font-size": [{ text: ["label"] }] } },
});

export const cn = (...inputs: ClassValue[]) => merge(clsx(inputs));
