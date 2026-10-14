import type { OrganisationRole } from "~/data/types";

export type PersonaId =
  | "instance"
  | "owner"
  | "admin"
  | "producer"
  | "engineer"
  | "editor"
  | "reviewer"
  | "viewer"
  | "approver"
  | "feedback"
  | "guest"
  | "group";

export interface Persona {
  id: PersonaId;
  label: string;
  /** What the switcher says under the label. */
  summary: string;
  personId: string;
  kind: "member" | "guest" | "instance";
  organisationRole: OrganisationRole | null;
  /** Project role overrides for this persona: project id to role id, or null for no role. */
  projectRoles: Record<string, string | null>;
  /** A review this persona is centred on, so its entry opens there. */
  focusReviewId?: string;
  /** Where the switcher takes you when you become this person. */
  home: string;
}

export const personas: Persona[] = [
  {
    id: "instance",
    label: "Instance admin",
    summary: "Alex Rivera, the operator: tenants and the instance, no project content.",
    personId: "p-alex",
    kind: "instance",
    organisationRole: null,
    projectRoles: {},
    home: "/instance",
  },
  {
    id: "owner",
    label: "Owner",
    summary: "Alex Rivera, organisation owner: everything in every project.",
    personId: "p-alex",
    kind: "member",
    organisationRole: "owner",
    projectRoles: {},
    home: "/",
  },
  {
    id: "admin",
    label: "Admin",
    summary: "Ines Arlow, organisation admin: everything, bar removing the last owner.",
    personId: "p-ines",
    kind: "member",
    organisationRole: "admin",
    projectRoles: {},
    home: "/",
  },
  {
    id: "producer",
    label: "Producer",
    summary:
      "Mira Solberg, Producer on Joplin Rags: upload, request, triage, decide, workflows, production.",
    personId: "p-mira",
    kind: "member",
    organisationRole: "member",
    projectRoles: { "proj-joplin": "r-producer", "proj-titles": "r-producer" },
    home: "/projects/proj-joplin",
  },
  {
    id: "engineer",
    label: "Engineer",
    summary:
      "Tomas Varga, Engineer on Joplin Rags: upload, organise, comment, triage; QA, meters, takes.",
    personId: "p-tomas",
    kind: "member",
    organisationRole: "member",
    projectRoles: { "proj-joplin": "r-engineer", "proj-titles": "r-editor" },
    home: "/projects/proj-joplin",
  },
  {
    id: "editor",
    label: "Editor",
    summary: "Tomas Varga, Editor on Opening titles: cuts, renditions, edit decisions.",
    personId: "p-tomas",
    kind: "member",
    organisationRole: "member",
    projectRoles: { "proj-joplin": "r-engineer", "proj-titles": "r-editor" },
    home: "/projects/proj-titles",
  },
  {
    id: "reviewer",
    label: "Reviewer (member)",
    summary:
      "Ines Arlow, Reviewer on Joplin Rags: view, comment, decide; nothing to upload or triage.",
    personId: "p-ines",
    kind: "member",
    organisationRole: "member",
    projectRoles: { "proj-joplin": "r-reviewer", "proj-titles": "r-reviewer" },
    home: "/projects/proj-joplin",
  },
  {
    id: "viewer",
    label: "Viewer (member)",
    summary:
      "Alex Rivera as a Viewer on Opening titles: look and play, nothing else; Joplin Rags is hidden.",
    personId: "p-alex",
    kind: "member",
    organisationRole: "member",
    projectRoles: { "proj-joplin": null, "proj-titles": "r-viewer" },
    home: "/projects",
  },
  {
    id: "approver",
    label: "Approval reviewer",
    summary: "Ines Arlow, asked to approve Album masters.",
    personId: "p-ines",
    kind: "member",
    organisationRole: "member",
    projectRoles: { "proj-joplin": "r-reviewer", "proj-titles": "r-reviewer" },
    focusReviewId: "rev-masters",
    home: "/reviews/rev-masters",
  },
  {
    id: "feedback",
    label: "Feedback reviewer",
    summary: "Tomas Varga, in the Mix notes feedback round.",
    personId: "p-tomas",
    kind: "member",
    organisationRole: "member",
    projectRoles: { "proj-joplin": "r-engineer", "proj-titles": "r-editor" },
    focusReviewId: "rev-mixnotes",
    home: "/reviews/rev-mixnotes",
  },
  {
    id: "guest",
    label: "Guest",
    summary:
      "Mira Solberg, a conductor with no account, arriving by link: her reviews, her comments, the takes shared with her.",
    personId: "p-mira",
    kind: "guest",
    organisationRole: null,
    projectRoles: {},
    focusReviewId: "rev-masters",
    home: "/g",
  },
  {
    id: "group",
    label: "Group member",
    summary: "Ines Arlow through the Soloists group: her step in a review sent in sequence.",
    personId: "p-ines",
    kind: "member",
    organisationRole: "member",
    projectRoles: { "proj-joplin": "r-reviewer", "proj-titles": "r-reviewer" },
    focusReviewId: "rev-soloists",
    home: "/reviews/rev-soloists",
  },
];

export const personaById = (id: string): Persona =>
  personas.find((p) => p.id === id) ?? (personas[1] as Persona);
