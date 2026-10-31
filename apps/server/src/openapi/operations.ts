/**
 * The words of the public API's reference (#197): a summary for every operation, and for the
 * calls scripts make most, a description and examples. Everything else in the document (which
 * calls there are, their scopes, parameters, bodies and statuses) is read from the routes, so
 * nothing here can describe a call that is not there: a test fails on an operation without an
 * entry, and on an entry without an operation.
 *
 * Keys are the method and the path under the version's base, as OpenAPI writes it.
 */

/** A body that is not JSON: an upload's chunk, an attachment, a caption file. */
export interface BinaryBody {
  type: string;
  description: string;
}

export interface ApiOperation {
  summary: string;
  description?: string;
  /** The group it is listed under, where its path would put it elsewhere. */
  tag?: string;
  /** The success status, where the handler's source does not say it plainly. */
  status?: 200 | 201 | 202 | 204;
  /** What a success answers with, where it is not JSON. */
  produces?: string | string[];
  /** What a success answers, in a few words. */
  responds?: string;
  /** A body that is not JSON. */
  body?: BinaryBody;
  /** Headers the call reads. */
  headers?: { name: string; description: string; required: boolean }[];
  /** The request body's example; otherwise one is made from its schema. */
  request?: unknown;
  /** The answer's example. */
  response?: unknown;
  /** Why it is deprecated and what to call instead; the document marks it so. */
  deprecated?: string;
}

const ids = {
  project: "01929b8e-5c1a-7d3e-9f40-2b6c8d1e4a57",
  folder: "01929b8e-6a20-7c11-8e2f-5d3b9a0c7f12",
  track: "01929b8e-7b44-7a09-b1c3-8e6f2d4a9c35",
  version: "01929b8f-0d12-7e45-a6b7-1c9e3f5d2a84",
  variant: "01929b8f-1e23-7f56-b7c8-2d0f4a6e3b95",
  file: "01929b8f-2f34-7067-88d9-3e1a5b7f4ca6",
  upload: "01929b8f-3a45-7178-99ea-4f2b6c8a5db7",
  comment: "01929b8f-4b56-7289-aafb-5a3c7d9b6ec8",
  review: "01929b8f-5c67-739a-bb0c-6b4d8eac7fd9",
  reviewer: "01929b8f-6d78-74ab-8c1d-7c5e9fbd80ea",
  user: "Hq3tW9mR2xVb7nKc",
  workspace: "01929b8d-9f01-7a2b-8c3d-4e5f60718293",
} as const;

const at = "2026-10-23T09:30:00.000Z";

/** Answers as the server gives them (a test holds each to a real answer's shape). */
const answers = {
  project: {
    id: ids.project,
    organisationId: ids.workspace,
    name: "Joplin Rags",
    profile: "music",
    description: null,
    archivedAt: null,
    createdAt: at,
    updatedAt: at,
    references: { page: true, bar: true, beat: true },
  },
  folder: { id: ids.folder, parentId: null, name: "Masters" },
  track: {
    id: ids.track,
    organisationId: ids.workspace,
    projectId: ids.project,
    folderId: ids.folder,
    name: "Maple Leaf Rag",
    scoreFileId: null,
    workflowStatus: null,
    position: 0,
    createdAt: at,
    updatedAt: at,
    versions: [],
  },
  upload: {
    id: ids.upload,
    projectId: ids.project,
    folderId: ids.folder,
    name: "Maple Leaf Rag (wet).wav",
    size: 52428800,
    status: "open",
    chunkSize: 8388608,
    chunkCount: 7,
    receivedChunks: [0, 1, 2],
    expiresAt: "2026-10-30T09:30:00.000Z",
  },
  file: {
    id: ids.file,
    projectId: ids.project,
    folderId: ids.folder,
    name: "Maple Leaf Rag (wet).wav",
    kind: "audio",
    contentType: "audio/wav",
    byteSize: 52428800,
    streamStatus: "pending",
    analysisStatus: "pending",
    createdAt: at,
  },
  comment: {
    id: ids.comment,
    fileId: ids.file,
    parentId: null,
    anchor: { kind: "bar", from: { bar: 12, beat: 1 } },
    body: "The horns could come up a little at bar 12.",
    authorId: ids.user,
    authorName: "Ines Arlow",
    authorGuest: false,
    resolvedAt: null,
    editedAt: null,
    createdAt: at,
    categoryId: null,
    assigneeId: null,
    mentions: [],
    todo: false,
    mine: false,
  },
};

