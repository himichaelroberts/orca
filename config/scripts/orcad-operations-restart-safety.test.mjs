import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const operationsGuide = readFileSync('docs/reference/orcad-operations.md', 'utf8')
const operationsProse = operationsGuide.replace(/\s+/g, ' ')

describe('orcad operations restart safety', () => {
  it('distinguishes PID-scoped preservation from systemd cgroup teardown', () => {
    expect(operationsProse).toContain(
      'This makes a PID-scoped update, rollback or restart non-destructive to live work'
    )
    expect(operationsProse).toContain(
      'The successor adopts the current endpoint and routes supported previous protocol versions through legacy adapters'
    )
    expect(operationsProse).toContain('`KillMode=mixed` does **not** preserve them')
    expect(operationsProse).toContain(
      '`KillMode=process` leaves service-owned processes unmanaged and is not a supported preservation mechanism'
    )
  })

  it('fails closed before cgroup-wide maintenance', () => {
    expect(operationsProse).toContain(
      'A safe empty census is untruncated, has an explicit `hostScope`, covers every expected execution host, has no `omittedHostIds`, and lists no terminals'
    )
    expect(operationsProse).toContain(
      'Missing scope, truncation, an omitted host, a failed request or lost contact makes the result `unverifiable`'
    )
    expect(operationsProse).toContain('Orca does not yet provide an atomic census-and-stop fence')
  })

  it('does not refer to the unavailable shipping design', () => {
    expect(operationsGuide).not.toContain('docs/design/shipping-orcad.html')
  })
})
