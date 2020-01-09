'use strict'

const { Key } = require('interface-datastore')
const { encodeBase32, keyToTopic, topicToKey } = require('./utils')

const errcode = require('err-code')
const debug = require('debug')
const log = debug('datastore-pubsub:publisher')
log.error = debug('datastore-pubsub:publisher:error')

// DatastorePubsub is responsible for providing an api for pubsub to be used as a datastore with
// [TieredDatastore]{@link https://github.com/ipfs/js-datastore-core/blob/master/src/tiered.js}
class DatastorePubsub {
  /**
   * Creates an instance of DatastorePubsub.
   * @param {*} pubsub - pubsub implementation.
   * @param {*} datastore - datastore instance.
   * @param {*} peerId - peer-id instance.
   * @param {Object} validator - validator functions.
   * @param {function(record, peerId, callback)} validator.validate - function to validate a record.
   * @param {function(received, current, callback)} validator.select - function to select the newest between two records.
   * @param {function(key, callback)} subscriptionKeyFn - optional function to manipulate the key topic received before processing it.
   * @memberof DatastorePubsub
   */
  constructor (pubsub, datastore, peerId, validator, subscriptionKeyFn) {
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
   * @param {Buffer} key identifier of the value to be published.
   * @param {Buffer} val value to be propagated.
   * @returns {Promise}
   */
  async put (key, val) { // eslint-disable-line require-await
    if (!Buffer.isBuffer(key)) {
      const errMsg = 'datastore key does not have a valid format'

      log.error(errMsg)
      throw errcode(new Error(errMsg), 'ERR_INVALID_DATASTORE_KEY')
    }

    if (!Buffer.isBuffer(val)) {
      const errMsg = 'received value is not a buffer'

      log.error(errMsg)
      throw errcode(new Error(errMsg), 'ERR_INVALID_VALUE_RECEIVED')
    }

    const stringifiedTopic = keyToTopic(key)

    log(`publish value for topic ${stringifiedTopic}`)

    // Publish record to pubsub
    return this._pubsub.publish(stringifiedTopic, val)
  }

  /**
   * Try to subscribe a topic with Pubsub and returns the local value if available.
   * @param {Buffer} key identifier of the value to be subscribed.
   * @returns {Promise<Buffer>}
   */
  async get (key) {
    if (!Buffer.isBuffer(key)) {
      const errMsg = 'datastore key does not have a valid format'

      log.error(errMsg)
      throw errcode(new Error(errMsg), 'ERR_INVALID_DATASTORE_KEY')
    }

    const stringifiedTopic = keyToTopic(key)
    const subscriptions = await this._pubsub.ls()

    // If already subscribed, just try to get it
    if (subscriptions && Array.isArray(subscriptions) && subscriptions.indexOf(stringifiedTopic) > -1) {
      return this._getLocal(key)
    }

    // subscribe
    try {
      await this._pubsub.subscribe(stringifiedTopic, this._onMessage)
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
   * @param {Buffer} key identifier of the value to unsubscribe.
   * @returns {void}
   */
  unsubscribe (key) {
    const stringifiedTopic = keyToTopic(key)

    return this._pubsub.unsubscribe(stringifiedTopic, this._onMessage)
  }

  // Get record from local datastore
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

    if (!Buffer.isBuffer(dsVal)) {
      const errMsg = 'found record that we couldn\'t convert to a value'

      log.error(errMsg)
      throw errcode(new Error(errMsg), 'ERR_INVALID_RECORD_RECEIVED')
    }

    return dsVal
  }

  // handles pubsub subscription messages
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

  // Store the received record if it is better than the current stored
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
      await this._storeRecord(Buffer.from(key), data)
    }
  }

  // Validate record according to the received validation function
  async _validateRecord (value, peerId) { // eslint-disable-line require-await
    return this._validator.validate(value, peerId)
  }

  // Select the best record according to the received select function.
  async _selectRecord (receivedRecord, currentRecord) {
    const res = await this._validator.select(receivedRecord, currentRecord)

    // If the selected was the first (0), it should be stored (true)
    return res === 0
  }

  // Verify if the record received through pubsub is valid and better than the one currently stored
  async _isBetter (key, val) {
    // validate received record
    let error, valid

    try {
      valid = await this._validateRecord(val, key)
    } catch (err) {
      error = err
    }

    // If not valid, it is not better than the one currently available
    if (error || !valid) {
      const errMsg = 'record received through pubsub is not valid'

      log.error(errMsg)
      throw errcode(new Error(errMsg), 'ERR_NOT_VALID_RECORD')
    }

    // Get Local record
    const dsKey = new Key(key)
    let currentRecord

    try {
      currentRecord = await this._getLocal(dsKey.toBuffer())
    } catch (err) {
      // if the old one is invalid, the new one is *always* better
      return true
    }

    // if the same record, do not need to store
    if (currentRecord.equals(val)) {
      return false
    }

    // verify if the received record should replace the current one
    return this._selectRecord(val, currentRecord)
  }

  // add record to datastore
  async _storeRecord (key, data) {
    // encode key - base32(/ipns/{cid})
    const routingKey = new Key('/' + encodeBase32(key), false)

    await this._datastore.put(routingKey, data)
    log(`record for ${keyToTopic(key)} was stored in the datastore`)
  }

  open () {
    const errMsg = 'open function was not implemented yet'

    log.error(errMsg)
    throw errcode(new Error(errMsg), 'ERR_NOT_IMPLEMENTED_YET')
  }

  has (key) {
    const errMsg = 'has function was not implemented yet'

    log.error(errMsg)
    throw errcode(new Error(errMsg), 'ERR_NOT_IMPLEMENTED_YET')
  }

  delete (key) {
    const errMsg = 'delete function was not implemented yet'

    log.error(errMsg)
    throw errcode(new Error(errMsg), 'ERR_NOT_IMPLEMENTED_YET')
  }

  close () {
    const errMsg = 'close function was not implemented yet'

    log.error(errMsg)
    throw errcode(new Error(errMsg), 'ERR_NOT_IMPLEMENTED_YET')
  }

  batch () {
    const errMsg = 'batch function was not implemented yet'

    log.error(errMsg)
    throw errcode(new Error(errMsg), 'ERR_NOT_IMPLEMENTED_YET')
  }

  query () {
    const errMsg = 'query function was not implemented yet'

    log.error(errMsg)
    throw errcode(new Error(errMsg), 'ERR_NOT_IMPLEMENTED_YET')
  }
}

exports = module.exports = DatastorePubsub
