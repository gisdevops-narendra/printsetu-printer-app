/**
 * This build's version, from build-info.json (written by
 * scripts/write-build-info.js at build time and bundled by pkg). "dev" when
 * running from source or built without a version: such a build never
 * replaces itself.
 */
function readVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (require('../build-info.json') as { version?: string }).version || 'dev';
  } catch {
    return 'dev';
  }
}

export const AGENT_VERSION = readVersion();
