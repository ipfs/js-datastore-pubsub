'use strict'

const { Key, Adapter } = require('interface-datastore')
const { encodeBase32, keyToTopic, topicToKey } = require('./utils')
const uint8ArrayEquals = require('uint8arrays/equals')

const errcode = require('err-code')
const debug = require('debug')
const log = Object.assign(debug('datastore-pubsub:publisher'), {
  error: debug('datastore-pubsub:publisher:error')
})

/**
 * @typedef {import('peer-id')} PeerId
 * @typedef {import('./types').Validator} Validator
 * @typedef {import('./types').SubscriptionKeyFn} SubscriptionKeyFn
 * @typedef {import('libp2p-interfaces/src/pubsub').InMessage} PubSubMessage
 */

// DatastorePubsub is responsible for providing an api for pubsub to be used as a datastore with
// [TieredDatastore]{@link https://github.com/ipfs/js-datastore-core/blob/master/src/tiered.js}
class DatastorePubsub extends Adapter {
  /**
   * Creates an instance of DatastorePubsub.
   *
   * @param {import('libp2p-interfaces/src/pubsub')} pubsub - pubsub implementation
   * @param {import('interface-datastore').Datastore} datastore - datastore instance
   * @param {PeerId} peerId - peer-id instance
   * @param {Validator} validator - validator functions
   * @param {SubscriptionKeyFn} [subscriptionKeyFn] - function to manipulate the key topic received before processing it
   * @memberof DatastorePubsub
   */
  constructor (pubsub, datastore, peerId, validator, subscriptionKeyFn) {
    super()

    if (!validator) {
      throw errcode(new TypeError('missing validator'), 'ERR_INVALID_PARAMETERS')
    }

    if (typeof validator.validate !== 'function') {
      throw errcode(new TypeError('missing validate function'), 'ERR_INVALID_PARAMETERS')
    }

    if (typeof validator.select !== 'function') {
      throw errcode(new TypeError('missing select function'), 'ERR_INVALID_PARAMETERS')
    }

    if (subscriptionKeyFn && typeof subscriptionKeyFn !== 'function') {
      throw errcode(new TypeError('invalid subscriptionKeyFn received'), 'ERR_INVALID_PARAMETERS')
    }

    this._pubsub = pubsub
    this._datastore = datastore
    this._peerId = peerId
    this._validator = validator
    this._handleSubscriptionKeyFn = subscriptionKeyFn

    // Bind _onMessage function, which is called by pubsub.
    this._onMessage = this._onMessage.bind(this)
  }

  /**
   * Publishes a value through pubsub.
   *
   * @param {Uint8Array} key - identifier of the value to be published.
   * @param {Uint8Array} val - value to be propagated.
   */
  // @ts-ignore Datastores take keys as Keys, this one takes Uint8Arrays
  async put (key, val) {
    if (!(key instanceof Uint8Array)) {
      const errMsg = 'datastore key does not have a valid format'

      log.error(errMsg)
      throw errcode(new Error(errMsg), 'ERR_INVALID_DATASTORE_KEY')
    }

    if (!(val instanceof Uint8Array)) {
      const errMsg = 'received value is not a Uint8Array'

      log.error(errMsg)
      throw errcode(new Error(errMsg), 'ERR_INVALID_VALUE_RECEIVED')
    }

    const stringifiedTopic = keyToTopic(key)

    log(`publish value for topic ${stringifiedTopic}`)

    // Publish record to pubsub
    await this._pubsub.publish(stringifiedTopic, val)
  }

  /**
   * Try to subscribe a topic with Pubsub and returns the local value if available.
   *
   * @param {Uint8Array} key - identifier of the value to be subscribed.
   */
  // @ts-ignore Datastores take keys as Keys, this one takes Uint8Arrays
  async get (key) {
    if (!(key instanceof Uint8Array)) {
      const errMsg = 'datastore key does not have a valid format'

      log.error(errMsg)
      throw errcode(new Error(errMsg), 'ERR_INVALID_DATASTORE_KEY')
    }

    const stringifiedTopic = keyToTopic(key)
    const subscriptions = await this._pubsub.getTopics()

    // If already subscribed, just try to get it
    if (subscriptions && Array.isArray(subscriptions) && subscriptions.indexOf(stringifiedTopic) > -1) {
      return this._getLocal(key)
    }

    // subscribe
    try {
      this._pubsub.on(stringifiedTopic, this._onMessage)
      await this._pubsub.subscribe(stringifiedTopic)
    } catch (err) {
      const errMsg = `cannot subscribe topic ${stringifiedTopic}`

      log.error(errMsg)
      throw errcode(new Error(errMsg), 'ERR_SUBSCRIBING_TOPIC')
    }
    log(`subscribed values for key ${stringifiedTopic}`)

    return this._getLocal(key)
  }

