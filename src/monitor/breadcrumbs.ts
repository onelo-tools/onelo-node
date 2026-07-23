/**
 * Per-request breadcrumb ring buffer. 1:1 with Python's `_breadcrumbs`. Bounded
 * FIFO — oldest entry evicted when full. Default capacity 100.
 */
import { type Breadcrumb, breadcrumbToWire } from './types'

export const DEFAULT_CAPACITY = 100

export class BreadcrumbBuffer {
  private buffer: Breadcrumb[] = []
  readonly capacity: number

  constructor(capacity = DEFAULT_CAPACITY) {
    if (capacity < 1) throw new Error('capacity must be >= 1')
    this.capacity = capacity
  }

  add(crumb: Breadcrumb): void {
    this.buffer.push(crumb)
    if (this.buffer.length > this.capacity) this.buffer.shift()
  }

  get length(): number {
    return this.buffer.length
  }

  clear(): void {
    this.buffer = []
  }

  toWire(): Array<Record<string, unknown>> {
    return this.buffer.map(breadcrumbToWire)
  }
}
