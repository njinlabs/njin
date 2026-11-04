// The version of the admin package (@njinlabs/njin-admin) a new plugin is written against: the
// highest any dist-tag points to. `latest` alone can lag behind while the package is in beta
// (it pointed at beta.1 when beta.2 was out).
export const highestVersion = (versions: string[]): string | undefined =>
  [...versions].sort((a, b) => Bun.semver.order(b, a))[0];

export const adminPackageVersion = async (
  fetchFn: typeof fetch = fetch,
): Promise<
  | { found: true; version: string }
  | { found: false; version: string; reason: string }
> => {
  const fallback = "beta";

  try {
    const res = await fetchFn(
      "https://registry.npmjs.org/@njinlabs/njin-admin",
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const tags = (
      (await res.json()) as { "dist-tags"?: Record<string, string> }
    )["dist-tags"];
    const version = highestVersion(Object.values(tags ?? {}));
    if (!version) throw new Error("no versions listed");

    return { found: true, version };
  } catch (error) {
    return {
      found: false,
      version: fallback,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
};
