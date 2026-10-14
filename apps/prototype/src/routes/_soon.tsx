import { usePageHeader } from "~/components/page-header";

/** A screen that is in the inventory but not yet in this round. */
export function Soon({ title, round }: { title: string; round: 2 | 3 }) {
  usePageHeader({ title });
  return (
    <div className="mx-auto max-w-md px-6 py-16">
      <p className="label">Round {round}</p>
      <h2 className="m-0 mt-1 text-[15px] font-medium">{title}</h2>
      <p className="text-ink-2">This screen is in the inventory and comes in round {round}.</p>
    </div>
  );
}
