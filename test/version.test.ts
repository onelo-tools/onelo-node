import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { VERSION } from '../src/version'
import { USER_AGENT } from '../src/features/consumer'

/**
 * The version the wire advertises must be the version we actually ship.
 *
 * `src/version.ts` is hand-written (it has to be: it is compiled into the
 * bundle, and `package.json` sits outside `rootDir`, so it cannot be imported
 * from `src` without dragging the whole manifest into dist). The manifest is
 * therefore the independent source of truth, and this test is the mechanism
 * that stops the two from silently disagreeing — a comment saying "bump this"
 * already failed twice (0.5.0 vs 0.6.1, then 0.5.0 vs 0.7.0, see #103).
 */
const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { version: string }

describe('SDK version', () => {
  it('matches the version in package.json', () => {
    expect(VERSION).toBe(manifest.version)
  })

  it('is advertised on the wire via the User-Agent', () => {
    expect(USER_AGENT).toBe(`onelo-node/${manifest.version}`)
  })
})
