import type { ProjectProfile } from "@hekate/shared";
import { Icon, type IconName } from "~/components/icons";
import { cn } from "~/lib/cn";

export const profileIcon: Record<ProjectProfile, IconName> = {
  music: "music",
  video: "film",
  general: "file",
};

/** A project's cover: its own hue, lit from a corner, with the profile's mark. */
export function ProjectCover({
  profile,
  className,
  size = "md",
}: {
  profile: ProjectProfile;
  className?: string;
  size?: "xs" | "sm" | "md" | "lg";
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative flex shrink-0 items-center justify-center overflow-hidden text-ink shadow-2",
        size === "xs" && "size-6 rounded-[6px]",
        size === "sm" && "size-9 rounded-control",
        size === "md" && "size-11 rounded-panel",
        size === "lg" && "h-[88px] w-full rounded-t-panel-lg",
        className,
      )}
      style={{
        background: `radial-gradient(120% 90% at 20% 0%, var(--hk-cover-${profile}-lit), var(--hk-cover-${profile}-deep) 70%)`,
      }}
    >
      <span className="absolute inset-0 bg-[radial-gradient(60%_60%_at_80%_100%,var(--hk-cover-sheen),transparent)]" />
      <Icon
        name={profileIcon[profile]}
        size={size === "lg" ? 22 : size === "md" ? 18 : size === "sm" ? 15 : 12}
        className="relative opacity-90"
      />
    </span>
  );
}
