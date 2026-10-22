/**
 * The prototype's view of the domain (docs/domain.md), as plain data. Everything here is
 * sample data held in memory: the prototype never calls the API.
 */

export type OrganisationRole = "owner" | "admin" | "member";

export interface Person {
  id: string;
  name: string;
  email: string;
  /** A guest's label, such as "Conductor". Members have none. */
  label?: string;
}

export interface Member {
  personId: string;
  role: OrganisationRole;
  joinedAt: string;
}

export interface Guest {
  personId: string;
  label: string;
  /** When the guest's current link was sent, or null when revoked. */
  linkSentAt: string | null;
}

export type ProjectProfile = "music" | "video" | "general";

export type ProjectPermission =
  | "view"
  | "upload"
  | "organise"
  | "comment"
  | "request_reviews"
  | "manage_reviewers"
  | "triage"
  | "decide"
  | "edit_workflows"
  | "manage_roles"
  | "delete";

/** The tools a role may be given in a project; the matrix in project settings. */
export type Tool =
  | "qa"
  | "meters"
  | "spectrogram"
  | "score"
  | "takes"
  | "compare"
  | "loops"
  | "normalise"
  | "download"
  | "production";

export interface ProjectRole {
  id: string;
  name: string;
  permissions: ProjectPermission[];
  tools: Tool[];
}

export interface ProjectMembership {
  personId: string;
  roleId: string;
}

export interface Group {
  id: string;
  projectId: string;
  name: string;
  /** Members and guests, in order. */
  personIds: string[];
}

export interface Project {
  id: string;
  name: string;
  profile: ProjectProfile;
  description: string;
  createdAt: string;
  roles: ProjectRole[];
  members: ProjectMembership[];
  deliveryProfile: DeliveryProfileId | null;
  /** Which comment reference fields the project uses. */
  references: { page: boolean; bar: boolean; beat: boolean };
  carriedCommentsShown: boolean;
  normalisation: "off" | "optional" | "forced";
  workflowId: string;
  archived?: boolean;
}

export interface Folder {
  id: string;
  projectId: string;
  parentId: string | null;
  name: string;
}

export type FileKind = "audio" | "video" | "document" | "image" | "other";

export type ProcessingState = "ready" | "pending" | "failed";

export interface MediaInfo {
  duration: number;
  sampleRate?: number;
  bitDepth?: number;
  channels?: number;
  layout?: string;
  codec?: string;
  container?: string;
  width?: number;
  height?: number;
  fps?: number;
  pages?: number;
}

export interface File {
  id: string;
  projectId: string;
  folderId: string | null;
  name: string;
  kind: FileKind;
  size: number;
  uploadedBy: string;
  uploadedAt: string;
  state: ProcessingState;
  media: MediaInfo;
  /** A deterministic seed for drawing waveforms and pages. */
  seed: number;
  /** The file this one replaces, in a loose file's simple version chain (#149). */
  previousId?: string;
}

export interface Variation {
  id: string;
  name: string;
  fileId: string;
  primary: boolean;
  /** A rendition's treatment (#16), as its people said; unset until they do. */
  subtitled?: boolean;
  graded?: boolean;
}

export interface Version {
  id: string;
  number: number;
  uploadedBy: string;
  uploadedAt: string;
  note: string;
  variations: Variation[];
  state: ProcessingState;
  /** The workflow status this version is in. */
  status: string;
  editDecisionList?: boolean;
}

export interface Track {
  id: string;
  projectId: string;
  folderId: string | null;
  name: string;
  /** The work it belongs to, for video a deliverable. */
  composer?: string;
  versions: Version[];
  scoreFileId: string | null;
  deliveryProfile?: DeliveryProfileId | null;
  references?: { page: boolean; bar: boolean; beat: boolean };
}

export type AnchorKind = "time" | "region" | "bar";

export type Anchor =
  | { kind: "time"; start: number; end?: number; frame?: number }
  | {
      kind: "region";
      page?: number;
      at?: number;
      x: number;
      y: number;
      width: number;
      height: number;
    }
  | { kind: "whole" };

/** The reference a reviewer typed: a page, a bar or a range of bars, a beat. All optional. */
export interface Reference {
  page?: number;
  bar?: number;
  barTo?: number;
  beat?: number;
}

export type CarryStatus = "open" | "fixed" | "not_fixed" | "wont_fix";

export interface Carry {
  /** The version this thread is shown on. */
  versionNumber: number;
  status: CarryStatus;
  visible: boolean;
  /** Where the thread points on that version's file. */
  at: number;
  /** When the anchor was moved by hand. */
  movedByHand?: boolean;
}

export interface Comment {
  id: string;
  fileId: string;
  authorId: string;
  body: string;
  createdAt: string;
  editedAt?: string;
  anchor: Anchor;
  reference?: Reference;
  parentId?: string;
  resolved?: { byId: string; at: string; versionNumber?: number };
  categoryId?: string;
  deferredToStage?: string;
  assigneeId?: string;
  todo?: { done: boolean };
  /** Takes shared with this thread for the reviewers to hear. */
  sharedTakeIds?: string[];
  /** The versions this thread travelled through. */
  carries?: Carry[];
  /** The review it was written through, if a guest wrote it. */
  reviewId?: string;
  /** A channel the comment is about, for multichannel files. */
  channel?: string;
  /** The marker list it was imported from (#134). */
  importedFrom?: string;
}

