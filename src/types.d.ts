import { Key } from 'interface-datastore'
import PeerId from 'peer-id'

type ValidateFn = (record: Uint8Array, peerId: Uint8Array) => boolean
type CompareFn = (received: Uint8Array, current: Uint8Array) => number
export type SubscriptionKeyFn = (key: Uint8Array) => Promise<Uint8Array>

export interface Validator {
  validate: ValidateFn,
  select: CompareFn
}
