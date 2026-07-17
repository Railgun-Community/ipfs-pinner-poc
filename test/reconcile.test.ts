import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CID } from 'multiformats/cid'

import { diffPinsets, mergeSources } from '../src/reconcile.js'
import type { PinEntry } from '../src/types.js'

const CID_A = CID.parse('QmUsmnK4PFc7zDp2cmC4wBZxYLjNyRgWfs5GNcJJ2uLcpU')
const CID_B = CID.parse('QmZrP9zaZw2LwErT2yA6VpMWm65UdToQiKj4DtStVsUJHr')

test('mergeSources dedupes identical CIDs across sources', () => {
  const entryA: PinEntry = { cid: CID_A, name: 'railgun/static/a' }
  const entryB: PinEntry = { cid: CID_A, name: 'railgun/static/a' }
  const merged = mergeSources([[entryA], [entryB]])
  assert.equal(merged.length, 1)
  assert.equal(merged[0], entryA)
})

test('mergeSources keeps the first source on a name conflict', () => {
  const first: PinEntry = { cid: CID_A, name: 'railgun/static/first' }
  const second: PinEntry = { cid: CID_A, name: 'railgun/static/second' }
  const merged = mergeSources([[first], [second]])
  assert.equal(merged.length, 1)
  assert.equal(merged[0]?.name, 'railgun/static/first')
})

test('mergeSources concatenates distinct CIDs from multiple sources', () => {
  const entryA: PinEntry = { cid: CID_A, name: 'railgun/static/a' }
  const entryB: PinEntry = { cid: CID_B, name: 'railgun/static/b' }
  const merged = mergeSources([[entryA], [entryB]])
  assert.equal(merged.length, 2)
  assert.deepEqual(merged, [entryA, entryB])
})

test('mergeSources handles empty input', () => {
  assert.deepEqual(mergeSources([]), [])
  assert.deepEqual(mergeSources([[], []]), [])
})

test('diffPinsets returns only entries missing from the actual pinset', () => {
  const entryA: PinEntry = { cid: CID_A, name: 'railgun/static/a' }
  const entryB: PinEntry = { cid: CID_B, name: 'railgun/static/b' }
  const missing = diffPinsets([entryA, entryB], new Set([CID_A.toString()]))
  assert.equal(missing.length, 1)
  assert.equal(missing[0], entryB)
})

test('diffPinsets returns everything when actual pinset is empty', () => {
  const entryA: PinEntry = { cid: CID_A, name: 'railgun/static/a' }
  assert.deepEqual(diffPinsets([entryA], new Set()), [entryA])
})

test('diffPinsets returns nothing when everything is already pinned', () => {
  const entryA: PinEntry = { cid: CID_A, name: 'railgun/static/a' }
  assert.deepEqual(diffPinsets([entryA], new Set([CID_A.toString()])), [])
})
