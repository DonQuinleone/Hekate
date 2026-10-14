import { Soon } from "./_soon.tsx";

export function AccountPage({ section }: { section: string }) {
  return (
    <Soon title={section === "appearance" ? "Appearance and preferences" : "Account"} round={3} />
  );
}
