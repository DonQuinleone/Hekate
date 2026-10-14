import { Soon } from "./_soon.tsx";

export function SettingsPage({ section }: { section: string }) {
  return <Soon title={`Organisation settings: ${section}`} round={3} />;
}
