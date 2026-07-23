import { describe, expect, it } from 'vitest'
import { SseParser } from '../src/features/sse-parser'

describe('SseParser', () => {
  it('parses a single event frame', () => {
    const p = new SseParser()
    const events = p.push('event: connected\ndata: {"a":1}\n\n')
    expect(events).toEqual([{ event: 'connected', data: '{"a":1}' }])
  })

  it('handles a frame split across chunks', () => {
    const p = new SseParser()
    expect(p.push('event: conn')).toEqual([])
    expect(p.push('ected\ndata: {"a')).toEqual([])
    expect(p.push('":1}\n\n')).toEqual([{ event: 'connected', data: '{"a":1}' }])
  })

  it('parses multiple frames in one chunk', () => {
    const p = new SseParser()
    const events = p.push('event: up_to_date\ndata: {}\n\nevent: features_updated\ndata: {"x":2}\n\n')
    expect(events).toEqual([
      { event: 'up_to_date', data: '{}' },
      { event: 'features_updated', data: '{"x":2}' },
    ])
  })

  it('ignores comment/heartbeat lines', () => {
    const p = new SseParser()
    expect(p.push(': keepalive\n\n')).toEqual([])
    expect(p.push('event: connected\ndata: {}\n\n')).toEqual([{ event: 'connected', data: '{}' }])
  })

  it('joins multi-line data', () => {
    const p = new SseParser()
    const events = p.push('data: line1\ndata: line2\n\n')
    expect(events).toEqual([{ event: '', data: 'line1\nline2' }])
  })

  it('handles CRLF line endings', () => {
    const p = new SseParser()
    const events = p.push('event: connected\r\ndata: {}\r\n\r\n')
    expect(events).toEqual([{ event: 'connected', data: '{}' }])
  })

  it('strips a single leading space after the colon', () => {
    const p = new SseParser()
    expect(p.push('data:nospace\n\n')).toEqual([{ event: '', data: 'nospace' }])
    expect(p.push('data:  two\n\n')).toEqual([{ event: '', data: ' two' }])
  })
})
