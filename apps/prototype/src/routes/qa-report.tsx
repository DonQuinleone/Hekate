import { Icon } from "~/components/icons";
import { Page } from "~/components/page";
import { usePageHeader } from "~/components/page-header";
import { QaReportDocument } from "~/components/qa-report";
import { Button } from "~/components/ui/button";
import { ActionMenu } from "~/components/ui/menu";
import { fileById, projects } from "~/data";
import { qaReportSample } from "~/data/qa-report";
import { useViewer } from "~/viewer/context";
import { Refused } from "~/viewer/state-gate";

/**
 * A recording's QA report as a page (#515): the document the PDF sets, under the file it is
 * about, with the PDF to download (branded, and marked for whoever takes it) and the CSV and
 * JSON beside it. Opened from QA's "QA report".
 */
export function QaReportPage({ fileId }: { fileId: string }) {
  const viewer = useViewer();
  const file = fileById(fileId);
  const project = projects.find((p) => p.id === file?.projectId);
  usePageHeader({
    crumbs: [
      { label: "Projects", to: "/projects" },
      ...(project ? [{ label: project.name, to: `/projects/${project.id}` }] : []),
      ...(file ? [{ label: file.name, to: `/files/${file.id}?view=qa` }] : []),
    ],
    title: "QA report",
    actions: (
      <>
        <Button variant="primary" size="sm">
          <Icon name="download" size={14} />
          Download PDF
        </Button>
        <ActionMenu
          always
          label="the QA report"
          actions={[
            { label: "Download CSV", onSelect: () => {} },
            { label: "Download JSON", onSelect: () => {} },
          ]}
        />
      </>
    ),
  });
  if (!file || !project || !viewer.canSee(project.id) || !viewer.tools(project.id).has("qa"))
    return <Refused />;
  // The sample is the seeded dry mix's; another file shows it under its own name.
  const doc = {
    ...qaReportSample,
    file: { ...qaReportSample.file, id: file.id, name: file.name },
  };
  return (
    <Page width="narrow">
      <QaReportDocument doc={doc} />
    </Page>
  );
}