  /**
   * Unsubscribe topic.
   *
   * @param {Uint8Array} key - identifier of the value to unsubscribe.
   * @returns {void}
   */
  unsubscribe (key) {
    const stringifiedTopic = keyToTopic(key)

    this._pubsub.removeListener(stringifiedTopic, this._onMessage)
    return this._pubsub.unsubscribe(stringifiedTopic)
  }

  /**
   * Get record from local datastore
   *
   * @private
   * @param {Uint8Array} key
   */
  async _getLocal (key) {
    // encode key - base32(/ipns/{cid})
    const routingKey = new Key('/' + encodeBase32(key), false)
    let dsVal

    try {
      dsVal = await this._datastore.get(routingKey)
    } catch (err) {
      if (err.code !== 'ERR_NOT_FOUND') {
        const errMsg = `unexpected error getting the ipns record for ${routingKey.toString()}`

        log.error(errMsg)
        throw errcode(new Error(errMsg), 'ERR_UNEXPECTED_ERROR_GETTING_RECORD')
      }
      const errMsg = `local record requested was not found for ${routingKey.toString()}`

      log.error(errMsg)
      throw errcode(new Error(errMsg), 'ERR_NOT_FOUND')
    }

    if (!(dsVal instanceof Uint8Array)) {
      const errMsg = 'found record that we couldn\'t convert to a value'

      log.error(errMsg)
      throw errcode(new Error(errMsg), 'ERR_INVALID_RECORD_RECEIVED')
    }

    return dsVal
  }

  /**
   * handles pubsub subscription messages
   *
   * @param {PubSubMessage} msg
   */
  async _onMessage (msg) {
    const { data, from, topicIDs } = msg
    let key
    try {
      key = topicToKey(topicIDs[0])
    } catch (err) {
      log.error(err)
      return
    }

    log(`message received for topic ${topicIDs[0]}`)

    // Stop if the message is from the peer (it already stored it while publishing to pubsub)
    if (from === this._peerId.toB58String()) {
      log('message discarded as it is from the same peer')
      return
    }

    if (this._handleSubscriptionKeyFn) {
      let res

      try {
        res = await this._handleSubscriptionKeyFn(key)
      } catch (err) {
        log.error('message discarded by the subscriptionKeyFn')
        return
      }

      key = res
    }

    try {
      await this._storeIfSubscriptionIsBetter(key, data)
    } catch (err) {
      log.error(err)
    }
  }

  /**
   * Store the received record if it is better than the current stored
   *
   * @param {Uint8Array} key
   * @param {Uint8Array} data
   */
  async _storeIfSubscriptionIsBetter (key, data) {
    let isBetter = false

    try {
      isBetter = await this._isBetter(key, data)
    } catch (err) {
      if (err.code !== 'ERR_NOT_VALID_RECORD') {
        throw err
      }
    }

    if (isBetter) {
      await this._storeRecord(key, data)
    }
  }

  /**
   * Validate record according to the received validation function
   *
   * @param {Uint8Array} value
   * @param {Uint8Array} peerId
   */
  async _validateRecord (value, peerId) { // eslint-disable-line require-await
    return this._validator.validate(value, peerId)
  }

  /**
   * Select the best record according to the received select function
   *
   * @param {Uint8Array} key
   * @param {Uint8Array[]} records
   */
  async _selectRecord (key, records) {
    const res = await this._validator.select(key, records)

    // If the selected was the first (0), it should be stored (true)
    return res === 0
  }

  /**
   * Verify if the record received through pubsub is valid and better than the one currently stored
   *
   * @param {Uint8Array} key
   * @param {Uint8Array} val
   */
  async _isBetter (key, val) {
    try {
      await this._validateRecord(val, key)
    } catch (err) {
      // If not valid, it is not better than the one currently available
      const errMsg = 'record received through pubsub is not valid'

      log.error(errMsg)
      throw errcode(new Error(errMsg), 'ERR_NOT_VALID_RECORD')
    }

    // Get Local record
    const dsKey = new Key(key)
    let currentRecord

    try {
      currentRecord = await this._getLocal(dsKey.uint8Array())
    } catch (err) {
      // if the old one is invalid, the new one is *always* better
      return true
    }

    // if the same record, do not need to store
    if (uint8ArrayEquals(currentRecord, val)) {
      return false
    }

    // verify if the received record should replace the current one
    return this._selectRecord(key, [currentRecord, val])
  }

  /**
   * add record to datastore
   *
   * @param {Uint8Array} key
   * @param {Uint8Array} data
   */
  async _storeRecord (key, data) {
    // encode key - base32(/ipns/{cid})
    const routingKey = new Key('/' + encodeBase32(key), false)

    await this._datastore.put(routingKey, data)
    log(`record for ${keyToTopic(key)} was stored in the datastore`)
  }
}

exports = module.exports = DatastorePubsub
