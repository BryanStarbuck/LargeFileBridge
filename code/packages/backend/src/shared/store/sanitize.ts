// Path-segment safety (storage.mdx §4, §6.1). Never build a path from an unsanitized string.
export function sanitizeSegment(input: string): string {
  const cleaned = input
    .trim()
    .replace(/[/\\\0]/g, "_")
    .replace(/\.\.+/g, "_");
  if (!cleaned || cleaned === "." || cleaned === "..") return "_";
  return cleaned;
}

/** Repo folder key: lowercase, non [A-Za-z0-9._-] -> _ (storage.mdx §6.1). */
export function repoFolderKey(name: string): string {
  const key = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "_")
    .replace(/^\.+/, "_");
  return key || "repo";
}

/** Email folder key: lowercase + sanitized (storage.mdx §4). */
export function emailKey(email: string): string {
  return sanitizeSegment(email.toLowerCase());
}
