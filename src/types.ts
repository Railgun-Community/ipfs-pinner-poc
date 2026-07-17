import type { CID } from 'multiformats/cid'

/** One `{ cid, name }` pair — the unit the whole tool moves around. */
type PinEntry = {
  cid: CID
  name: string
}

/** Anything that can produce pin entries. Sources never talk to the Kubo node. */
interface PinSource {
  collect(): Promise<PinEntry[]>
}

export type { PinEntry, PinSource }
