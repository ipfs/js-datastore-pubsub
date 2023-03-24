import { Datastore, Key } from 'interface-datastore'
import { BaseDatastore } from 'datastore-core'
import { encodeBase32, keyToTopic, topicToKey } from './utils.js'
import { equals as uint8ArrayEquals } from 'uint8arrays/equals'
import { CodeError } from '@libp2p/interfaces/errors'
import { logger } from '@libp2p/logger'
import type { Message, PubSub } from '@libp2p/interface-pubsub'
import type { PeerId } from '@libp2p/interface-peer-id'
import type { SelectFn, ValidateFn } from '@libp2p/interface-dht'
import type { AbortOptions } from 'interface-store'

const log = logger('datastore-pubsub:publisher')

export interface SubscriptionKeyFn { (key: Uint8Array): Promise<Uint8Array> | Uint8Array }

/**
 * DatastorePubsub is responsible for providing an api for pubsub to be used as a datastore with
 * [TieredDatastore]{@link https://github.com/ipfs/js-datastore-core/blob/master/src/tiered.js}
 */
export class PubSubDatastore extends BaseDatastore {
  private readonly _pubsub: PubSub
  private readonly _datastore: Datastore
  private readonly _peerId: PeerId
  private readonly _validator: ValidateFn
  private readonly _selector: SelectFn
  private readonly _handleSubscriptionKeyFn?: SubscriptionKeyFn

  constructor (pubsub: PubSub, datastore: Datastore, peerId: PeerId, validator: ValidateFn, selector: SelectFn, subscriptionKeyFn?: SubscriptionKeyFn) {
    super()

    if (validator == null) {
      throw new CodeError('missing validator', 'ERR_INVALID_PARAMETERS')
    }

    if (typeof validator !== 'function') {
      throw new CodeError('missing validate function', 'ERR_INVALID_PARAMETERS')
    }

    if (typeof selector !== 'function') {
      throw new CodeError('missing select function', 'ERR_INVALID_PARAMETERS')
    }

    if ((subscriptionKeyFn != null) && typeof subscriptionKeyFn !== 'function') {
      throw new CodeError('invalid subscriptionKeyFn received', 'ERR_INVALID_PARAMETERS')
    }

    this._pubsub = pubsub
    this._datastore = datastore
    this._peerId = peerId
    this._validator = validator
    this._selector = selector
    this._handleSubscriptionKeyFn = subscriptionKeyFn

    // Bind _onMessage function, which is called by pubsub.
    this._onMessage = this._onMessage.bind(this)
    this._pubsub.addEventListener('message', (evt) => {
      this._onMessage(evt).catch(err => {
        log.error(err)
      })
    })
  }

  /**
   * Publishes a value through pubsub.
   *
   * @param {Uint8Array} key - identifier of the value to be published.
   * @param {Uint8Array} val - value to be propagated.
   * @param {AbortOptions} [options]
   */
  // @ts-expect-error Datastores take keys as Keys, this one takes Uint8Arrays
  async put (key: Uint8Array, val: Uint8Array, options?: AbortOptions): Promise<void> {
    if (!(key instanceof Uint8Array)) {
      const errMsg = 'datastore key does not have a valid format'

      log.error(errMsg)
      throw new CodeError(errMsg, 'ERR_INVALID_DATASTORE_KEY')
    }

    if (!(val instanceof Uint8Array)) {
      const errMsg = 'received value is not a Uint8Array'

      log.error(errMsg)
      throw new CodeError(errMsg, 'ERR_INVALID_VALUE_RECEIVED')
    }

    const stringifiedTopic = keyToTopic(key)

    log(`publish value for topic ${stringifiedTopic}`)

    // Publish record to pubsub
    await this._pubsub.publish(stringifiedTopic, val)
  }

  /**
   * Try to subscribe a topic with Pubsub and returns the local value if available
   */
  // @ts-expect-error Datastores take keys as Keys, this one takes Uint8Arrays
  async get (key: Uint8Array, options?: AbortOptions): Promise<Uint8Array> {
    if (!(key instanceof Uint8Array)) {
      const errMsg = 'datastore key does not have a valid format'

      log.error(errMsg)
      throw new CodeError(errMsg, 'ERR_INVALID_DATASTORE_KEY')
    }

    const stringifiedTopic = keyToTopic(key)
    const subscriptions = this._pubsub.getTopics()

    // If already subscribed, just try to get it
    if (subscriptions.includes(stringifiedTopic)) {
      return await this._getLocal(key, options)
    }

    // subscribe
    try {
      this._pubsub.subscribe(stringifiedTopic)
    } catch (err: any) {
      const errMsg = `cannot subscribe topic ${stringifiedTopic}`

      log.error(errMsg)
      throw new CodeError(errMsg, 'ERR_SUBSCRIBING_TOPIC')
    }
    log(`subscribed values for key ${stringifiedTopic}`)

    return await this._getLocal(key)
  }

