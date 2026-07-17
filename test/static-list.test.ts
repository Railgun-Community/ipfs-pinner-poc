import assert from 'node:assert/strict'
import { test } from 'node:test'

import { StaticListSource } from '../src/static-list.js'

const VALID_A = 'QmUsmnK4PFc7zDp2cmC4wBZxYLjNyRgWfs5GNcJJ2uLcpU'
const VALID_B = 'QmZrP9zaZw2LwErT2yA6VpMWm65UdToQiKj4DtStVsUJHr'

test('collects valid entries under railgun/static names', async () => {
  const source = new StaticListSource([
    { cid: VALID_A, name: 'railgun-artifacts' },
    { cid: VALID_B, name: 'ppoi-artifacts' }
  ])
  const entries = await source.collect()
  assert.equal(entries.length, 2)
  assert.equal(entries[0]?.name, 'railgun/static/railgun-artifacts')
  assert.equal(entries[0]?.cid.toString(), VALID_A)
  assert.equal(entries[1]?.name, 'railgun/static/ppoi-artifacts')
})

test('skips entries with invalid CIDs', async () => {
  const source = new StaticListSource([
    { cid: 'not-a-cid', name: 'garbage' },
    { cid: '', name: 'empty' },
    { cid: VALID_A, name: 'ok' }
  ])
  const entries = await source.collect()
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.name, 'railgun/static/ok')
})

test('skips duplicate CIDs, first entry wins', async () => {
  const source = new StaticListSource([
    { cid: VALID_A, name: 'first' },
    { cid: VALID_A, name: 'second' }
  ])
  const entries = await source.collect()
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.name, 'railgun/static/first')
})

test('defaults to the checked-in JSON list', async () => {
  const entries = await new StaticListSource().collect()
  assert.equal(entries.length, 2)
  assert.deepEqual(
    entries.map(entry => entry.name).sort(),
    ['railgun/static/ppoi-artifacts', 'railgun/static/railgun-artifacts']
  )
})
