import type { FollowInput } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { followsQuery, useFollow, useUnfollow } from "~/lib/queries";
import { Icon } from "./icons";
import { Button } from "./ui/button";

/** What following tells you about. */
const told = {
  track: "told when a new version arrives",
  review: "told when someone decides, gives feedback or opens it as a guest",
};

/**
 * Following a track or a review by choice (#110), until you stop. Making a track or adding its
 * versions already follows it, and whoever asked for a review is told anyway; this is for
 * everyone else who wants to keep up, as GitHub's Watch and Linear's Subscribe are.
 */
export function FollowButton({ target, what }: { target: FollowInput; what: "track" | "review" }) {
  const { data: follows } = useQuery(followsQuery);
  const follow = useFollow();
  const unfollow = useUnfollow();
  // Until the follows load, the button holds its place, so the header does not move.
  const mine = follows?.find((f) =>
    "trackId" in target ? f.trackId === target.trackId : f.reviewId === target.reviewId,
  );
  const busy = follow.isPending || unfollow.isPending;
  return (
    <Button
      variant="ghost"
      size="sm"
      // Pressed reads on its own, as on a phone there is no word to say so.
      className="aria-pressed:bg-raised aria-pressed:text-ink"
      aria-pressed={Boolean(mine)}
      title={mine ? `You are ${told[what]}. Click to stop.` : `Be ${told[what]}`}
      disabled={!follows || busy}
      onClick={() => (mine ? unfollow.mutate(mine.id) : follow.mutate(target))}
    >
      <Icon name="bell" size={14} />
      {/* On a phone the bell alone, so the page's primary action stays in view. */}
      <span className="sr-only @md/app:not-sr-only">{mine ? "Following" : "Follow"}</span>
    </Button>
  );
}