  /**
   * Unsubscribe topic
   */
  unsubscribe (key: Uint8Array): void {
    const stringifiedTopic = keyToTopic(key)

    this._pubsub.unsubscribe(stringifiedTopic)
  }

  /**
   * Get record from local datastore
   */
  async _getLocal (key: Uint8Array, options?: AbortOptions): Promise<Uint8Array> {
    // encode key - base32(/ipns/{cid})
    const routingKey = new Key('/' + encodeBase32(key), false)
    let dsVal

    try {
      dsVal = await this._datastore.get(routingKey, options)
    } catch (err: any) {
      if (err.code !== 'ERR_NOT_FOUND') {
        const errMsg = `unexpected error getting the ipns record for ${routingKey.toString()}`

        log.error(errMsg)
        throw new CodeError(errMsg, 'ERR_UNEXPECTED_ERROR_GETTING_RECORD')
      }
      const errMsg = `local record requested was not found for ${routingKey.toString()}`

      log.error(errMsg)
      throw new CodeError(errMsg, 'ERR_NOT_FOUND')
    }

    if (!(dsVal instanceof Uint8Array)) {
      const errMsg = 'found record that we couldn\'t convert to a value'

      log.error(errMsg)
      throw new CodeError(errMsg, 'ERR_INVALID_RECORD_RECEIVED')
    }

    return dsVal
  }

  /**
   * handles pubsub subscription messages
   */
  async _onMessage (evt: CustomEvent<Message>): Promise<void> {
    const msg = evt.detail

    if (msg.type !== 'signed') {
      log.error('unsigned message received, this module can only work with signed messages')
      return
    }

    const { data, from, topic } = msg
    let key
    try {
      key = topicToKey(topic)
    } catch (err: any) {
      log.error(err)
      return
    }

    log(`message received for topic ${topic}`)

    // Stop if the message is from the peer (it already stored it while publishing to pubsub)
    if (this._peerId.equals(from)) {
      log('message discarded as it is from the same peer')
      return
    }

    if (this._handleSubscriptionKeyFn != null) {
      let res

      try {
        res = await this._handleSubscriptionKeyFn(key)
      } catch (err: any) {
        log.error('message discarded by the subscriptionKeyFn')
        return
      }

      key = res
    }

    try {
      await this._storeIfSubscriptionIsBetter(key, data)
    } catch (err: any) {
      log.error(err)
    }
  }

  /**
   * Store the received record if it is better than the current stored
   */
  async _storeIfSubscriptionIsBetter (key: Uint8Array, data: Uint8Array, options?: AbortOptions): Promise<void> {
    let isBetter = false

    try {
      isBetter = await this._isBetter(key, data)
    } catch (err: any) {
      if (err.code !== 'ERR_NOT_VALID_RECORD') {
        throw err
      }
    }

    if (isBetter) {
      await this._storeRecord(key, data, options)
    }
  }

  /**
   * Validate record according to the received validation function
   */
  async _validateRecord (key: Uint8Array, value: Uint8Array): Promise<void> { // eslint-disable-line require-await
    await this._validator(key, value)
  }

  /**
   * Select the best record according to the received select function
   */
  async _selectRecord (key: Uint8Array, records: Uint8Array[]): Promise<boolean> {
    const res = this._selector(key, records)

    // If the selected was the first (0), it should be stored (true)
    return res === 0
  }

  /**
   * Verify if the record received through pubsub is valid and better than the one currently stored
   */
  async _isBetter (key: Uint8Array, val: Uint8Array): Promise<boolean> {
    try {
      await this._validateRecord(key, val)
    } catch (err: any) {
      // If not valid, it is not better than the one currently available
      const errMsg = 'record received through pubsub is not valid'

      log.error(errMsg)
      throw new CodeError(errMsg, 'ERR_NOT_VALID_RECORD')
    }

    // Get Local record
    const dsKey = new Key(key)
    let currentRecord

    try {
      currentRecord = await this._getLocal(dsKey.uint8Array())
    } catch (err: any) {
      // if the old one is invalid, the new one is *always* better
      return true
    }

    // if the same record, do not need to store
    if (uint8ArrayEquals(currentRecord, val)) {
      return false
    }

    // verify if the received record should replace the current one
    return await this._selectRecord(key, [currentRecord, val])
  }

  /**
   * add record to datastore
   */
  async _storeRecord (key: Uint8Array, data: Uint8Array, options?: AbortOptions): Promise<void> {
    // encode key - base32(/ipns/{cid})
    const routingKey = new Key('/' + encodeBase32(key), false)

    await this._datastore.put(routingKey, data, options)
    log(`record for ${keyToTopic(key)} was stored in the datastore`)
  }
}
