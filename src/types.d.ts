import { ValidateFn, SelectFn } from 'libp2p-interfaces/src/types'

export type SubscriptionKeyFn = (key: Uint8Array) => Promise<Uint8Array> | Uint8Array
export interface Validator {
  validate: ValidateFn,
  select: SelectFn
}
