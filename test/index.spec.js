/* eslint-env mocha */
'use strict'

const chai = require('chai')
const dirtyChai = require('dirty-chai')
const expect = chai.expect
chai.use(dirtyChai)
const sinon = require('sinon')

const isNode = require('detect-node')
const parallel = require('async/parallel')
const series = require('async/series')

const { Key } = require('interface-datastore')
const { Record } = require('libp2p-record')

const DatastorePubsub = require('../src')
const { keyToTopic } = require('../src/utils')
const { connect, waitFor, waitForPeerToSubscribe, spawnDaemon, stopDaemon } = require('./utils')

// Always returning the expected values
// Valid record and select the new one
const smoothValidator = {
  validate: (data, peerId, callback) => {
    callback(null, true)
  },
  select: (receivedRecod, currentRecord, callback) => {
    callback(null, 0)
  }
}

describe('datastore-pubsub', function () {
  this.timeout(60 * 1000)

  if (!isNode) return

  let ipfsdA = null
  let ipfsdB = null
  let ipfsdAId = null
  let ipfsdBId = null

  // spawn daemon
  before(function (done) {
    parallel([
      (cb) => spawnDaemon(cb),
      (cb) => spawnDaemon(cb)
    ], (err, daemons) => {
      expect(err).to.not.exist()

      ipfsdA = daemons[0]
      ipfsdB = daemons[1]

      parallel([
        (cb) => ipfsdA.api.id(cb),
        (cb) => ipfsdB.api.id(cb)
      ], (err, ids) => {
        expect(err).to.not.exist()

        ipfsdAId = ids[0]
        ipfsdBId = ids[1]

        connect(ipfsdA, ipfsdAId, ipfsdB, ipfsdBId, done)
      })
    })
  })

  let pubsubA = null
  let datastoreA = null
  let peerIdA = null

  let datastoreB = null
  let peerIdB = null
  let pubsubB = null

  // create DatastorePubsub instances
  before(function (done) {
    pubsubA = ipfsdA.api._libp2pNode.pubsub
    datastoreA = ipfsdA.api._repo.datastore
    peerIdA = ipfsdA.api._peerInfo.id

    pubsubB = ipfsdB.api._libp2pNode.pubsub
    datastoreB = ipfsdB.api._repo.datastore
    peerIdB = ipfsdB.api._peerInfo.id

    done()
  })

  const value = 'value'
  let testCounter = 0
  let keyRef = null
  let key = null
  let record = null
  let serializedRecord = null

  // prepare Record
  beforeEach(function (done) {
    keyRef = `key${testCounter}`
    key = (new Key(keyRef)).toBuffer()
    record = new Record(key, Buffer.from(value))

    serializedRecord = record.serialize()
    done()
  })

  afterEach(function (done) {
    ++testCounter
    done()
  })

  after(function (done) {
    parallel([
      (cb) => stopDaemon(ipfsdA, cb),
      (cb) => stopDaemon(ipfsdB, cb)
    ], done)
  })

  it('should subscribe the topic, but receive error as no entry is stored locally', function (done) {
    const dsPubsubA = new DatastorePubsub(pubsubA, datastoreA, peerIdA, smoothValidator)
    const subsTopic = keyToTopic(`/${keyRef}`)

    pubsubA.ls((err, res) => {
      expect(err).to.not.exist()
      expect(res).to.exist()
      expect(res).to.not.include(subsTopic) // not subscribed key reference yet

      dsPubsubA.get(key, (err) => {
        expect(err).to.exist() // not locally stored record
        expect(err.code).to.equal('ERR_NOT_FOUND')

        pubsubA.ls((err, res) => {
          expect(err).to.not.exist()
          expect(res).to.exist()
          expect(res).to.include(subsTopic) // subscribed key reference
          done()
        })
      })
    })
  })

  it('should put correctly to daemon A and daemon B should not receive it without subscribing', function (done) {
    const dsPubsubA = new DatastorePubsub(pubsubA, datastoreA, peerIdA, smoothValidator)
    const dsPubsubB = new DatastorePubsub(pubsubB, datastoreB, peerIdB, smoothValidator)
    const subsTopic = keyToTopic(`/${keyRef}`)

    pubsubB.ls((err, res) => {
      expect(err).to.not.exist()
      expect(res).to.exist()
      expect(res).to.not.include(subsTopic) // not subscribed

      dsPubsubA.put(key, serializedRecord, (err) => {
        expect(err).to.not.exist()
        dsPubsubB.get(key, (err, res) => {
          expect(err).to.exist() // did not receive record
          expect(res).to.not.exist()
          done()
        })
      })
    })
  })

  it('should validate if record content is the same', function (done) {
    const customValidator = {
      validate: (data, peerId, callback) => {
        const receivedRecord = Record.deserialize(data)

        expect(receivedRecord.value.toString()).to.equal(value) // validator should deserialize correctly
        callback(null, receivedRecord.value.toString() === value)
      },
      select: (receivedRecod, currentRecord, callback) => {
        callback(null, 0)
      }
    }
    const dsPubsubA = new DatastorePubsub(pubsubA, datastoreA, peerIdA, smoothValidator)
    const dsPubsubB = new DatastorePubsub(pubsubB, datastoreB, peerIdB, customValidator)
    const subsTopic = keyToTopic(`/${keyRef}`)
    let receivedMessage = false

    function messageHandler () {
      receivedMessage = true
    }

    dsPubsubB.get(key, (err, res) => {
      expect(err).to.exist()
      expect(res).to.not.exist() // no value available, but subscribed now

      series([
        (cb) => waitForPeerToSubscribe(subsTopic, ipfsdBId, ipfsdA, cb),
        // subscribe in order to understand when the message arrive to the node
        (cb) => pubsubB.subscribe(subsTopic, messageHandler, cb),
        (cb) => dsPubsubA.put(key, serializedRecord, cb),
        // wait until message arrives
        (cb) => waitFor(() => receivedMessage === true, cb),
        // get from datastore
        (cb) => dsPubsubB.get(key, cb)
      ], (err, res) => {
        expect(err).to.not.exist()
        expect(res[4]).to.exist()
        done()
      })
    })
  })

  it('should put correctly to daemon A and daemon B should receive it as it tried to get it first and subscribed it', function (done) {
    const dsPubsubA = new DatastorePubsub(pubsubA, datastoreA, peerIdA, smoothValidator)
    const dsPubsubB = new DatastorePubsub(pubsubB, datastoreB, peerIdB, smoothValidator)
    const subsTopic = keyToTopic(`/${keyRef}`)
    let receivedMessage = false

    function messageHandler () {
      receivedMessage = true
    }

    pubsubB.ls((err, res) => {
      expect(err).to.not.exist()
      expect(res).to.exist()
      expect(res).to.not.include(subsTopic) // not subscribed

      dsPubsubB.get(key, (err, res) => {
        expect(err).to.exist()
        expect(res).to.not.exist() // not value available, but subscribed now

        series([
          (cb) => waitForPeerToSubscribe(subsTopic, ipfsdBId, ipfsdA, cb),
          // subscribe in order to understand when the message arrive to the node
          (cb) => pubsubB.subscribe(subsTopic, messageHandler, cb),
          (cb) => dsPubsubA.put(key, serializedRecord, cb),
          // wait until message arrives
          (cb) => waitFor(() => receivedMessage === true, cb),
          // get from datastore
          (cb) => dsPubsubB.get(key, cb)
        ], (err, res) => {
          expect(err).to.not.exist()
          expect(res).to.exist()
          expect(res[4]).to.exist()

          const receivedRecord = Record.deserialize(res[4])

          expect(receivedRecord.value.toString()).to.equal(value)
          done()
        })
      })
    })
  })

  it('should fail to create the DatastorePubsub if no validator is provided', function (done) {
    let dsPubsubB
    try {
      dsPubsubB = new DatastorePubsub(pubsubB, datastoreB, peerIdB) // no validator
    } catch (err) {
      expect(err).to.exist()
    }

    expect(dsPubsubB).to.equal(undefined)
    done()
  })

  it('should fail to create the DatastorePubsub if no validate function is provided', function (done) {
    const customValidator = {
      validate: undefined,
      select: (receivedRecod, currentRecord, callback) => {
        callback(null, 0)
      }
    }

    let dsPubsubB
    try {
      dsPubsubB = new DatastorePubsub(pubsubB, datastoreB, peerIdB, customValidator)
    } catch (err) {
      expect(err).to.exist()
    }

    expect(dsPubsubB).to.equal(undefined)
    done()
  })

  it('should fail to create the DatastorePubsub if no select function is provided', function (done) {
    const customValidator = {
      validate: (data, peerId, callback) => {
        callback(null, true)
      },
      select: undefined
    }

    let dsPubsubB
    try {
      dsPubsubB = new DatastorePubsub(pubsubB, datastoreB, peerIdB, customValidator)
    } catch (err) {
      expect(err).to.exist()
    }

    expect(dsPubsubB).to.equal(undefined)
    done()
  })

  it('should fail if it fails to validate the record', function (done) {
    const customValidator = {
      validate: (data, peerId, callback) => {
        callback(null, false) // return false validation
      },
      select: (receivedRecod, currentRecord, callback) => {
        callback(null, 0)
      }
    }
    const dsPubsubA = new DatastorePubsub(pubsubA, datastoreA, peerIdA, smoothValidator)
    const dsPubsubB = new DatastorePubsub(pubsubB, datastoreB, peerIdB, customValidator)
    const subsTopic = keyToTopic(`/${keyRef}`)
    let receivedMessage = false

    function messageHandler () {
      receivedMessage = true
    }

    dsPubsubB.get(key, (err, res) => {
      expect(err).to.exist()
      expect(res).to.not.exist() // not value available, but subscribed now

      series([
        (cb) => waitForPeerToSubscribe(subsTopic, ipfsdBId, ipfsdA, cb),
        // subscribe in order to understand when the message arrive to the node
        (cb) => pubsubB.subscribe(subsTopic, messageHandler, cb),
        (cb) => dsPubsubA.put(key, serializedRecord, cb),
        // wait until message arrives
        (cb) => waitFor(() => receivedMessage === true, cb),
        // get from datastore
        (cb) => dsPubsubB.get(key, cb)
      ], (err, res) => {
        // No record received, in spite of message received
        expect(err).to.exist() // message was discarded as a result of failing the validation
        expect(res[4]).to.not.exist()
        done()
      })
    })
  })

  it('should get the second record if the selector selects it as the newest one', function (done) {
    const customValidator = {
      validate: (data, peerId, callback) => {
        callback(null, true)
      },
      select: (receivedRecod, currentRecord, callback) => {
        callback(null, 1) // current record is the newer
      }
    }

    const newValue = 'new value'
    const record = new Record(key, Buffer.from(newValue))
    const newSerializedRecord = record.serialize()

    const dsPubsubA = new DatastorePubsub(pubsubA, datastoreA, peerIdA, smoothValidator)
    const dsPubsubB = new DatastorePubsub(pubsubB, datastoreB, peerIdB, customValidator)
    const subsTopic = keyToTopic(`/${keyRef}`)
    let receivedMessage = false

    function messageHandler () {
      receivedMessage = true
    }

    dsPubsubB.get(key, (err, res) => {
      expect(err).to.exist()
      expect(res).to.not.exist() // not value available, but subscribed now

      series([
        (cb) => waitForPeerToSubscribe(subsTopic, ipfsdBId, ipfsdA, cb),
        // subscribe in order to understand when the message arrive to the node
        (cb) => pubsubB.subscribe(subsTopic, messageHandler, cb),
        (cb) => dsPubsubA.put(key, serializedRecord, cb),
        // wait until message arrives
        (cb) => waitFor(() => receivedMessage === true, cb),
        (cb) => dsPubsubA.put(key, newSerializedRecord, cb), // put new serializedRecord
        // wait until message arrives
        (cb) => waitFor(() => receivedMessage === true, cb),
        // get from datastore
        (cb) => dsPubsubB.get(key, cb)
      ], (err, res) => {
        expect(err).to.not.exist() // message was discarded as a result of no validator available
        expect(res[6]).to.exist()

        const receivedRecord = Record.deserialize(res[6])

        expect(receivedRecord.value.toString()).to.not.equal(newValue) // not equal to the last value
        done()
      })
    })
  })

  it('should get the new record if the selector selects it as the newest one', function (done) {
    const customValidator = {
      validate: (data, peerId, callback) => {
        callback(null, true)
      },
      select: (receivedRecod, currentRecord, callback) => {
        callback(null, 0) // received record is the newer
      }
    }

    const newValue = 'new value'
    const record = new Record(key, Buffer.from(newValue))
    const newSerializedRecord = record.serialize()

    const dsPubsubA = new DatastorePubsub(pubsubA, datastoreA, peerIdA, smoothValidator)
    const dsPubsubB = new DatastorePubsub(pubsubB, datastoreB, peerIdB, customValidator)
    const subsTopic = keyToTopic(`/${keyRef}`)
    let receivedMessage = false

    function messageHandler () {
      receivedMessage = true
    }

    dsPubsubB.get(key, (err, res) => {
      expect(err).to.exist()
      expect(res).to.not.exist() // not value available, but it is subscribed now

      series([
        (cb) => waitForPeerToSubscribe(subsTopic, ipfsdBId, ipfsdA, cb),
        // subscribe in order to understand when the message arrive to the node
        (cb) => pubsubB.subscribe(subsTopic, messageHandler, cb),
        (cb) => dsPubsubA.put(key, serializedRecord, cb),
        // wait until message arrives
        (cb) => waitFor(() => receivedMessage === true, cb),
        (cb) => dsPubsubA.put(key, newSerializedRecord, cb), // put new serializedRecord
        // wait until message arrives
        (cb) => waitFor(() => receivedMessage === true, cb),
        // get from datastore
        (cb) => dsPubsubB.get(key, cb)
      ], (err, res) => {
        expect(err).to.not.exist() // message was discarded as a result of no validator available
        expect(res[6]).to.exist()

        const receivedRecord = Record.deserialize(res[6])

        expect(receivedRecord.value.toString()).to.equal(newValue) // equal to the last value
        done()
      })
    })
  })

  it('should subscribe the topic and after a message being received, discard it using the subscriptionKeyFn', function (done) {
    const subscriptionKeyFn = (topic, callback) => {
      expect(topic).to.equal(`/${keyRef}`)
      callback(new Error('DISCARD MESSAGE'))
    }
    const dsPubsubA = new DatastorePubsub(pubsubA, datastoreA, peerIdA, smoothValidator)
    const dsPubsubB = new DatastorePubsub(pubsubB, datastoreB, peerIdB, smoothValidator, subscriptionKeyFn)
    const subsTopic = keyToTopic(`/${keyRef}`)
    let receivedMessage = false

    function messageHandler () {
      receivedMessage = true
    }

    pubsubB.ls((err, res) => {
      expect(err).to.not.exist()
      expect(res).to.exist()
      expect(res).to.not.include(subsTopic) // not subscribed

      dsPubsubB.get(key, (err, res) => {
        expect(err).to.exist()
        expect(res).to.not.exist() // not value available, but subscribed now

        series([
          (cb) => waitForPeerToSubscribe(subsTopic, ipfsdBId, ipfsdA, cb),
          // subscribe in order to understand when the message arrive to the node
          (cb) => pubsubB.subscribe(subsTopic, messageHandler, cb),
          (cb) => dsPubsubA.put(key, serializedRecord, cb),
          // wait until message arrives
          (cb) => waitFor(() => receivedMessage === true, cb),
          // get from datastore
          (cb) => dsPubsubB.get(key, cb)
        ], (err) => {
          expect(err).to.exist() // As message was discarded, it was not stored in the datastore
          done()
        })
      })
    })
  })

  it('should subscribe the topic and after a message being received, change its key using subscriptionKeyFn', function (done) {
    const subscriptionKeyFn = (topic, callback) => {
      expect(topic).to.equal(key.toString())
      callback(null, `${topic}new`)
    }
    const dsPubsubA = new DatastorePubsub(pubsubA, datastoreA, peerIdA, smoothValidator)
    const dsPubsubB = new DatastorePubsub(pubsubB, datastoreB, peerIdB, smoothValidator, subscriptionKeyFn)
    const subsTopic = keyToTopic(`/${keyRef}`)
    const keyNew = Buffer.from(`${key.toString()}new`)
    let receivedMessage = false

    function messageHandler () {
      receivedMessage = true
    }

    pubsubB.ls((err, res) => {
      expect(err).to.not.exist()
      expect(res).to.exist()
      expect(res).to.not.include(subsTopic) // not subscribed

      dsPubsubB.get(key, (err, res) => {
        expect(err).to.exist()
        expect(res).to.not.exist() // not value available, but subscribed now

        series([
          (cb) => waitForPeerToSubscribe(subsTopic, ipfsdBId, ipfsdA, cb),
          // subscribe in order to understand when the message arrive to the node
          (cb) => pubsubB.subscribe(subsTopic, messageHandler, cb),
          (cb) => dsPubsubA.put(key, serializedRecord, cb),
          // wait until message arrives
          (cb) => waitFor(() => receivedMessage === true, cb),
          // get from datastore
          (cb) => dsPubsubB.get(keyNew, cb)
        ], (err, res) => {
          expect(err).to.not.exist()
          expect(res).to.exist()
          expect(res[4]).to.exist()

          const receivedRecord = Record.deserialize(res[4])

          expect(receivedRecord.value.toString()).to.equal(value)
          done()
        })
      })
    })
  })

  it('should subscribe a topic only once', function (done) {
    const dsPubsubA = new DatastorePubsub(pubsubA, datastoreA, peerIdA, smoothValidator)

    sinon.spy(pubsubA, 'subscribe')

    dsPubsubA.get(key, (err) => {
      expect(err).to.exist() // not locally stored record
      dsPubsubA.get(key, (err) => {
        expect(err).to.exist() // not locally stored record
        expect(pubsubA.subscribe.calledOnce).to.equal(true)

        done()
      })
    })
  })

  it('should handle a unexpected error properly when getting from the datastore', function (done) {
    const dsPubsubA = new DatastorePubsub(pubsubA, datastoreA, peerIdA, smoothValidator)
    const stub = sinon.stub(dsPubsubA._datastore, 'get').callsArgWith(1, { code: 'RANDOM_ERR' })

    dsPubsubA.get(key, (err) => {
      expect(err).to.exist() // not locally stored record
      expect(err.code).to.equal('ERR_UNEXPECTED_ERROR_GETTING_RECORD')

      stub.restore()
      done()
    })
  })
})
