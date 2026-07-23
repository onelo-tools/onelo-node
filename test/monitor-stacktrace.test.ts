import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  capturedExceptionToWire,
  captureExceptionInfo,
  parseStack,
} from '../src/monitor/stacktrace'

describe('stacktrace', () => {
  it('parses a real Error into frames', () => {
    const err = new Error('boom')
    const captured = captureExceptionInfo(err)!
    expect(captured.type).toBe('Error')
    expect(captured.message).toBe('boom')
    expect(captured.frames.length).toBeGreaterThan(0)
    const top = captured.frames[0]!
    expect(top.lineno).toBeGreaterThan(0)
    expect(top.colno).toBeGreaterThan(0)
    expect(top.inApp).toBe(true) // this test file is not in node_modules
  })

  it('preserves the error subclass name as type', () => {
    class MyError extends Error {}
    const captured = captureExceptionInfo(new MyError('x'))!
    expect(captured.type).toBe('MyError')
  })

  it('walks the cause chain', () => {
    const root = new Error('root cause')
    const wrapped = new Error('wrapper', { cause: root })
    const captured = captureExceptionInfo(wrapped)!
    expect(captured.cause?.message).toBe('root cause')
  })

  it('handles a non-Error throw', () => {
    const captured = captureExceptionInfo('just a string')!
    expect(captured.message).toBe('just a string')
    expect(captured.frames).toEqual([])
  })

  it('classifies node_modules frames as not in-app', () => {
    const frames = parseStack(
      'Error: x\n    at foo (/app/src/index.js:10:5)\n    at bar (/app/node_modules/dep/lib.js:3:1)\n    at baz (node:internal/process:1:1)',
    )
    expect(frames[0]!.inApp).toBe(true)
    expect(frames[1]!.inApp).toBe(false)
    expect(frames[2]!.inApp).toBe(false)
  })

  it('serialises to OTel-ish wire shape', () => {
    const captured = captureExceptionInfo(new Error('boom'))!
    const wire = capturedExceptionToWire(captured)
    expect(wire.type).toBe('Error')
    expect(Array.isArray(wire.frames)).toBe(true)
    const frame = (wire.frames as Array<Record<string, unknown>>)[0]!
    expect(frame).toHaveProperty('in_app')
    expect(frame).toHaveProperty('lineno')
  })

  it('reads a source context_line for an in-app exception frame (not for current-stack)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'onelo-ctx-'))
    const file = join(dir, 'app.js') // not in node_modules → in-app
    writeFileSync(file, 'const a = 1\nconst boom = () => { throw new Error("x") }\nconst c = 3\n')
    try {
      const stack = `Error: x\n    at boom (${file}:2:30)`
      // Exception frames (includeContext=true) read the developer's source line.
      const withCtx = parseStack(stack, true)
      expect(withCtx[0]!.inApp).toBe(true)
      expect(withCtx[0]!.contextLine).toBe('const boom = () => { throw new Error("x") }')
      // Informational current-stack captures must NOT read source.
      expect(parseStack(stack)[0]!.contextLine).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
