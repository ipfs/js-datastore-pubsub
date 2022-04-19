export interface SubscriptionKeyFn { (key: Uint8Array): Promise<Uint8Array> | Uint8Array }
