import { logger } from './logger.js'
import type { PinEntry } from './types.js'

/**
 * Flatten collected entries from all sources and dedupe by CID. On a name
 * conflict for the same CID, the first source wins and a warning is logged.
 * @param collected - One `PinEntry[]` per source.
 * @returns The deduped desired pinset.
 */
function mergeSources (collected: PinEntry[][]): PinEntry[] {
  const merged: PinEntry[] = []
  const seen = new Map<string, PinEntry>()

  for (const entries of collected) {
    for (const entry of entries) {
      const key = entry.cid.toString()
      const existing = seen.get(key)
      if (existing === undefined) {
        seen.set(key, entry)
        merged.push(entry)
        continue
      }
      if (existing.name !== entry.name) {
        logger.warn('pin name conflict for CID, keeping first source', {
          cid: key,
          kept: existing.name,
          dropped: entry.name
        })
      }
    }
  }

  return merged
}

/**
 * Compute the entries in the desired pinset that are not already pinned.
 * @param desired - The merged, deduped desired pinset.
 * @param actualCids - CIDs (as strings) the Kubo node already has pinned.
 * @returns Entries that still need to be pinned.
 */
function diffPinsets (desired: PinEntry[], actualCids: ReadonlySet<string>): PinEntry[] {
  return desired.filter(entry => !actualCids.has(entry.cid.toString()))
}

export { diffPinsets, mergeSources }
