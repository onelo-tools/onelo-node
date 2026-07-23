// Single source of truth for the SDK version. Bump on EVERY src change.
// Per repo CLAUDE.md: also update LATEST_SDK_VERSIONS['onelo-node'] in
// frontend/lib/sdk-version.ts so the dashboard can warn about outdated SDKs.
//
// This is a JS/TS SDK, so it uses the `-staging` suffix convention (NOT PEP 440
// like onelo-python). The Publish SDK workflow strips `-staging` before tagging.
export const VERSION = '0.5.0-staging'