export const apiOperations: Record<string, ApiOperation> = {
  // The workspace.
  "GET /organisation/plan": { summary: "Read the workspace's plan and its limits" },
  "GET /organisation/settings": {
    summary: "Read the workspace's settings",
    description:
      "How dates read, what a review grants by default, and the workspace's other settings.",
  },
  "GET /organisation/delivery-profiles": {
    summary: "List the workspace's delivery profiles",
    description: "The loudness and format targets its projects, tracks and files measure against.",
  },
  "GET /organisation/members": {
    summary: "List the workspace's members",
    description: "Each member with their role in the workspace.",
    response: {
      members: [
        {
          id: ids.reviewer,
          userId: ids.user,
          name: "Ines Arlow",
          email: "ines@endlesshall.example",
          role: "admin",
          joinedAt: at,
        },
      ],
    },
  },

  // Search and home.
  "GET /search/saved": { summary: "List your saved searches" },
  "POST /search/saved": { summary: "Save a search" },
  "DELETE /search/saved/{id}": { summary: "Remove a saved search" },
  "GET /search": {
    summary: "Search the workspace",
    description:
      "Projects, folders, files, tracks, comments and people that match, among the projects the token's member may see.",
    response: {
      results: [
        {
          kind: "tracks",
          id: ids.track,
          label: "Maple Leaf Rag",
          hint: "Joplin Rags",
          link: `/tracks/${ids.track}`,
          projectId: ids.project,
        },
      ],
    },
  },
  "GET /home": {
    summary: "Read the home page",
    description:
      "Each visible project's figures, open threads and new versions across them, files that failed to process, and what has happened lately.",
  },

  // Projects.
  "GET /projects": {
    summary: "List projects",
    description:
      "The projects the token's member may see: those in use, or with `archived=1` those archived. With `figures=1`, each carries what its card shows.",
    response: { projects: [{ ...answers.project, mine: true, mayArchive: true }] },
  },
  "POST /projects": {
    summary: "Make a project",
    description:
      "It comes with the default roles, or a template's, and the token's member (or a service token's account) is its first Producer. The profile (`music`, `video`, `general`) decides which tools appear.",
    request: { name: "Joplin Rags", profile: "music" },
    response: { project: answers.project },
  },
  "GET /projects/{id}": {
    summary: "Read a project",
    response: {
      project: {
        ...answers.project,
        permissions: ["view", "upload", "comment"],
        tools: ["qa", "meters", "score"],
        mayArchive: true,
        deletion: null,
      },
    },
  },
  "PATCH /projects/{id}": {
    summary: "Change a project's settings",
    description: "Its name, description, profile and comments; how versions are checked.",
    request: { description: "Piano rags, recorded at Endless Hall in October." },
  },
  "GET /projects/{id}/files": {
    summary: "List a project's files",
    description: "Every file in the project, wherever it sits, as its file list shows them.",
  },
  "GET /projects/{id}/storage": {
    summary: "Read where a project's files are stored",
    description: "The storage backend it uses and how much it holds. Admins only.",
  },
  "PUT /projects/{id}/storage": {
    summary: "Choose where a project's new files are stored",
    description:
      "Owners only. Files already stored stay where they are; null follows the workspace's choice.",
    request: { backend: "archive" },
  },
  "POST /projects/{id}/score-downloads": {
    summary: "Download a project's scores",
    description:
      "Asks for the scores of the tracks named, as one download: a link that works once, for five minutes, with the same token. Watermarked for the token's member and logged.",
  },
  "GET /projects/{id}/marks": {
    summary: "List your marks in a project",
    description: "The token's member's own pins, favourites and seen files. Nobody else sees them.",
    tag: "Projects",
  },
  "POST /projects/{id}/marks": {
    summary: "Mark something in a project",
    description:
      "Pin, favourite or mark as seen a folder, track or file, for the token's member alone.",
    tag: "Projects",
    request: { items: [{ kind: "file", id: ids.file }], favourite: true },
  },
  "GET /projects/{id}/overview": { summary: "Read a project's overview" },
  "PUT /projects/{id}/overview/layout": {
    summary: "Arrange your overview of a project",
    description: "Each person arranges their own.",
  },
  "POST /projects/{id}/template": {
    summary: "Save a project's set-up as a template",
    description: "Its folders, roles and workflows, for new projects to start from.",
  },

  // Folders.
  "GET /projects/{id}/folders": {
    summary: "List a project's folders",
    response: { folders: [answers.folder] },
  },
  "POST /projects/{id}/folders": {
    summary: "Make a folder",
    description: "At the project's top level, or inside another folder with `parentId`.",
    request: { name: "Masters" },
    response: { folder: answers.folder },
  },
  "PATCH /folders/{id}": {
    summary: "Rename or move a folder",
    response: { folder: { ...answers.folder, name: "Final masters" } },
  },
  "DELETE /folders/{id}": {
    summary: "Delete a folder",
    description:
      "What was in it stays: its files, and its folders' files, move up to where the folder was. Only the folders go.",
  },

  // Files.
  "GET /files/{id}": {
    summary: "Read a file",
    description:
      "The file, its kind, its preparation status and what the token's member may do with it. Media itself never comes this way: see Downloads.",
    response: {
      file: {
        ...answers.file,
        uploadedBy: "Tomas Varga",
        variant: null,
        variation: null,
        chain: [],
        tools: ["qa", "meters", "spectrogram"],
      },
    },
  },
  "PATCH /files/{id}": { summary: "Rename or move a file" },
  "DELETE /files/{id}": {
    summary: "Delete a file",
    description:
      "A file that is part of a track's version stays, and so does one under review unless the project lets reviewed files go: removing it would change what reviewers were asked about.",
  },
  "POST /files/{id}/next": {
    summary: "Make another file this one's next version",
    description:
      "For loose files (a simple version chain): the file named becomes this one's next version and takes its place in the folder. A track's files have its versions instead.",
  },
  "PUT /files/{id}/delivery-profile": {
    summary: "Choose what a file is measured against",
    description: "A delivery profile for this file alone, over its track's and project's.",
  },
  "GET /files/{id}/details": {
    summary: "Read a file's details",
    description:
      "How it is stored (never the key or the location), what has been made from it, where it is used, and what the token's member may do with it.",
  },
  "GET /files/{id}/alignments": {
    summary: "Read where a file's music sits in others",
    description: "Its alignments with the files it was aligned with, read from this file's side.",
  },
  "GET /files/{id}/compare": {
    summary: "List what a file can be compared with",
    description:
      "Its track's versions and their variants, as far as the token's member may open them.",
  },
  "GET /files/{id}/peaks": {
    summary: "Read a file's waveform levels",
    description:
      "Which levels of waveform peaks there are. Peaks are far too coarse to rebuild audio from.",
  },
  "GET /files/{id}/peaks/{levelId}": {
    summary: "Read one level of a file's waveform peaks",
    produces: "application/octet-stream",
    responds: "Each channel's lowest and highest sample over blocks, in 8 bits.",
  },
  "GET /files/{id}/loudness": { summary: "Read a file's loudness and levels" },
  "GET /files/{id}/loudness/series": {
    summary: "Read a file's loudness over time",
    produces: "application/octet-stream",
  },
  "GET /files/{id}/qa": { summary: "Read what a file's quality checks found" },
  "GET /files/{id}/qa/changes": {
    summary: "Read what a file's checks found fixed and new",
    description:
      "Against the previous version of the same track, with its times carried across by the alignment.",
  },
  "GET /files/{id}/qa/document": {
    summary: "Read a file's quality report as a document",
    description:
      "The report as the PDF sets it: the verdict, the loudness against the delivery profile, the findings by severity then time with a crop of the waveform and what to do about each, and the appendices.",
  },
  "GET /files/{id}/qa/report": {
    summary: "Download a file's quality report",
    description:
      "PDF to read, CSV for a spreadsheet, or JSON for a program, as `format` says. The PDF carries the workspace's brand and the mark of whoever asked for it; each report taken is in the access log.",
    produces: ["application/pdf", "text/csv", "application/json"],
  },
  "PUT /files/{id}/tags": { summary: "Set a file's tags" },
  "GET /files/{id}/metadata": {
    summary: "Read a recording's metadata corrections",
    description:
      "The fields that may be corrected in a file of its format (bext, iXML or tags), the corrections made so far beside what the file itself says, and whether the token's member may correct them. For those with the QA tool on the file.",
  },
  "PUT /files/{id}/metadata": {
    summary: "Correct a recording's metadata",
    description:
      "Sets or clears the fields named. The original is never rewritten: the corrections are Hekate's record, QA reads with them, and a download of the original writes them in. For those who may organise the project's files and have the QA tool; each change is logged.",
    request: { changes: { description: "Maple Leaf Rag, take 3", originator: null } },
  },
  "POST /files/{id}/retry": {
    summary: "Prepare a file again",
    description: "After its preparation failed. For those who may upload to its project.",
  },
  "GET /files/{id}/captions": { summary: "List a file's caption tracks" },
  "POST /files/{id}/captions": {
    summary: "Add a caption track to a video or a recording",
    description:
      "WebVTT, SubRip or TTML, at most 2 MB, sent as the body. Its language and kind are read from the file where it says, unless the query sets them.",
    body: {
      type: "text/vtt",
      description: "The caption file (WebVTT, or SubRip as `application/x-subrip`).",
    },
    headers: [
      { name: "X-File-Name", description: "The file's name, URI-encoded.", required: true },
    ],
  },
  "PATCH /files/{id}/captions/{captionId}": {
    summary: "Rename a caption track, or change its language or kind",
  },
  "GET /files/{id}/captions/{captionId}/export": {
    summary: "Export a caption track",
    description:
      "Written afresh from its cues as SubRip, WebVTT or TTML, whichever it came in. Needs the download permission and the `downloads` scope, and is logged.",
  },
  "DELETE /files/{id}/captions/{captionId}": { summary: "Remove a caption track" },

  // Tracks.
  "GET /projects/{id}/tracks": {
    summary: "List a project's tracks",
    response: { tracks: [{ ...answers.track, state: "no_version", waitingOn: [] }] },
  },
  "POST /projects/{id}/tracks": {
    summary: "Make a track",
    description: "A piece of music, which then takes versions.",
    request: { name: "Maple Leaf Rag" },
    response: { track: answers.track },
  },
  "GET /tracks/{id}": {
    summary: "Read a track",
    description: "The track with its versions, each version's variants, and where it stands.",
    response: { track: answers.track },
  },
  "PATCH /tracks/{id}": { summary: "Change a track" },
  "PUT /tracks/{id}/delivery-profile": {
    summary: "Choose what a track's versions are measured against",
  },
  "PUT /tracks/{id}/references": {
    summary: "Set the references a track's comments may name",
    description: "Over the project's.",
  },
  "PUT /tracks/{id}/comment-assignment": {
    summary: "Choose whom a track's new comments are for",
    description: "Over the project's rule; null keeps the project's.",
  },
  "PUT /tracks/{id}/normalisation": {
    summary: "Choose how a track's recordings play normalised",
    description: "Over the project's choice.",
  },
  "GET /tracks/{id}/compare": {
    summary: "Compare two of a track's versions",
    description: "Where the music sits in each, and what changed between them.",
  },
  "POST /tracks/{id}/compare/realign": {
    summary: "Align a track's versions again",
    description:
      "Between each pair of neighbouring versions whose alignment failed, came out too poor to follow, or was never made.",
  },
  "GET /tracks/{id}/edit-decisions": {
    summary: "Read a track's edit decisions",
    description:
      "Which take each stretch of a version comes from, read from its edit decision list.",
  },

  // Versions and variants.
  "POST /tracks/{id}/versions": {
    summary: "Add a version to a track",
    description:
      "From one or more uploaded files, each a variant (dry and wet mixes, say); one is primary. Start each file with `POST /uploads` and finish it first, then name the files here.",
    request: {
      notes: "Horns up at bar 12, as asked.",
      variants: [{ fileId: ids.file, name: "Wet mix", primary: true }],
    },
  },
  "GET /tracks/{id}/carry": {
    summary: "Read what a new version would carry over",
    description:
      "The open threads that would be carried to it, for whoever adds it to confirm or correct.",
  },
  "PUT /versions/{id}/edl": {
    summary: "Set a version's edit decision list",
    description: "Given or changed after the version was made, or taken off.",
  },
  "POST /versions/{id}/variants": {
    summary: "Add a variant to a version",
    description: "Another treatment of the same edit, from an uploaded file.",
  },
  "PATCH /variants/{id}": { summary: "Rename a variant, or change its treatment" },
  "POST /variants/{id}/primary": { summary: "Make a variant its version's primary" },
  "POST /variants/{id}/replace": {
    summary: "Replace a variant's file",
    description: "With another uploaded file, before anyone has commented on or reviewed it.",
  },
  // The variant calls under their name before decision 275, answered for one release.
  "POST /versions/{id}/variations": {
    summary: "Add a variant to a version (deprecated name)",
    deprecated:
      "Call `POST /versions/{id}/variants`, which answers the same; this name goes in the next release.",
  },
  "PATCH /variations/{id}": {
    summary: "Rename a variant, or change its treatment (deprecated name)",
    deprecated:
      "Call `PATCH /variants/{id}`, which answers the same; this name goes in the next release.",
  },
  "POST /variations/{id}/primary": {
    summary: "Make a variant its version's primary (deprecated name)",
    deprecated:
      "Call `POST /variants/{id}/primary`, which answers the same; this name goes in the next release.",
  },
  "POST /variations/{id}/replace": {
    summary: "Replace a variant's file (deprecated name)",
    deprecated:
      "Call `POST /variants/{id}/replace`, which answers the same; this name goes in the next release.",
  },

  // Uploads.
  "POST /uploads": {
    summary: "Start an upload",
    description:
      "Say what is coming and where it goes, then send it in chunks (`PUT /uploads/{id}/chunks/{index}`, 8 MiB each, in any order, again if one fails) and finish it (`POST /uploads/{id}/complete`). Each chunk is encrypted as it arrives.",
    request: {
      projectId: ids.project,
      folderId: ids.folder,
      name: "Maple Leaf Rag (wet).wav",
      size: 52428800,
      contentType: "audio/wav",
    },
    response: { upload: { ...answers.upload, receivedChunks: [] } },
  },
  "GET /uploads/{id}": {
    summary: "Read an upload",
    description: "Which chunks have arrived, so an interrupted upload can send only the rest.",
    response: { upload: answers.upload },
  },
  "PUT /uploads/{id}/chunks/{index}": {
    summary: "Send one chunk of an upload",
    description:
      "Chunks are 8 MiB (the last may be shorter) and numbered from 0. Send `Content-Digest` (RFC 9530, `sha-256=:…:`) and a chunk that arrives damaged is refused.",
    body: { type: "application/octet-stream", description: "The chunk's bytes." },
    headers: [
      {
        name: "Content-Digest",
        description: "The chunk's SHA-256, as `sha-256=:<base64>:`.",
        required: false,
      },
    ],
  },
  "POST /uploads/{id}/complete": {
    summary: "Finish an upload",
    description:
      "Once every chunk has arrived: the file is made (201) and prepared in the background. Finishing it again answers the same file (200).",
    response: { file: answers.file },
  },
  "DELETE /uploads/{id}": { summary: "Abandon an upload" },
  "GET /projects/{projectId}/upload-requests": {
    summary: "List a project's upload requests",
    description: "Links for someone outside to send files into a folder.",
  },
  "POST /projects/{projectId}/upload-requests": {
    summary: "Make an upload request",
    description: "A link, shown once, for someone outside to send files into a folder.",
  },
  "GET /upload-requests/{id}": { summary: "Read an upload request" },
  "POST /upload-requests/{id}/close": { summary: "Close an upload request" },
  "POST /upload-requests/{id}/link": {
    summary: "Make a new link for an upload request",
    description: "The old link stops working at once.",
  },

  // Comments.
  "GET /files/{id}/comments": {
    summary: "List a file's comments",
    description:
      "Its threads, with their replies, anchors and attachments, as far as the token's member may see them.",
    response: { comments: [{ ...answers.comment, attachments: [], takes: [] }] },
  },
  "POST /files/{id}/comments": {
    summary: "Comment on a file",
    description:
      "A thread, or a reply with `parentId`. An anchor places it: `time` (seconds, or a range), `region` (a normalised rectangle on a page or frame) or `bar` (a bar and beat, or a bar range).",
    request: {
      body: "The horns could come up a little at bar 12.",
      anchor: { kind: "bar", from: { bar: 12, beat: 1 } },
    },
    response: { comment: { ...answers.comment, mine: true } },
  },
  "GET /files/{id}/mentionable": {
    summary: "List whom a comment may mention",
    description: "The project's people, by name.",
  },
  "GET /files/{id}/stages": {
    summary: "List the stages a comment may be deferred to",
    description:
      "Those of the workflows that apply to the file's track (or its project), with the step a running workflow waits at marked.",
  },
  "POST /files/{id}/comments/triage": {
    summary: "Triage comments",
    description:
      "One thread or a selection: a category, deferral to a stage or back, who is to act on it, resolved or not.",
    request: { commentIds: [ids.comment], resolved: true },
  },
  "POST /files/{id}/comments/send-list": {
    summary: "Send someone their comments on a file",
    description: "The open threads assigned to them, as one notification and mail.",
  },
  "GET /files/{id}/comments/export": {
    summary: "Export a file's comments",
    description:
      "As markers for an editor or a DAW, or as a spreadsheet, as `target` says: CSV, EDL, XML, MIDI and others.",
    produces: "application/octet-stream",
  },
  "GET /files/{id}/comments/sheet": {
    summary: "Print a file's comments",
    produces: "application/pdf",
  },
  "POST /files/{id}/comments/import": {
    summary: "Import markers as comments",
    description: "Markers from an editor or a DAW, each becoming a comment at its time.",
    request: {
      listName: "Maple Leaf Rag markers.csv",
      markers: [{ start: 12.5, end: 14, body: "Edit point audible here." }],
    },
  },
  "PATCH /comments/{id}": { summary: "Edit a comment" },
  "POST /comments/{id}/todo": { summary: "Tick or untick a comment's to-do" },
  "POST /comments/{id}/resolve": { summary: "Resolve or reopen a thread" },
  "POST /comments/{id}/takes": {
    summary: "Share takes on a thread",
    description:
      "Takes of the same project, which everyone who sees the thread may then hear. Each share is logged.",
  },
  "DELETE /comments/{id}/takes/{takeId}": { summary: "Stop sharing a take on a thread" },
  "POST /comments/{id}/files": {
    summary: "Link files of the project to a comment",
    description:
      "By the comment's author, from files of its thread's project they can see; never a take's. Whoever sees the comment opens each in the viewer as their own access allows, never as a download from here. Each link is logged.",
  },
  "DELETE /comments/{id}/files/{fileId}": {
    summary: "Unlink a file from a comment",
    description: "By the comment's author, or whoever triages its thread's file. Logged.",
  },
  "PATCH /comment-carries/{id}": {
    summary: "Triage a thread carried to a later version",
    description:
      "Its status there, whether it shows there, and a corrected mapping. Fixed and won't fix settle the thread; open and not fixed carry it on to the next version.",
  },
  "POST /files/{id}/comments/{commentId}/attachments": {
    summary: "Attach a file to a comment",
    description:
      "At most 25 MB, sent as the body; stored encrypted, and reached only through a logged download.",
    body: {
      type: "application/octet-stream",
      description: "The attachment's bytes, with its own `Content-Type`.",
    },
    headers: [
      { name: "X-File-Name", description: "The attachment's name, URI-encoded.", required: true },
    ],
  },
  "DELETE /files/{id}/attachments/{attachmentId}": { summary: "Remove a comment's attachment" },

  // Reviews.
  "GET /reviews": {
    summary: "List your reviews",
    description: "The reviews the token's member is asked to take part in, open ones first.",
  },
  "GET /reviews/scope": {
    summary: "Whether you may ask a review of everything in the workspace",
    description:
      "True for an owner or admin, or a member whose role has the Reviews: Manage level in every project not archived; with how many projects that covers.",
  },
  "GET /reviews/{id}": {
    summary: "Read a review",
    description: "What it asks about, its reviewers in their order, and each decision recorded.",
  },
  "GET /projects/{id}/reviews": { summary: "List a project's reviews" },
  "POST /projects/{id}/reviews": {
    summary: "Request a review",
    description:
      "An approval (each reviewer records *Approved* or *Changes requested*) or feedback (comments, no sign-off), of tracks or files, from members, guests and groups, all at once or in order.",
    request: {
      kind: "approval",
      items: [{ trackId: ids.track }],
      reviewers: [
        ids.user,
        { name: "Alex Rivera", email: "alex@endlesshall.example", label: "Conductor" },
      ],
      message: "The rags for sign-off, please.",
      dueAt: "2026-10-30T17:00:00.000Z",
    },
  },
  "POST /reviews/{id}/viewed": {
    summary: "Say you have opened a review",
    description: "The token's member, as a reviewer, goes from invited to viewed.",
  },
  "POST /reviews/{id}/decisions": {
    summary: "Record a decision",
    description:
      "As the token's member, a reviewer of this approval: *Approved* or *Changes requested*, logged with who, when and how.",
    request: { decision: "approved", note: "Lovely. Ship it." },
  },
  "POST /reviews/{id}/submit": {
    summary: "Submit feedback",
    description:
      "As the token's member, a reviewer of this feedback round: their comments are done.",
  },
  "POST /reviews/{id}/cancel": { summary: "Cancel a review" },
  "PATCH /reviews/{id}": {
    summary: "Change a review's due date",
    description: "Those not yet reminded of it can be again.",
  },
  "POST /reviews/{id}/remind": {
    summary: "Remind a review's reviewers",
    description:
      "Everyone it waits on now, or one of them: a notification and a mail for members, a fresh link for guests. A few a review an hour.",
  },
  "POST /reviews/{id}/reviewers": {
    summary: "Add a reviewer",
    description: "A member or a guest, at the end of the order, while the review is open.",
  },
  "POST /reviews/{id}/invite": {
    summary: "Invite someone into a review",
    description:
      "Where the reviewer's grant allows it: they join as a guest at the inviter's step, with what the inviter may do but no decision.",
  },
  "PATCH /reviews/{id}/reviewers/{reviewerId}": { summary: "Change what a reviewer may do" },
  "POST /reviews/{id}/reviewers/{reviewerId}/link": {
    summary: "Send a guest reviewer a fresh link",
    description: "Any earlier unused link stops working.",
  },
  "POST /reviews/{id}/reviewers/{reviewerId}/revoke": {
    summary: "Revoke a guest reviewer",
    description: "Their links and signed-in browsers, everywhere in the workspace.",
  },
  "DELETE /reviews/{id}/reviewers/{reviewerId}": {
    summary: "Remove a reviewer",
    description: "One who has not yet decided or submitted; the review may then be complete.",
  },
  "GET /projects/{id}/guests": {
    summary: "List a project's guests",
    description:
      "The guests its reviews and groups have asked, and whether a link still works for each.",
  },
  "POST /projects/{id}/guests": {
    summary: "Invite a reviewer to a project",
    description:
      "A guest of the project before any review asks them (#502): by name and email, with a note kept for the team and, if wanted, a group they join. Nothing is sent until a review asks them.",
  },
  "PATCH /projects/{id}/guests/{guestId}": {
    summary: "Change how a guest appears",
    description:
      "The label beside their name, which follows them into the workspace's other projects.",
  },
  "POST /projects/{id}/guests/{guestId}/link": {
    summary: "Send a guest a fresh link",
    description: "For the newest open review in this project that asks them.",
  },
  "POST /projects/{id}/guests/{guestId}/revoke": {
    summary: "Revoke a guest",
    description: "Every link and signed-in browser they have.",
  },
  "GET /projects/{id}/reviewer-grants": {
    summary: "List what each person may do in a project's reviews",
  },
  "PUT /projects/{id}/reviewer-grants/{kind}/{personId}": {
    summary: "Set what someone may do in a project's reviews",
    description:
      "In every review of this project they are asked into; a review's own overrides come on top.",
  },
  "DELETE /projects/{id}/reviewer-grants/{kind}/{personId}": {
    summary: "Return someone to the workspace's review defaults",
  },
  "GET /projects/{id}/groups": { summary: "List a project's reviewer groups" },
  "POST /projects/{id}/groups": { summary: "Make a reviewer group" },
  "PUT /projects/{id}/groups/{groupId}": { summary: "Change a reviewer group" },
  "DELETE /projects/{id}/groups/{groupId}": {
    summary: "Delete a reviewer group",
    description: "Reviews already sent keep their reviewers; they only lose the group's name.",
  },

  // Downloads.
  "GET /files/{id}/downloads": {
    summary: "List what you may download of a file",
    description:
      "The token's member's download level here, and the originals and proxies on offer. `marked` says whether a download carries the member's mark; `inaudible`, that a recording's mark is in its sound (#32).",
    response: {
      level: "original",
      proxy: { available: true, detail: "AAC 256 kb/s, with an inaudible mark" },
      original: {
        available: true,
        detail: "WAV, 24-bit, 48 kHz, as uploaded but for an inaudible mark",
      },
      marked: true,
    },
  },
  "POST /files/{id}/downloads": {
    summary: "Ask for a download",
    description:
      "A link that works once, for five minutes, with the same token. Nothing leaves until it is opened, and then only watermarked for the token's member, and after it is written to the access log.",
    request: { kind: "original" },
    response: { url: "/api/downloads/q3VnT8xYp2LmR5sWc9KjB4hNa7Dz1EfGu6iOt0bQyXw" },
  },
  "GET /downloads/{token}": {
    summary: "Fetch a download",
    description:
      "Opens a link `POST /files/{id}/downloads` gave, once, within five minutes, with the same token.",
    produces: "application/octet-stream",
    responds:
      "The file, marked for the token's member: drawn on pictures, pages and video, and inaudibly in a recording where the workspace marks them.",
  },
  "POST /files/{id}/attachments/{attachmentId}/download": {
    summary: "Ask for a comment's attachment",
    description: "A download link, as for a file's: once, within five minutes, and logged.",
  },

  // Workflows.
  "GET /projects/{id}/workflows": { summary: "List a project's workflows" },
  "POST /projects/{id}/workflows": { summary: "Make a workflow" },
  "GET /projects/{id}/workflow-statuses": {
    summary: "List a project's statuses",
    description: "What the board's columns are, and what a step may set.",
  },
  "PUT /projects/{id}/workflow-statuses": { summary: "Set a project's statuses" },
  "GET /workflows/{id}": { summary: "Read a workflow" },
  "PATCH /workflows/{id}": { summary: "Change a workflow" },
  "DELETE /workflows/{id}": { summary: "Delete a workflow" },
  "GET /tracks/{id}/workflow-standing": {
    summary: "Read where a track stands",
    description: "The status its workflow gave it, the step its run waits at, and the step after.",
  },
  "GET /tracks/{id}/workflow-runs": { summary: "List a track's workflow runs" },
  "POST /tracks/{id}/workflow-runs": { summary: "Start a workflow on a track" },
  "POST /workflow-runs/{id}/steps": {
    summary: "End a step by hand",
    description: "A step the run waits on, with the outcome given.",
  },

  // Takes and sessions.
  "GET /projects/{id}/sessions": { summary: "List a project's recording sessions" },
  "POST /projects/{id}/sessions": { summary: "Make a recording session" },
  "POST /projects/{id}/takes/import": {
    summary: "Import a take log",
    description:
      "Takes from a spreadsheet or another recorder's log, matched to the project's tracks.",
  },
  "GET /sessions/{id}": { summary: "Read a recording session" },
  "PATCH /sessions/{id}": { summary: "Change a recording session" },
  "DELETE /sessions/{id}": { summary: "Delete a recording session" },
  "POST /sessions/{id}/takes": {
    summary: "Log the next take",
    description: "Numbered as the session numbers them, rolling or armed.",
  },
  "PUT /sessions/{id}/recorder": {
    summary: "Drive a session's takes from a recorder",
    description:
      "Says that this connection (a browser tab or a tool) reads the recorder and starts and stops the takes, under a `claim` id of its own; sent again with `renew` every ten seconds while it does, which answers 409 once another connection has claimed it, the same member's included. The last to claim it drives.",
    request: { kind: "daw-midi", claim: "01a16b55-0000-7000-8000-000000000001" },
  },
  "DELETE /sessions/{id}/recorder": {
    summary: "Stop driving a session's takes from a recorder",
    description:
      "Only the connection's own claim, named by `claim`: a late goodbye never ends another's.",
  },
  "POST /sessions/{id}/todos": { summary: "Add to a session's to-do list" },
  "PATCH /sessions/{id}/todos/{todoId}": { summary: "Change a session's to-do" },
  "DELETE /sessions/{id}/todos/{todoId}": { summary: "Remove a session's to-do" },
  "GET /tracks/{id}/takes": { summary: "List a track's takes" },
  "POST /tracks/{id}/takes": {
    summary: "Add takes to a track",
    description:
      "Recording-session snippets, with an optional bar range and in and out points. Takes are reference material, never versions.",
  },
  "GET /takes/{id}": {
    summary: "Read a take",
    description:
      "With its track, the session it was recorded in, and that session's other takes of the track.",
  },
  "PATCH /takes/{id}": { summary: "Change a take" },
  "GET /takes/{id}/history": {
    summary: "Read a take's history",
    description: "What changed on it, a field at a time, oldest first.",
  },
  "DELETE /takes/{id}": { summary: "Delete a take" },

  // Scores.
  "GET /tracks/{id}/score-marks": { summary: "List a track's score marks" },
  "POST /tracks/{id}/score-marks": { summary: "Mark an issue in a track's score" },
  "PATCH /score-marks/{id}": { summary: "Change a score mark" },
  "DELETE /score-marks/{id}": { summary: "Remove a score mark" },
  "GET /projects/{id}/score-categories": { summary: "List a project's score mark categories" },
  "POST /projects/{id}/score-categories": {
    summary: "Make a score mark category",
    request: { name: "Wrong note", colour: "signal", key: "1" },
  },
  "PATCH /score-categories/{id}": {
    summary: "Change a score mark category",
    request: { name: "Wrong note", colour: "blue", key: "2" },
  },
  "DELETE /score-categories/{id}": {
    summary: "Delete a score mark category",
    description: "Its marks stay, without a category.",
  },

  // Production.
  "GET /projects/{id}/patch": { summary: "Read a project's patch" },
  "GET /projects/{id}/patch/{format}": {
    summary: "Download a project's patch",
    produces: [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
  },
  "POST /projects/{id}/stage-boxes": { summary: "Add a stage box to the patch" },
  "PATCH /stage-boxes/{id}": { summary: "Change a stage box" },
  "DELETE /stage-boxes/{id}": { summary: "Remove a stage box" },
  "POST /stage-boxes/{id}/rows": { summary: "Add a row to a stage box" },
  "PATCH /patch-rows/{id}": { summary: "Change a patch row" },
  "DELETE /patch-rows/{id}": { summary: "Remove a patch row" },
  "GET /projects/{id}/stage-plans": { summary: "List a project's stage plans" },
  "POST /projects/{id}/stage-plans": { summary: "Make a stage plan" },
  "GET /stage-plans/{id}/pdf/{paper}": {
    summary: "Download a stage plan",
    produces: "application/pdf",
  },
  "PATCH /stage-plans/{id}": { summary: "Change a stage plan" },
  "DELETE /stage-plans/{id}": { summary: "Delete a stage plan" },
  "POST /stage-plans/{id}/edits": {
    summary: "Edit a stage plan",
    description:
      "One step: what it adds, changes and removes, all or nothing. A step sent again changes nothing more.",
    request: { remove: [ids.folder] },
  },
  "GET /projects/{id}/personnel": { summary: "List a project's personnel" },
  "POST /projects/{id}/personnel": { summary: "Add someone to a project's personnel" },
  "PUT /personnel/{id}": { summary: "Change someone in the personnel" },
  "DELETE /personnel/{id}": { summary: "Remove someone from the personnel" },
  "GET /projects/{id}/repertoire": {
    summary: "Read a project's repertoire",
    description: "Its works, with their tracks, and its venues.",
  },
  "POST /projects/{id}/works": { summary: "Add a work to the repertoire" },
  "PUT /works/{id}": { summary: "Change a work" },
  "PATCH /works/{id}/tracks/{trackId}": { summary: "Number one of a work's tracks" },
  "DELETE /works/{id}": { summary: "Remove a work" },
  "POST /projects/{id}/venues": { summary: "Add a venue" },
  "PUT /venues/{id}": { summary: "Change a venue" },
  "DELETE /venues/{id}": { summary: "Remove a venue" },
  "POST /projects/{id}/croom/preview": {
    summary: "Preview a ControlRoom import",
    description:
      "What importing a ControlRoom project file (.croom) would create, counted by kind, with what is already in the project and what the file holds that is not brought over. Writes nothing. At most 200 MB, sent as the body; for those who may manage the project.",
    body: { type: "application/octet-stream", description: "The .croom file's bytes." },
  },
  "POST /projects/{id}/croom/import": {
    summary: "Import a ControlRoom project",
    description:
      "Writes everything the preview counted into the project in one transaction, its embedded scores and attached files stored encrypted as uploads. The file is sent again, as nothing of it is kept after the preview.",
    status: 201,
    body: { type: "application/octet-stream", description: "The .croom file's bytes." },
  },
  "GET /projects/{id}/schedule": { summary: "Read a project's schedule" },
  "GET /projects/{id}/schedule/{format}": {
    summary: "Download a project's schedule",
    produces: [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
  },
  "POST /projects/{id}/schedule-days": { summary: "Add a day to the schedule" },
  "PUT /schedule-days/{id}": { summary: "Change a schedule day" },
  "DELETE /schedule-days/{id}": { summary: "Remove a schedule day" },
  "POST /schedule-days/{id}/rows": { summary: "Add a slot to a schedule day" },
  "PUT /schedule-rows/{id}": { summary: "Change a schedule slot" },
  "PATCH /schedule-rows/{id}/done": { summary: "Mark a schedule slot done, or not" },
  "POST /schedule-rows/{id}/move": { summary: "Move a schedule slot" },
  "DELETE /schedule-rows/{id}": { summary: "Remove a schedule slot" },

  // Tasks.
  "GET /projects/{id}/tasks": { summary: "List a project's tasks" },
  "GET /projects/{id}/tasks.csv": {
    summary: "Download a project's tasks",
    produces: "text/csv",
  },
  "POST /projects/{id}/tasks": { summary: "Make a task" },
  "GET /tasks/{id}": { summary: "Read a task" },
  "PATCH /tasks/{id}": { summary: "Change a task" },
  "POST /tasks/{id}/notes": { summary: "Add a note to a task" },
  "DELETE /tasks/{id}": { summary: "Delete a task" },
  "GET /projects/{id}/board": {
    summary: "Read a project's board",
    description: "Its tracks and files in columns by status.",
  },
  "PUT /projects/{id}/board/display": {
    summary: "Set how a project's board is arranged by default",
    description:
      "Its grouping, what the cards carry and the columns put away, for everyone who has not chosen their own. For those who may manage the project.",
  },
  "GET /projects/{id}/calendar": {
    summary: "Read a project's calendar",
    description:
      "A month (or a range of days) of its sessions, schedule, entries, and the reviews, tracks and tasks due.",
  },
  "POST /projects/{id}/calendar/entries": {
    summary: "Add an entry to a project's calendar",
    description:
      "A session, a delivery, a meeting or anything else dated. A session entry books a recording session as well. For those who edit the schedule.",
  },
  "PATCH /calendar-entries/{id}": { summary: "Change a calendar entry" },
  "DELETE /calendar-entries/{id}": {
    summary: "Remove a calendar entry",
    description: "A session it booked stays.",
  },

  // Tags and categories.
  "GET /tags": { summary: "List the workspace's tags" },
  "POST /tags": { summary: "Make a tag" },
  "PATCH /tags/{id}": { summary: "Change a tag", description: "Admins only." },
  "DELETE /tags/{id}": { summary: "Delete a tag", description: "Admins only." },
  "GET /projects/{id}/categories": { summary: "List a project's comment categories" },
  "POST /projects/{id}/categories": { summary: "Make a comment category" },
  "PATCH /categories/{id}": { summary: "Change a comment category" },
  "DELETE /categories/{id}": {
    summary: "Delete a comment category",
    description: "Its comments keep everything else, without a category.",
  },
};
