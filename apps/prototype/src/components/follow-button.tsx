import { useState } from "react";
import { Icon } from "~/components/icons";
import { Button } from "~/components/ui/button";

/** What following tells you about. */
const told = {
  track: "told when a new version arrives",
  review: "told when someone decides, gives feedback or opens it as a guest",
};

/**
 * Following a track or a review by choice: told what happens to it, until you stop. Adding a
 * version already follows its track; the account's Following lists them all.
 */
export function FollowButton({ what }: { what: "track" | "review" }) {
  const [following, setFollowing] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      // Pressed reads on its own, as on a phone there is no word to say so.
      className="aria-pressed:bg-raised aria-pressed:text-ink"
      aria-pressed={following}
      title={following ? `You are ${told[what]}. Click to stop.` : `Be ${told[what]}`}
      onClick={() => setFollowing((f) => !f)}
    >
      <Icon name="bell" size={14} />
      {/* On a phone the bell alone, so the page's primary action stays in view. */}
      <span className="sr-only @md/app:not-sr-only">{following ? "Following" : "Follow"}</span>
    </Button>
  );
}
