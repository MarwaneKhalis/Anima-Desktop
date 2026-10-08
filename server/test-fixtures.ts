const LOCAL_HTTP_ORIGIN = /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/;

/** Accepts test offer URLs only from an explicitly allowlisted local fixture. */
export function resolveTestFixtureUrl(value: string | undefined, allowedOrigins: readonly string[]): string | undefined {
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("URL de fixture invalide.");
  }
  if (url.protocol !== "http:" || url.username || url.password || !LOCAL_HTTP_ORIGIN.test(url.origin) || !allowedOrigins.includes(url.origin)) {
    throw new Error("Une URL de fixture doit utiliser une origine HTTP locale explicitement autorisée.");
  }
  return url.href;
}
