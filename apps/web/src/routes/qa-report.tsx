import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Empty } from "~/components/empty";
import { Icon } from "~/components/icons";
import { Page } from "~/components/page";
import { PageHeader } from "~/components/page-header";
import { QaReportDocument } from "~/components/qa-report";
import { Button } from "~/components/ui/button";
import { ActionMenu } from "~/components/ui/menu";
import { fileQuery, projectQuery, qaDocumentQuery } from "~/lib/queries";

/** Takes a report away in a format: the server marks the PDF for whoever asked and logs it. */
const download = (fileId: string, format: "pdf" | "csv" | "json") =>
  window.location.assign(`/api/files/${fileId}/qa/report?format=${format}`);

/**
 * A recording's QA report as a page (#515): the document the PDF sets, under the file it is
 * about, with the PDF to download and the CSV and JSON beside it.
 */
export function QaReportPage({ fileId }: { fileId: string }) {
  const { data: doc, error } = useQuery(qaDocumentQuery(fileId));
  const { data: file } = useQuery(fileQuery(fileId));
  const { data: project } = useQuery({
    ...projectQuery(file?.projectId ?? ""),
    enabled: Boolean(file),
  });
  const crumbs = [
    { key: "projects", link: <Link to="/projects">Projects</Link> },
    ...(file && project
      ? [
          {
            key: "project",
            link: (
              <Link to="/projects/$projectId/files" params={{ projectId: file.projectId }}>
                {project.name}
              </Link>
            ),
          },
          {
            key: "file",
            link: (
              <Link to="/files/$fileId" params={{ fileId }} search={{ view: "qa" }}>
                {file.name}
              </Link>
            ),
          },
        ]
      : []),
  ];
  return (
    <>
      <PageHeader
        crumbs={crumbs}
        title="QA report"
        actions={
          doc && (
            <>
              <Button variant="primary" size="sm" onClick={() => download(fileId, "pdf")}>
                <Icon name="download" size={14} />
                Download PDF
              </Button>
              <ActionMenu
                always
                label="the QA report"
                actions={[
                  { label: "Download CSV", onSelect: () => download(fileId, "csv") },
                  { label: "Download JSON", onSelect: () => download(fileId, "json") },
                ]}
              />
            </>
          )
        }
      />
      <Page width="narrow">
        {error ? (
          <Empty title="No report for this file" text={error.message} />
        ) : !doc ? (
          <p className="m-0 text-ink-3">Loading</p>
        ) : (
          <QaReportDocument doc={doc} />
        )}
      </Page>
    </>
  );
}
