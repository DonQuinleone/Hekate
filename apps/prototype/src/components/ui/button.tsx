import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "~/lib/cn";

export const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-control border font-medium transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out disabled:pointer-events-none disabled:opacity-40 active:scale-[0.985]",
  {
    variants: {
      variant: {
        primary:
          "border-transparent bg-signal text-ground shadow-2 hover:bg-[var(--hk-signal-hover)] hover:shadow-[0_0_0_1px_rgb(0_0_0/0.4),0_6px_18px_-6px_var(--hk-signal-line)]",
        secondary:
          "border-line-strong bg-raised/60 text-ink shadow-1 hover:bg-raised hover:border-edge",
        ghost: "border-transparent bg-transparent text-ink-2 hover:bg-raised hover:text-ink",
        quiet: "border-transparent bg-transparent text-ink-3 hover:text-ink",
      },
      size: {
        sm: "h-7 px-2.5 text-[13px]",
        md: "h-8 px-3 text-[13px]",
        lg: "h-9 px-3.5 text-[14px]",
        icon: "size-8 p-0",
        iconSm: "size-7 p-0",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export function Button({
  className,
  variant,
  size,
  asChild,
  type = "button",
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      type={asChild ? undefined : type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
