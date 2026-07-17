import { CID } from 'multiformats/cid'

import { logger } from './logger.js'
import checkedInList from './static-list.json' with { type: 'json' }
import type { PinEntry, PinSource } from './types.js'

type RawStaticEntry = {
  cid: string
  name: string
}

/**
 * Pin source backed by the JSON list checked into the repo — the entry point
 * for content with no on-chain source (e.g. Security Request documents).
 */
class StaticListSource implements PinSource {
  #entries: RawStaticEntry[]

  constructor (entries: RawStaticEntry[] = checkedInList) {
    this.#entries = entries
  }

  collect (): Promise<PinEntry[]> {
    const collected: PinEntry[] = []
    const seen = new Set<string>()
    for (const entry of this.#entries) {
      let cid: CID
      try {
        cid = CID.parse(entry.cid)
      } catch {
        logger.warn('static list entry has invalid CID, skipping', { name: entry.name, cid: entry.cid })
        continue
      }
      const key = cid.toString()
      if (seen.has(key)) {
        logger.warn('static list entry has duplicate CID, skipping', { name: entry.name, cid: key })
        continue
      }
      seen.add(key)
      collected.push({ cid, name: `railgun/static/${entry.name}` })
    }
    return Promise.resolve(collected)
  }
}

export { StaticListSource }
export type { RawStaticEntry }
