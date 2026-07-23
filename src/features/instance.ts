/**
 * Per-install instance UUID. 1:1 with Python's `onelo._instance`. Persisted
 * under ${ONELO_INSTANCE_DIR} (default ~/.onelo). Override with ONELO_INSTANCE_ID
 * for containerized deploys where the filesystem is ephemeral.
 *
 * The backend's TOFU discovery binding keys off this id (X-Onelo-Instance-Id),
 * so it must stay stable across restarts on the same host.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

let cachedFileId: string | null = null
let ephemeralId: string | null = null

function instanceDir(): string {
  return process.env.ONELO_INSTANCE_DIR || join(homedir(), '.onelo')
}

export function getInstanceId(): string {
  // Env override always wins and is re-read each call (containers set it per run).
  const env = process.env.ONELO_INSTANCE_ID
  if (env) return env

  if (cachedFileId) return cachedFileId

  try {
    const dir = instanceDir()
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'onelo-instance-id')
    if (existsSync(file)) {
      const existing = readFileSync(file, 'utf8').trim()
      if (existing) {
        cachedFileId = existing
        return existing
      }
    }
    const id = randomUUID()
    writeFileSync(file, id)
    cachedFileId = id
    return id
  } catch {
    // Read-only / unavailable filesystem — fall back to a process-lifetime id so
    // discovery still has a stable value within this run.
    if (!ephemeralId) ephemeralId = randomUUID()
    return ephemeralId
  }
}
