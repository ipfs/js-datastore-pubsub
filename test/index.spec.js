/* eslint-env mocha */
'use strict'

const chai = require('chai')
const dirtyChai = require('dirty-chai')
const expect = chai.expect
chai.use(dirtyChai)
const sinon = require('sinon')
const errcode = require('err-code')
const isNode = require('detect-node')

const { Key } = require('interface-datastore')
const { Record } = require('libp2p-record')

const DatastorePubsub = require('../src')
const { keyToTopic, topicToKey } = require('../src/utils')
const { connect, waitFor, waitForPeerToSubscribe, spawnDaemon, stopDaemon } = require('./utils')
const promisify = require('promisify-es6')

// Always returning the expected values
// Valid record and select the new one
const smoothValidator = {
  validate: () => {
    return true
  },
  select: () => {
    return 0
  }
}

describe('datastore-pubsub', function () {
  this.timeout(60 * 1000)

  if (!isNode) return

  let ipfsdA = null
  let ipfsdB = null
  let ipfsdAId = null
  let ipfsdBId = null
  let pubsubA = null
  let datastoreA = null
  let peerIdA = null

  let datastoreB = null
  let peerIdB = null
  let pubsubB = null

  // spawn daemon and create DatastorePubsub instances
  before(async function () {
    [ipfsdA, ipfsdB] = await Promise.all([spawnDaemon(), spawnDaemon()]);
    [ipfsdAId, ipfsdBId] = await Promise.all([ipfsdA.api.id(), ipfsdB.api.id()])

    await connect(ipfsdA, ipfsdAId, ipfsdB, ipfsdBId)

    pubsubA = ipfsdA.api.pubsub
    datastoreA = {
      get: promisify(ipfsdA.api._repo.datastore.get, {
        context: ipfsdA.api._repo.datastore
      }),
      put: promisify(ipfsdA.api._repo.datastore.put, {
        context: ipfsdA.api._repo.datastore
      })
    }
    peerIdA = ipfsdA.api._peerInfo.id

    pubsubB = ipfsdB.api.pubsub
    datastoreB = {
      get: promisify(ipfsdB.api._repo.datastore.get, {
        context: ipfsdB.api._repo.datastore
      }),
      put: promisify(ipfsdB.api._repo.datastore.put, {
        context: ipfsdB.api._repo.datastore
      })
    }
    peerIdB = ipfsdB.api._peerInfo.id
  })

  const value = 'value'
  let testCounter = 0
  let keyRef = null
  let key = null
  let record = null
  let serializedRecord = null

  // prepare Record
  beforeEach(() => {
    keyRef = `key${testCounter}`
    key = (new Key(keyRef)).toBuffer()
    record = new Record(key, Buffer.from(value))

    serializedRecord = record.serialize()
  })

  afterEach(() => {
    ++testCounter
  })

  after(() => {
    return Promise.all([
      stopDaemon(ipfsdA),
      stopDaemon(ipfsdB)
    ])
  })

  it('should subscribe the topic, but receive error as no entry is stored locally', async () => {
    const dsPubsubA = new DatastorePubsub(pubsubA, datastoreA, peerIdA, smoothValidator)
    const subsTopic = keyToTopic(`/${keyRef}`)

    let subscribers = await pubsubA.ls()

    expect(subscribers).to.exist()
    expect(subscribers).to.not.include(subsTopic) // not subscribed key reference yet

    const res = await dsPubsubA.get(key)
      .then(() => expect.fail('Should have failed to fetch key'), (err) => {
        // not locally stored record
        expect(err.code).to.equal('ERR_NOT_FOUND')
      })

    expect(res).to.not.exist()

    subscribers = await pubsubA.ls()

    expect(subscribers).to.exist()
    expect(subscribers).to.include(subsTopic) // subscribed key reference
  })

  it('should put correctly to daemon A and daemon B should not receive it without subscribing', async () => {
    const dsPubsubA = new DatastorePubsub(pubsubA, datastoreA, peerIdA, smoothValidator)
    const dsPubsubB = new DatastorePubsub(pubsubB, datastoreB, peerIdB, smoothValidator)
    const subsTopic = keyToTopic(`/${keyRef}`)

    const res = await pubsubB.ls()
    expect(res).to.exist()
    expect(res).to.not.include(subsTopic) // not subscribed

    await dsPubsubA.put(key, serializedRecord)

    await dsPubsubB.get(key)
      .then(() => expect.fail('Should have failed to fetch key'), (err) => {
        // not locally stored record
        expect(err.code).to.equal('ERR_NOT_FOUND')
      })
  })

  it('should validate if record content is the same', async () => {
    const customValidator = {
      validate: (data) => {
        const receivedRecord = Record.deserialize(data)

        expect(receivedRecord.value.toString()).to.equal(value) // validator should deserialize correctly

        return receivedRecord.value.toString() === value
      },
      select: () => {
        return 0
      }
    }
    const dsPubsubA = new DatastorePubsub(pubsubA, datastoreA, peerIdA, smoothValidator)
    const dsPubsubB = new DatastorePubsub(pubsubB, datastoreB, peerIdB, customValidator)
    const subsTopic = keyToTopic(`/${keyRef}`)
    let receivedMessage = false

    function messageHandler () {
      receivedMessage = true
    }

    // causes pubsub b to become subscribed to the topic
    await dsPubsubB.get(key)
      .then(() => expect.fail('Should have failed to fetch key'), (err) => {
        // not locally stored record
        expect(err.code).to.equal('ERR_NOT_FOUND')
      })

    await waitForPeerToSubscribe(subsTopic, ipfsdBId, ipfsdA)

    // subscribe in order to understand when the message arrive to the node
    await pubsubB.subscribe(subsTopic, messageHandler)

    await dsPubsubA.put(key, serializedRecord)

    // wait until message arrives
    await waitFor(() => receivedMessage === true)

    // get from datastore
    const record = await dsPubsubB.get(key)

    expect(record).to.be.ok()
  })

  it('should put correctly to daemon A and daemon B should receive it as it tried to get it first and subscribed it', async () => {
    const dsPubsubA = new DatastorePubsub(pubsubA, datastoreA, peerIdA, smoothValidator)
    const dsPubsubB = new DatastorePubsub(pubsubB, datastoreB, peerIdB, smoothValidator)
    const subsTopic = keyToTopic(`/${keyRef}`)
    let receivedMessage = false

    function messageHandler () {
      receivedMessage = true
    }

    const res = await pubsubB.ls()
    expect(res).to.exist()
    expect(res).to.not.include(subsTopic) // not subscribed

    // causes pubsub b to become subscribed to the topic
    await dsPubsubB.get(key)
      .then(() => expect.fail('Should have failed to fetch key'), (err) => {
        // not locally stored record
        expect(err.code).to.equal('ERR_NOT_FOUND')
      })

    await waitForPeerToSubscribe(subsTopic, ipfsdBId, ipfsdA)

    // subscribe in order to understand when the message arrive to the node
    await pubsubB.subscribe(subsTopic, messageHandler)
    await dsPubsubA.put(key, serializedRecord)

    // wait until message arrives
    await waitFor(() => receivedMessage === true)

    // get from datastore
    const result = await dsPubsubB.get(key)
    expect(result).to.exist()

    const receivedRecord = Record.deserialize(result)
    expect(receivedRecord.value.toString()).to.equal(value)
  })

  it('should fail to create the DatastorePubsub if no validator is provided', () => {
    let dsPubsubB
    try {
      dsPubsubB = new DatastorePubsub(pubsubB, datastoreB, peerIdB) // no validator
    } catch (err) {
      expect(err.code).to.equal('ERR_INVALID_PARAMETERS')
    }

    expect(dsPubsubB).to.equal(undefined)
  })

  it('should fail to create the DatastorePubsub if no validate function is provided', () => {
    const customValidator = {
      validate: undefined,
      select: () => {
        return 0
      }
    }

    let dsPubsubB
    try {
      dsPubsubB = new DatastorePubsub(pubsubB, datastoreB, peerIdB, customValidator)
    } catch (err) {
      expect(err.code).to.equal('ERR_INVALID_PARAMETERS')
    }

    expect(dsPubsubB).to.equal(undefined)
  })

  it('should fail to create the DatastorePubsub if no select function is provided', () => {
    const customValidator = {
      validate: () => {
        return true
      },
      select: undefined
    }

    let dsPubsubB
    try {
      dsPubsubB = new DatastorePubsub(pubsubB, datastoreB, peerIdB, customValidator)
    } catch (err) {
      expect(err.code).to.equal('ERR_INVALID_PARAMETERS')
    }

    expect(dsPubsubB).to.equal(undefined)
  })

  it('should fail if it fails to validate the record', async () => {
    const customValidator = {
      validate: () => {
        return false // return false validation
      },
      select: () => {
        return 0
      }
    }
    const dsPubsubA = new DatastorePubsub(pubsubA, datastoreA, peerIdA, smoothValidator)
    const dsPubsubB = new DatastorePubsub(pubsubB, datastoreB, peerIdB, customValidator)
    const subsTopic = keyToTopic(`/${keyRef}`)
    let receivedMessage = false

    function messageHandler () {
      receivedMessage = true
    }

    // causes pubsub b to become subscribed to the topic
    await dsPubsubB.get(key)
      .then(() => expect.fail('Should have failed to fetch key'), (err) => {
        // not locally stored record
        expect(err.code).to.equal('ERR_NOT_FOUND')
      })

    await waitForPeerToSubscribe(subsTopic, ipfsdBId, ipfsdA)

    // subscribe in order to understand when the message arrive to the node
    await pubsubB.subscribe(subsTopic, messageHandler)
    await dsPubsubA.put(key, serializedRecord)

    // wait until message arrives
    await waitFor(() => receivedMessage === true)

    try {
      // get from datastore
      await dsPubsubB.get(key)
      expect.fail('Should have disguarded invalid message')
    } catch (err) {
      // No record received, in spite of message received
      expect(err.code).to.equal('ERR_NOT_FOUND')
    }
  })

  it('should get the second record if the selector selects it as the newest one', async () => {
    const customValidator = {
      validate: () => {
        return true
      },
      select: () => {
        return 1 // current record is the newer
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

    // causes pubsub b to become subscribed to the topic
    await dsPubsubB.get(key)
      .then(() => expect.fail('Should have failed to fetch key'), (err) => {
        // not locally stored record
        expect(err.code).to.equal('ERR_NOT_FOUND')
      })

    await waitForPeerToSubscribe(subsTopic, ipfsdBId, ipfsdA)

    // subscribe in order to understand when the message arrive to the node
    await pubsubB.subscribe(subsTopic, messageHandler)
    await dsPubsubA.put(key, serializedRecord)

    // wait until message arrives
    await waitFor(() => receivedMessage === true)
    await dsPubsubA.put(key, newSerializedRecord) // put new serializedRecord

    // wait until message arrives
    await waitFor(() => receivedMessage === true)

    // get from datastore
    // message was discarded as a result of no validator available
    const result = await dsPubsubB.get(key)
    const receivedRecord = Record.deserialize(result)
    expect(receivedRecord.value.toString()).to.not.equal(newValue) // not equal to the last value
  })

  it('should get the new record if the selector selects it as the newest one', async () => {
    const customValidator = {
      validate: () => {
        return true
      },
      select: () => {
        return 0 // received record is the newer
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

    // causes pubsub b to become subscribed to the topic
    await dsPubsubB.get(key)
      .then(() => expect.fail('Should have failed to fetch key'), (err) => {
        // not locally stored record
        expect(err.code).to.equal('ERR_NOT_FOUND')
      })

    await waitForPeerToSubscribe(subsTopic, ipfsdBId, ipfsdA)

    // subscribe in order to understand when the message arrive to the node
    await pubsubB.subscribe(subsTopic, messageHandler)
    await dsPubsubA.put(key, serializedRecord)

    // wait until message arrives
    await waitFor(() => receivedMessage === true)

    // reset message wait
    receivedMessage = false

    // put new serializedRecord
    await dsPubsubA.put(key, newSerializedRecord)

    // wait until second message arrives
    await waitFor(() => receivedMessage === true)

    // get from datastore
    const result = await dsPubsubB.get(key)

    // message was discarded as a result of no validator available
    const receivedRecord = Record.deserialize(result)

    // equal to the last value
    expect(receivedRecord.value.toString()).to.equal(newValue)
  })

  it('should subscribe the topic and after a message being received, discard it using the subscriptionKeyFn', async () => {
    const subscriptionKeyFn = (key) => {
      expect(key.toString()).to.equal(`/${keyRef}`)
      throw new Error('DISCARD MESSAGE')
    }
    const dsPubsubA = new DatastorePubsub(pubsubA, datastoreA, peerIdA, smoothValidator)
    const dsPubsubB = new DatastorePubsub(pubsubB, datastoreB, peerIdB, smoothValidator, subscriptionKeyFn)
    const subsTopic = keyToTopic(`/${keyRef}`)
    let receivedMessage = false

    function messageHandler () {
      receivedMessage = true
    }

    const res = await pubsubB.ls()
    expect(res).to.not.include(subsTopic) // not subscribed

    // causes pubsub b to become subscribed to the topic
    await dsPubsubB.get(key)
      .then(() => expect.fail('Should have failed to fetch key'), (err) => {
        // not locally stored record
        expect(err.code).to.equal('ERR_NOT_FOUND')
      })

    await waitForPeerToSubscribe(subsTopic, ipfsdBId, ipfsdA)

    // subscribe in order to understand when the message arrive to the node
    await pubsubB.subscribe(subsTopic, messageHandler)
    await dsPubsubA.put(key, serializedRecord)

    // wait until message arrives
    await waitFor(() => receivedMessage === true)

    // get from datastore
    try {
      await dsPubsubB.get(key)
      expect.fail('Should not have stored message')
    } catch (err) {
      // As message was discarded, it was not stored in the datastore
      expect(err.code).to.equal('ERR_NOT_FOUND')
    }
  })

  it('should subscribe the topic and after a message being received, change its key using subscriptionKeyFn', async () => {
    const subscriptionKeyFn = (key) => {
      expect(key.toString()).to.equal(`/${keyRef}`)
      return topicToKey(`${keyToTopic(key)}new`)
    }
    const dsPubsubA = new DatastorePubsub(pubsubA, datastoreA, peerIdA, smoothValidator)
    const dsPubsubB = new DatastorePubsub(pubsubB, datastoreB, peerIdB, smoothValidator, subscriptionKeyFn)
    const subsTopic = keyToTopic(`/${keyRef}`)
    const keyNew = topicToKey(`${keyToTopic(key)}new`)
    let receivedMessage = false

    function messageHandler () {
      receivedMessage = true
    }

    const res = await pubsubB.ls()
    expect(res).to.not.include(subsTopic) // not subscribed

    // causes pubsub b to become subscribed to the topic
    await dsPubsubB.get(key)
      .then(() => expect.fail('Should have failed to fetch key'), (err) => {
        // not locally stored record
        expect(err.code).to.equal('ERR_NOT_FOUND')
      })

    await waitForPeerToSubscribe(subsTopic, ipfsdBId, ipfsdA)

    // subscribe in order to understand when the message arrive to the node
    await pubsubB.subscribe(subsTopic, messageHandler)
    await dsPubsubA.put(key, serializedRecord)

    // wait until message arrives
    await waitFor(() => receivedMessage === true)

    // get from datastore
    const result = await dsPubsubB.get(keyNew)
    const receivedRecord = Record.deserialize(result)

    expect(receivedRecord.value.toString()).to.equal(value)
  })

  it('should subscribe a topic only once', async () => {
    const dsPubsubA = new DatastorePubsub(pubsubA, datastoreA, peerIdA, smoothValidator)

    sinon.spy(pubsubA, 'subscribe')

    // causes pubsub b to become subscribed to the topic
    await dsPubsubA.get(key)
      .then(() => expect.fail('Should have failed to fetch key'), (err) => {
        // not locally stored record
        expect(err.code).to.equal('ERR_NOT_FOUND')
      })

    // causes pubsub b to become subscribed to the topic
    await dsPubsubA.get(key)
      .then(() => expect.fail('Should have failed to fetch key'), (err) => {
        // not locally stored record
        expect(err.code).to.equal('ERR_NOT_FOUND')
      })

    expect(pubsubA.subscribe.calledOnce).to.equal(true)
  })

  it('should handle a unexpected error properly when getting from the datastore', async () => {
    const dsPubsubA = new DatastorePubsub(pubsubA, datastoreA, peerIdA, smoothValidator)
    const stub = sinon.stub(dsPubsubA._datastore, 'get').throws(errcode(new Error('Wut'), 'RANDOM_ERR'))

    // causes pubsub b to become subscribed to the topic
    await dsPubsubA.get(key)
      .then(() => expect.fail('Should have failed to fetch key'), (err) => {
        // not locally stored record
        expect(err.code).to.equal('ERR_UNEXPECTED_ERROR_GETTING_RECORD')
      })
      .finally(() => {
        stub.restore()
      })
  })
})
