import { OrganisationName } from "~/components/organisation-name";
export function SettingsPage() {
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-2 px-4 py-8 sm:px-8">
      <OrganisationName />
      <h1 className="m-0 text-[28px] font-medium tracking-[-0.02em]">Settings</h1>
      <p className="text-ink-3">
        Members, storage and authentication settings arrive with authentication.
      </p>
    </div>
  );
}
