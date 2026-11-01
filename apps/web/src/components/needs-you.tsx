/**
 * What waits on the viewer has one name everywhere, "Needs you", and one mark: the signal, as
 * for whatever needs a person (#613). The dot carries a halo so it is told apart from the plain
 * signal dot of changes requested.
 */
export function NeedsYouDot() {
  return (
    <span
      aria-hidden="true"
      className="inline-block size-[7px] shrink-0 rounded-full bg-signal ring-[3px] ring-signal/25"
    />
  );
}

/** A count of reviews waiting on the viewer, as a card or a row carries it. */
export function NeedsYou({ count }: { count: number }) {
  return (
    <span
      title={`${count} review${count === 1 ? "" : "s"} waiting on you`}
      className="tabular inline-flex shrink-0 items-center gap-1.5 rounded-full bg-signal px-2 text-[12px] leading-[20px] font-medium whitespace-nowrap text-ground"
    >
      Needs you
      <span>{count}</span>
    </span>
  );
}
