const METADATA_FIELDS = ["version", "id", "sourceName", "width", "height", "duration", "createdAt"];

export function reconcileProxyMetadata(existing, current) {
  const createdAt = typeof existing?.createdAt === "string" && existing.createdAt
    ? existing.createdAt
    : current.createdAt;
  const metadata = { ...current, createdAt };
  const needsWrite = !existing || METADATA_FIELDS.some((field) => !Object.is(existing[field], metadata[field]));
  return { metadata, needsWrite };
}
