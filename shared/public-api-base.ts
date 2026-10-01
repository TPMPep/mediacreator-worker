// Worker mirror of the canonical backend/frontend public-origin declaration.
// Kept separate from env parsing; parity is enforced by the app regression suite.
export const PRODUCTION_PUBLIC_API_BASE = 'https://mediacreator.blutools.io';
export function resolvePublicApiBase(override?: string): string {
  const value = override?.trim() || PRODUCTION_PUBLIC_API_BASE;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('PUBLIC_API_BASE_URL must be a bare HTTPS origin');
  }
  return url.origin;
}
