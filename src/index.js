'use strict'

const { Key } = require('interface-datastore')
const { encodeBase32, keyToTopic, topicToKey } = require('./utils')

const errcode = require('err-code')
const assert = require('assert')
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
    assert.strictEqual(typeof validator, 'object', 'missing validator')
    assert.strictEqual(typeof validator.validate, 'function', 'missing validate function')
    assert.strictEqual(typeof validator.select, 'function', 'missing select function')
    subscriptionKeyFn && assert.strictEqual(typeof subscriptionKeyFn, 'function', 'invalid subscriptionKeyFn received')

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
   * @param {function(Error)} callback
   * @returns {void}
   */
  put (key, val, callback) {
    if (!Buffer.isBuffer(key)) {
      const errMsg = `datastore key does not have a valid format`

      log.error(errMsg)
      return callback(errcode(new Error(errMsg), 'ERR_INVALID_DATASTORE_KEY'))
    }

    if (!Buffer.isBuffer(val)) {
      const errMsg = `received value is not a buffer`

      log.error(errMsg)
      return callback(errcode(new Error(errMsg), 'ERR_INVALID_VALUE_RECEIVED'))
    }

    const stringifiedTopic = keyToTopic(key)

    log(`publish value for topic ${stringifiedTopic}`)

    // Publish record to pubsub
    this._pubsub.publish(stringifiedTopic, val, callback)
  }

  /**
   * Try to subscribe a topic with Pubsub and returns the local value if available.
   * @param {Buffer} key identifier of the value to be subscribed.
   * @param {function(Error, Buffer)} callback
   * @returns {void}
   */
  get (key, callback) {
    if (!Buffer.isBuffer(key)) {
      const errMsg = `datastore key does not have a valid format`

      log.error(errMsg)
      return callback(errcode(new Error(errMsg), 'ERR_INVALID_DATASTORE_KEY'))
    }

    const stringifiedTopic = keyToTopic(key)

    this._pubsub.ls((err, res) => {
      if (err) {
        return callback(err)
      }

      // If already subscribed, just try to get it
      if (res && Array.isArray(res) && res.indexOf(stringifiedTopic) > -1) {
        return this._getLocal(key, callback)
      }

      // Subscribe
      this._pubsub.subscribe(stringifiedTopic, this._onMessage, (err) => {
        if (err) {
          const errMsg = `cannot subscribe topic ${stringifiedTopic}`

          log.error(errMsg)
          return callback(errcode(new Error(errMsg), 'ERR_SUBSCRIBING_TOPIC'))
        }
        log(`subscribed values for key ${stringifiedTopic}`)

        this._getLocal(key, callback)
      })
    })
  }

  /**
   * Unsubscribe topic.
   * @param {Buffer} key identifier of the value to unsubscribe.
   * @returns {void}
   */
  unsubscribe (key) {
    const stringifiedTopic = keyToTopic(key)

    this._pubsub.unsubscribe(stringifiedTopic, this._onMessage)
  }

  // Get record from local datastore
  _getLocal (key, callback) {
    // encode key - base32(/ipns/{cid})
    const routingKey = new Key('/' + encodeBase32(key), false)

    this._datastore.get(routingKey, (err, dsVal) => {
      if (err) {
        if (err.code !== 'ERR_NOT_FOUND') {
          const errMsg = `unexpected error getting the ipns record for ${routingKey.toString()}`

          log.error(errMsg)
          return callback(errcode(new Error(errMsg), 'ERR_UNEXPECTED_ERROR_GETTING_RECORD'))
        }
        const errMsg = `local record requested was not found for ${routingKey.toString()}`

        log.error(errMsg)
        return callback(errcode(new Error(errMsg), 'ERR_NOT_FOUND'))
      }

      if (!Buffer.isBuffer(dsVal)) {
        const errMsg = `found record that we couldn't convert to a value`

        log.error(errMsg)
        return callback(errcode(new Error(errMsg), 'ERR_INVALID_RECORD_RECEIVED'))
      }

      callback(null, dsVal)
    })
  }

  // handles pubsub subscription messages
  _onMessage (msg) {
    const { data, from, topicIDs } = msg
    let key
    try {
      key = topicToKey(topicIDs[0])
    } catch (err) {
      log.error(err)
      return
    }

    log(`message received for ${key} topic`)

    // Stop if the message is from the peer (it already stored it while publishing to pubsub)
    if (from === this._peerId.toB58String()) {
      log(`message discarded as it is from the same peer`)
      return
    }

    if (this._handleSubscriptionKeyFn) {
      this._handleSubscriptionKeyFn(key, (err, res) => {
        if (err) {
          log.error('message discarded by the subscriptionKeyFn')
          return
        }

        this._storeIfSubscriptionIsBetter(res, data)
      })
    } else {
      this._storeIfSubscriptionIsBetter(key, data)
    }
  }

  // Store the received record if it is better than the current stored
  _storeIfSubscriptionIsBetter (key, data) {
    this._isBetter(key, data, (err, res) => {
      if (!err && res) {
        this._storeRecord(Buffer.from(key), data)
      }
    })
  }

  // Validate record according to the received validation function
  _validateRecord (value, peerId, callback) {
    this._validator.validate(value, peerId, callback)
  }

  // Select the best record according to the received select function.
  _selectRecord (receivedRecord, currentRecord, callback) {
    this._validator.select(receivedRecord, currentRecord, (err, res) => {
      if (err) {
        log.error(err)
        return callback(err)
      }

      // If the selected was the first (0), it should be stored (true)
      callback(null, res === 0)
    })
  }

  // Verify if the record received through pubsub is valid and better than the one currently stored
  _isBetter (key, val, callback) {
    // validate received record
    this._validateRecord(val, key, (err, valid) => {
      // If not valid, it is not better than the one currently available
      if (err || !valid) {
        const errMsg = 'record received through pubsub is not valid'

        log.error(errMsg)
        return callback(errcode(new Error(errMsg), 'ERR_NOT_VALID_RECORD'))
      }

      // Get Local record
      const dsKey = new Key(key)

      this._getLocal(dsKey.toBuffer(), (err, currentRecord) => {
        // if the old one is invalid, the new one is *always* better
        if (err) {
          return callback(null, true)
        }

        // if the same record, do not need to store
        if (currentRecord.equals(val)) {
          return callback(null, false)
        }

        // verify if the received record should replace the current one
        this._selectRecord(val, currentRecord, callback)
      })
    })
  }

  // add record to datastore
  _storeRecord (key, data) {
    // encode key - base32(/ipns/{cid})
    const routingKey = new Key('/' + encodeBase32(key), false)

    this._datastore.put(routingKey, data, (err) => {
      if (err) {
        log.error(`record for ${key.toString()} could not be stored in the routing`)
        return
      }

      log(`record for ${key.toString()} was stored in the datastore`)
    })
  }

  open (callback) {
    const errMsg = `open function was not implemented yet`

    log.error(errMsg)
    return callback(errcode(new Error(errMsg), 'ERR_NOT_IMPLEMENTED_YET'))
  }

  has (key, callback) {
    const errMsg = `has function was not implemented yet`

    log.error(errMsg)
    return callback(errcode(new Error(errMsg), 'ERR_NOT_IMPLEMENTED_YET'))
  }

  delete (key, callback) {
    const errMsg = `delete function was not implemented yet`

    log.error(errMsg)
    return callback(errcode(new Error(errMsg), 'ERR_NOT_IMPLEMENTED_YET'))
  }

  close (callback) {
    const errMsg = `close function was not implemented yet`

    log.error(errMsg)
    return callback(errcode(new Error(errMsg), 'ERR_NOT_IMPLEMENTED_YET'))
  }

  batch () {
    const errMsg = `batch function was not implemented yet`

    log.error(errMsg)
    throw errcode(new Error(errMsg), 'ERR_NOT_IMPLEMENTED_YET')
  }

  query () {
    const errMsg = `query function was not implemented yet`

    log.error(errMsg)
    throw errcode(new Error(errMsg), 'ERR_NOT_IMPLEMENTED_YET')
  }
}

exports = module.exports = DatastorePubsub
