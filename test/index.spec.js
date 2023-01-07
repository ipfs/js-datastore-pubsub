/* eslint-env mocha */

import { expect } from 'aegir/chai'
import sinon from 'sinon'
import errcode from 'err-code'
import { isNode } from 'aegir/env'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string'
import { PubSubDatastore } from '../src/index.js'
import { Key } from 'interface-datastore'
import {
  connectPubsubNodes,
  createComponents,
  waitFor,
  waitForPeerToSubscribe
} from './utils.js'
import { Libp2pRecord } from '@libp2p/record'
import { keyToTopic, topicToKey } from '../src/utils.js'
import { stop } from '@libp2p/interfaces/startable'

/**
 * @typedef {import('@libp2p/interface-pubsub').PubSub} PubSub
 * @typedef {import('interface-datastore').Datastore} Datastore
 * @typedef {import('@libp2p/interface-peer-id').PeerId} PeerId
 * @typedef {import('@libp2p/interface-dht').ValidateFn} Validator
 * @typedef {import('../src/types').SubscriptionKeyFn} SubscriptionKeyFn
 * @typedef {import('./utils.js').Components} Components
 */

// Always returning the expected values
// Valid record and select the new one
const smoothValidator = () => {
  return Promise.resolve()
}

const smoothSelector = () => {
  return 0
}

