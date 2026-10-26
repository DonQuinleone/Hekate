import type {
  MetadataChanges,
  MetadataCorrections,
  MetadataField,
  MetadataFormat,
} from "@hekate/shared";
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { json } from "./queries";

/** A recording's corrections to its embedded metadata, and whether this viewer may make them. */
export interface MetadataEditing {
  format: MetadataFormat | null;
  fields: MetadataField[];
  corrections: MetadataCorrections;
  editable: boolean;
}

export const metadataQuery = (fileId: string) =>
  queryOptions({
    queryKey: ["files", fileId, "metadata"],
    queryFn: async () =>
      json<MetadataEditing>(await api.files[":id"].metadata.$get({ param: { id: fileId } })),
    staleTime: 60_000,
  });

/**
 * Correct a recording's embedded metadata (decision 260). The file, its checks and its report
 * read the corrected values, so everything about the file is asked for again.
 */
export function useMetadataEdit(fileId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (changes: MetadataChanges["changes"]) =>
      json<{ corrections: MetadataCorrections }>(
        await api.files[":id"].metadata.$put({ param: { id: fileId }, json: { changes } }),
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: ["files", fileId] }),
  });
}
