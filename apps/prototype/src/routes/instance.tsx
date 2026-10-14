import { Soon } from "./_soon.tsx";

export function InstancePage({ section }: { section: string }) {
  return <Soon title={`Instance: ${section}`} round={3} />;
}
