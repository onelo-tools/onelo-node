// Single source of truth for the SDK version AT RUNTIME. The source of truth
// on disk is `package.json` — this constant mirrors it, and `test/version.test.ts`
// fails the build if the two ever disagree. It cannot import the manifest: this
// file is compiled into `dist` with `rootDir: ./src`, so importing `../package.json`
// would either escape rootDir or inline the whole manifest into the bundle.
//
// So: bump `package.json`, then bump this line. The test tells you when you forget.
// Per repo CLAUDE.md: also update LATEST_SDK_VERSIONS['onelo-node'] in
// frontend/lib/sdk-version.ts so the dashboard can warn about outdated SDKs.
//
// This is a JS/TS SDK, so it uses the `-staging` suffix convention (NOT PEP 440
// like onelo-python). The Publish SDK workflow strips `-staging` before tagging.
export const VERSION = '0.10.1'