export interface CommentCategory {
  id: string;
  name: string;
  handling: "normal" | "deferred" | "information";
  stage?: string;
}

export type ReviewKind = "approval" | "feedback" | "share";
export type ReviewOrder = "parallel" | "sequence";
export type ApprovalRule = "all" | "any" | "quorum";
export type ReviewStatus = "open" | "completed" | "cancelled";
export type ReviewerState =
  | "waiting"
  | "invited"
  | "viewed"
  | "in_progress"
  | "submitted"
  | "observing";
export type Decision = "approved" | "changes_requested";

export type CommentScope = "all" | "own_and_replies" | "own";

export interface ReviewerPermissions {
  comment: boolean;
  decide: boolean;
  comments: CommentScope;
  tools: Tool[];
  history: boolean;
  download: "none" | "proxy" | "original";
  startsAt: string | null;
  expiresAt: string | null;
  viewLimit: number | null;
}

export interface Reviewer {
  personId: string;
  /** The group they came through, if any. */
  groupId?: string;
  position: number;
  state: ReviewerState;
  permissions: ReviewerPermissions;
  decision?: { decision: Decision; note: string; at: string }[];
  submittedAt?: string;
  viewedAt?: string;
  opened: string[];
}

export interface ReviewItem {
  trackId?: string;
  versionNumber?: number | "latest";
  fileId?: string;
}

export interface Review {
  id: string;
  projectId: string;
  kind: ReviewKind;
  title: string;
  message: string;
  requestedBy: string;
  requestedAt: string;
  dueAt: string | null;
  order: ReviewOrder;
  rule: ApprovalRule | null;
  quorum?: number;
  items: ReviewItem[];
  reviewers: Reviewer[];
  status: ReviewStatus;
  log: { at: string; personId: string; text: string }[];
}

export interface Session {
  id: string;
  projectId: string;
  name: string;
  date: string;
  venue: string;
  takeIds: string[];
}

export interface TakeFile {
  name: string;
  /** The microphone or "Mix". */
  channel: string;
  fileId?: string;
}

export interface Take {
  id: string;
  sessionId: string;
  number: number;
  trackId: string | null;
  rating: 0 | 1 | 2 | 3 | 4 | 5;
  starred: boolean;
  falseStarts: number;
  notes: string;
  lifecycle: "idle" | "armed" | "recording" | "recorded" | "aborted";
  timecodeIn?: string;
  timecodeOut?: string;
  wallIn?: string;
  wallOut?: string;
  duration: number;
  coverage?: { page: number; barFrom: number; barTo: number };
  files: TakeFile[];
  /** Which version uses this take, and for which bars. */
  usedIn?: { versionNumber: number; barFrom: number; barTo: number }[];
  seed: number;
}

export type DeliveryProfileId =
  | "streaming"
  | "cd"
  | "apple-digital-masters"
  | "broadcast"
  | "surround-5-1"
  | "atmos"
  | "custom";

export interface DeliveryProfile {
  id: DeliveryProfileId;
  name: string;
  loudness: number | null;
  tolerance: number;
  truePeak: number;
  rates: number[];
  bitDepth: number | null;
  layout: "stereo" | "surround" | "atmos" | "any";
  lossless: boolean;
}

export type Severity = "pass" | "info" | "warn" | "fail";

export interface QaFinding {
  id: string;
  fileId: string;
  check: string;
  severity: Severity;
  summary: string;
  detail?: string;
  channel?: string;
  start?: number;
  end?: number;
  fields: [string, string][];
  /** Compared with the previous version: new here, or fixed there. */
  change?: "new" | "fixed";
  /** The rule pack it came from, when it is not one of the built-in error checks. */
  pack?: string;
}

export type QaRuleKind = "audio" | "immersive" | "video" | "artwork" | "naming" | "metadata";

export interface QaRule {
  id: string;
  kind: QaRuleKind;
  name: string;
  hint: string;
  /** Errors are on in every project; a pack's rules are the project's to switch on. */
  severity: "fail" | "warn" | "info";
  on: boolean;
  /** Also run as the file arrives, refusing or warning before it reaches anyone. */
  onUpload: boolean;
}

export interface QaRulePack {
  id: string;
  name: string;
  source: string;
  note: string;
  rules: QaRule[];
}

export interface Loudness {
  integrated: number;
  range: number;
  truePeak: number;
  maxShortTerm: number;
  maxMomentary: number;
}

export type StageKind = "approval" | "feedback" | "task";

export interface Stage {
  id: string;
  kind: StageKind;
  name: string;
  participants: string;
  after: string[];
  status: string;
}

export interface Workflow {
  id: string;
  projectId: string;
  name: string;
  stages: Stage[];
  statuses: { name: string; category: "todo" | "in_progress" | "done" }[];
}

export interface Activity {
  id: string;
  at: string;
  personId: string;
  text: string;
  projectId: string;
  href?: string;
}

export interface Notification {
  id: string;
  at: string;
  text: string;
  read: boolean;
  href?: string;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  assigneeId: string | null;
  priority: "low" | "normal" | "high";
  status: "pending" | "in_progress" | "needs_approval" | "done";
  dueAt: string | null;
  fileId?: string;
  commentId?: string;
}

export interface AccessEvent {
  id: string;
  at: string;
  action: string;
  personId: string | null;
  guest: boolean;
  fileId?: string;
  reviewId?: string;
  address: string;
  agent: string;
}