describe('datastore-pubsub', function () {
  this.timeout(60 * 1000)

  if (!isNode) return

  /** @type {Components} */
  let componentsA
  /** @type {PubSub} */
  let pubsubA
  /** @type {Datastore} */
  let datastoreA
  /** @type {PeerId} */
  let peerIdA

  /** @type {Components} */
  let componentsB
  /** @type {PubSub} */
  let pubsubB
  /** @type {Datastore} */
  let datastoreB
  /** @type {PeerId} */
  let peerIdB

  // Mount pubsub protocol and create datastore instances
  beforeEach(async () => {
    componentsA = await createComponents()
    componentsB = await createComponents()

    await connectPubsubNodes(componentsA, componentsB)

    pubsubA = componentsA.pubsub
    datastoreA = componentsA.datastore
    peerIdA = componentsA.peerId

    pubsubB = componentsB.pubsub
    datastoreB = componentsB.datastore
    peerIdB = componentsB.peerId
  })

  const value = 'value'
  let testCounter = 0
  let keyRef = ''
  /** @type {Uint8Array} */
  let key
  /** @type {import('@libp2p/record').Libp2pRecord} */
  let record
  /** @type {Uint8Array} */
  let serializedRecord

  // prepare Record
  beforeEach(() => {
    keyRef = `key${testCounter}`
    key = (new Key(keyRef)).uint8Array()
    record = new Libp2pRecord(key, uint8ArrayFromString(value), new Date())

    serializedRecord = record.serialize()
  })

  afterEach(() => {
    ++testCounter
  })

  afterEach(() => {
    return Promise.all([
      stop(pubsubA),
      stop(pubsubB)
    ])
  })

  it('should subscribe the topic, but receive error as no entry is stored locally', async () => {
    const dsPubsubA = new PubSubDatastore(pubsubA, datastoreA, peerIdA, smoothValidator, smoothSelector)
    const subsTopic = keyToTopic(`/${keyRef}`)

    let subscribers = await pubsubA.getTopics()

    expect(subscribers).to.exist()
    expect(subscribers).to.not.include(subsTopic) // not subscribed key reference yet

    // not locally stored record
    await expect(dsPubsubA.get(key)).to.eventually.be.rejected().with.property('code', 'ERR_NOT_FOUND')

    subscribers = await pubsubA.getTopics()

    expect(subscribers).to.exist()
    expect(subscribers).to.include(subsTopic) // subscribed key reference
  })

  it('should put correctly to node A and node B should not receive it without subscribing', async () => {
    const dsPubsubA = new PubSubDatastore(pubsubA, datastoreA, peerIdA, smoothValidator, smoothSelector)
    const dsPubsubB = new PubSubDatastore(pubsubB, datastoreB, peerIdB, smoothValidator, smoothSelector)
    const subsTopic = keyToTopic(`/${keyRef}`)

    const res = await pubsubB.getTopics()
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
    /** @type {Validator} */
    const customValidator = async (key, data) => {
      const receivedRecord = Libp2pRecord.deserialize(data)

      expect(uint8ArrayToString(receivedRecord.value)).to.equal(value) // validator should deserialize correctly
    }
    const dsPubsubA = new PubSubDatastore(pubsubA, datastoreA, peerIdA, smoothValidator, smoothSelector)
    const dsPubsubB = new PubSubDatastore(pubsubB, datastoreB, peerIdB, customValidator, smoothSelector)
    const subsTopic = keyToTopic(`/${keyRef}`)
    let receivedMessage = false

    // causes pubsub b to become subscribed to the topic
    await expect(dsPubsubB.get(key)).to.eventually.be.rejected().with.property('code', 'ERR_NOT_FOUND')

    await waitForPeerToSubscribe(subsTopic, peerIdB, pubsubA)

    // subscribe in order to understand when the message arrive to the node
    pubsubB.addEventListener('message', (evt) => {
      if (evt.detail.topic === subsTopic) {
        receivedMessage = true
      }
    })
    await pubsubB.subscribe(subsTopic)

    await dsPubsubA.put(key, serializedRecord)

    // wait until message arrives
    await waitFor(() => receivedMessage === true)

    // get from datastore
    const record = await dsPubsubB.get(key)

    expect(record).to.be.ok()
  })

  it('should put correctly to daemon A and daemon B should receive it as it tried to get it first and subscribed it', async () => {
    const dsPubsubA = new PubSubDatastore(pubsubA, datastoreA, peerIdA, smoothValidator, smoothSelector)
    const dsPubsubB = new PubSubDatastore(pubsubB, datastoreB, peerIdB, smoothValidator, smoothSelector)
    const subsTopic = keyToTopic(`/${keyRef}`)
    let receivedMessage = false

    const res = await pubsubB.getTopics()
    expect(res).to.exist()
    expect(res).to.not.include(subsTopic) // not subscribed

    // causes pubsub b to become subscribed to the topic
    await dsPubsubB.get(key)
      .then(() => expect.fail('Should have failed to fetch key'), (err) => {
        // not locally stored record
        expect(err.code).to.equal('ERR_NOT_FOUND')
      })

    await waitForPeerToSubscribe(subsTopic, peerIdB, pubsubA)

    // subscribe in order to understand when the message arrive to the node
    pubsubB.addEventListener('message', (evt) => {
      if (evt.detail.topic === subsTopic) {
        receivedMessage = true
      }
    })
    await pubsubB.subscribe(subsTopic)
    await dsPubsubA.put(key, serializedRecord)

    // wait until message arrives
    await waitFor(() => receivedMessage === true)

    // get from datastore
    const result = await dsPubsubB.get(key)
    expect(result).to.exist()

    const receivedRecord = Libp2pRecord.deserialize(result)
    expect(uint8ArrayToString(receivedRecord.value)).to.equal(value)
  })

  it('should fail to create the PubSubDatastore if no validator is provided', () => {
    let dsPubsubB
    try {
      // @ts-expect-error no validator provided
      dsPubsubB = new PubSubDatastore(pubsubB, datastoreB, peerIdB)
    } catch (/** @type {any} */ err) {
      expect(err.code).to.equal('ERR_INVALID_PARAMETERS')
    }

    expect(dsPubsubB).to.equal(undefined)
  })

  it('should fail to create the PubSubDatastore if no validate function is provided', () => {
    const customValidator = {
      validate: undefined,
      select: () => {
        return 0
      }
    }

    let dsPubsubB
    try {
      // @ts-expect-error invalid validator provided
      dsPubsubB = new PubSubDatastore(pubsubB, datastoreB, peerIdB, customValidator)
    } catch (/** @type {any} */ err) {
      expect(err.code).to.equal('ERR_INVALID_PARAMETERS')
    }

    expect(dsPubsubB).to.equal(undefined)
  })

  it('should fail to create the PubSubDatastore if no select function is provided', () => {
    const customValidator = {
      validate: () => {
        return true
      },
      select: undefined
    }

    let dsPubsubB
    try {
      // @ts-expect-error invalid validator provided
      dsPubsubB = new PubSubDatastore(pubsubB, datastoreB, peerIdB, customValidator)
    } catch (/** @type {any} */ err) {
      expect(err.code).to.equal('ERR_INVALID_PARAMETERS')
    }

    expect(dsPubsubB).to.equal(undefined)
  })

  it('should fail if it fails getTopics to validate the record', async () => {
    const customValidator = () => {
      throw new Error()
    }
    const dsPubsubA = new PubSubDatastore(pubsubA, datastoreA, peerIdA, smoothValidator, smoothSelector)
    const dsPubsubB = new PubSubDatastore(pubsubB, datastoreB, peerIdB, customValidator, smoothSelector)
    const subsTopic = keyToTopic(`/${keyRef}`)
    let receivedMessage = false

    // causes pubsub b to become subscribed to the topic
    await dsPubsubB.get(key)
      .then(() => expect.fail('Should have failed to fetch key'), (err) => {
        // not locally stored record
        expect(err.code).to.equal('ERR_NOT_FOUND')
      })

    await waitForPeerToSubscribe(subsTopic, peerIdB, pubsubA)

    // subscribe in order to understand when the message arrive to the node
    pubsubB.addEventListener('message', (evt) => {
      if (evt.detail.topic === subsTopic) {
        receivedMessage = true
      }
    })
    await pubsubB.subscribe(subsTopic)
    await dsPubsubA.put(key, serializedRecord)

    // wait until message arrives
    await waitFor(() => receivedMessage === true)

    try {
      // get from datastore
      await dsPubsubB.get(key)
      expect.fail('Should have disguarded invalid message')
    } catch (/** @type {any} */ err) {
      // No record received, in spite of message received
      expect(err.code).to.equal('ERR_NOT_FOUND')
    }
  })

  it('should get the second record if the selector selects it as the newest one', async () => {
    const customSelector = () => {
      return 1 // current record is the newer
    }

    const newValue = 'new value'
    const record = new Libp2pRecord(key, uint8ArrayFromString(newValue), new Date())
    const newSerializedRecord = record.serialize()

    const dsPubsubA = new PubSubDatastore(pubsubA, datastoreA, peerIdA, smoothValidator, smoothSelector)
    const dsPubsubB = new PubSubDatastore(pubsubB, datastoreB, peerIdB, smoothValidator, customSelector)
    const subsTopic = keyToTopic(`/${keyRef}`)
    let receivedMessage = false

    // causes pubsub b to become subscribed to the topic
    await dsPubsubB.get(key)
      .then(() => expect.fail('Should have failed to fetch key'), (err) => {
        // not locally stored record
        expect(err.code).to.equal('ERR_NOT_FOUND')
      })

    await waitForPeerToSubscribe(subsTopic, peerIdB, pubsubA)

    // subscribe in order to understand when the message arrive to the node
    pubsubB.addEventListener('message', (evt) => {
      if (evt.detail.topic === subsTopic) {
        receivedMessage = true
      }
    })
    await pubsubB.subscribe(subsTopic)
    await dsPubsubA.put(key, serializedRecord)

    // wait until message arrives
    await waitFor(() => receivedMessage === true)
    await dsPubsubA.put(key, newSerializedRecord) // put new serializedRecord

    // wait until message arrives
    await waitFor(() => receivedMessage === true)

    // get from datastore
    // message was discarded as a result of no validator available
    const result = await dsPubsubB.get(key)
    const receivedRecord = Libp2pRecord.deserialize(result)
    expect(receivedRecord.value.toString()).to.not.equal(newValue) // not equal to the last value
  })

  it('should get the new record if the selector selects it as the newest one', async () => {
    const newValue = 'new value'
    const record = new Libp2pRecord(key, uint8ArrayFromString(newValue), new Date())
    const newSerializedRecord = record.serialize()

    const dsPubsubA = new PubSubDatastore(pubsubA, datastoreA, peerIdA, smoothValidator, smoothSelector)
    const dsPubsubB = new PubSubDatastore(pubsubB, datastoreB, peerIdB, smoothValidator, smoothSelector)
    const subsTopic = keyToTopic(`/${keyRef}`)
    let receivedMessage = false

    // causes pubsub b to become subscribed to the topic
    await dsPubsubB.get(key)
      .then(() => expect.fail('Should have failed to fetch key'), (err) => {
        // not locally stored record
        expect(err.code).to.equal('ERR_NOT_FOUND')
      })

    await waitForPeerToSubscribe(subsTopic, peerIdB, pubsubA)

    // subscribe in order to understand when the message arrive to the node
    pubsubB.addEventListener('message', (evt) => {
      if (evt.detail.topic === subsTopic) {
        receivedMessage = true
      }
    })
    await pubsubB.subscribe(subsTopic)
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
    const receivedRecord = Libp2pRecord.deserialize(result)

    // equal to the last value
    expect(uint8ArrayToString(receivedRecord.value)).to.equal(newValue)
  })

  it('should subscribe the topic and after a message being received, discard it using the subscriptionKeyFn', async () => {
    /** @type {SubscriptionKeyFn} */
    const subscriptionKeyFn = (key) => {
      expect(uint8ArrayToString(key)).to.equal(`/${keyRef}`)
      throw new Error('DISCARD MESSAGE')
    }
    const dsPubsubA = new PubSubDatastore(pubsubA, datastoreA, peerIdA, smoothValidator, smoothSelector)
    const dsPubsubB = new PubSubDatastore(pubsubB, datastoreB, peerIdB, smoothValidator, smoothSelector, subscriptionKeyFn)
    const subsTopic = keyToTopic(`/${keyRef}`)
    let receivedMessage = false

    const res = await pubsubB.getTopics()
    expect(res).to.not.include(subsTopic) // not subscribed

    // causes pubsub b to become subscribed to the topic
    await dsPubsubB.get(key)
      .then(() => expect.fail('Should have failed to fetch key'), (err) => {
        // not locally stored record
        expect(err.code).to.equal('ERR_NOT_FOUND')
      })

    await waitForPeerToSubscribe(subsTopic, peerIdB, pubsubA)

    // subscribe in order to understand when the message arrive to the node
    pubsubB.addEventListener('message', (evt) => {
      if (evt.detail.topic === subsTopic) {
        receivedMessage = true
      }
    })
    await pubsubB.subscribe(subsTopic)
    await dsPubsubA.put(key, serializedRecord)

    // wait until message arrives
    await waitFor(() => receivedMessage === true)

    // get from datastore
    try {
      await dsPubsubB.get(key)
      expect.fail('Should not have stored message')
    } catch (/** @type {any} */ err) {
      // As message was discarded, it was not stored in the datastore
      expect(err.code).to.equal('ERR_NOT_FOUND')
    }
  })

  it('should subscribe the topic and after a message being received, change its key using subscriptionKeyFn', async () => {
    /** @type {SubscriptionKeyFn} */
    const subscriptionKeyFn = (key) => {
      expect(uint8ArrayToString(key)).to.equal(`/${keyRef}`)
      return Promise.resolve(topicToKey(`${keyToTopic(key)}new`))
    }
    const dsPubsubA = new PubSubDatastore(pubsubA, datastoreA, peerIdA, smoothValidator, smoothSelector)
    const dsPubsubB = new PubSubDatastore(pubsubB, datastoreB, peerIdB, smoothValidator, smoothSelector, subscriptionKeyFn)
    const subsTopic = keyToTopic(`/${keyRef}`)
    const keyNew = topicToKey(`${keyToTopic(key)}new`)
    let receivedMessage = false

    const res = await pubsubB.getTopics()
    expect(res).to.not.include(subsTopic) // not subscribed

    // causes pubsub b to become subscribed to the topic
    await dsPubsubB.get(key)
      .then(() => expect.fail('Should have failed to fetch key'), (err) => {
        // not locally stored record
        expect(err.code).to.equal('ERR_NOT_FOUND')
      })

    await waitForPeerToSubscribe(subsTopic, peerIdB, pubsubA)

    // subscribe in order to understand when the message arrive to the node
    pubsubB.addEventListener('message', (evt) => {
      if (evt.detail.topic === subsTopic) {
        receivedMessage = true
      }
    })
    await pubsubB.subscribe(subsTopic)
    await dsPubsubA.put(key, serializedRecord)

    // wait until message arrives
    await waitFor(() => receivedMessage === true)

    // get from datastore
    const result = await dsPubsubB.get(keyNew)
    const receivedRecord = Libp2pRecord.deserialize(result)
    expect(uint8ArrayToString(receivedRecord.value)).to.equal(value)
  })

  it('should subscribe a topic only once', async () => {
    const addEventListenerSpy = sinon.spy(pubsubA, 'addEventListener')
    const dsPubsubA = new PubSubDatastore(pubsubA, datastoreA, peerIdA, smoothValidator, smoothSelector)

    // fails but causes pubsub b to become subscribed to the topic
    await expect(dsPubsubA.get(key)).to.eventually.be.rejected().with.property('code', 'ERR_NOT_FOUND')

    // causes pubsub b to become subscribed to the topic
    await expect(dsPubsubA.get(key)).to.eventually.be.rejected().with.property('code', 'ERR_NOT_FOUND')

    expect(addEventListenerSpy.calledOnce).to.equal(true)
  })

  it('should handle a unexpected error properly when getting from the datastore', async () => {
    const dsPubsubA = new PubSubDatastore(pubsubA, datastoreA, peerIdA, smoothValidator, smoothSelector)
    const stub = sinon.stub(dsPubsubA._datastore, 'get').throws(errcode(new Error('Wut'), 'RANDOM_ERR'))

    // causes pubsub b to become subscribed to the topic
    await expect(dsPubsubA.get(key)).to.eventually.be.rejected().with.property('code', 'ERR_UNEXPECTED_ERROR_GETTING_RECORD')

    stub.restore()
  })
})
