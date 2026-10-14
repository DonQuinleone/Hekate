import * as TabsPrimitive from "@radix-ui/react-tabs";
import type { ComponentProps } from "react";
import { cn } from "~/lib/cn";

export const Tabs = TabsPrimitive.Root;
export const TabsContent = TabsPrimitive.Content;

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn("flex h-11 items-stretch gap-0.5 border-b border-hairline", className)}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        "-mb-px inline-flex cursor-pointer items-center gap-1.5 border-b border-transparent px-2 text-[13px] font-medium text-ink-3 hover:text-ink-2 data-[state=active]:border-ink data-[state=active]:text-ink",
        className,
      )}
      {...props}
    />
  );
}
