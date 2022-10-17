import pWaitFor from 'p-wait-for'
import { floodsub, multicodec } from '@libp2p/floodsub'
import { createEd25519PeerId } from '@libp2p/peer-id-factory'
import { connectionPair, mockRegistrar, mockConnectionManager } from '@libp2p/interface-mocks'
import { MemoryDatastore } from 'datastore-core'
import { start } from '@libp2p/interfaces/startable'

/**
 * @typedef {import('@libp2p/interface-pubsub').PubSub} PubSub
 * @typedef {import('@libp2p/interface-peer-id').PeerId} PeerId
 * @typedef {import('@libp2p/interface-registrar').Registrar} Registrar
 * @typedef {import('interface-datastore').Datastore} Datastore
 */

/**
 * @typedef {object} Components
 * @property {PeerId} peerId
 * @property {Registrar} registrar
 * @property {Datastore} datastore
 * @property {PubSub} pubsub
 *
 * As created by libp2p
 *
 * @returns {Promise<Components>}
 */
export const createComponents = async () => {
  /** @type {any} */
  const components = {
    peerId: await createEd25519PeerId(),
    registrar: mockRegistrar(),
    datastore: new MemoryDatastore()
  }

  components.connectionManager = mockConnectionManager(components)

  const pubsub = floodsub({
    emitSelf: true
  })(components)
  await start(pubsub)

  components.pubsub = pubsub

  return components
}

/**
 *
 * @param {{ peerId: PeerId, registrar: Registrar }} componentsA
 * @param {{ peerId: PeerId, registrar: Registrar }} componentsB
 */
export const connectPubsubNodes = async (componentsA, componentsB) => {
  // Notify peers of connection
  const [c0, c1] = connectionPair(componentsA, componentsB)

  componentsA.registrar.getTopologies(multicodec).forEach(topology => {
    topology.onConnect(componentsB.peerId, c0)
  })
  componentsB.registrar.getTopologies(multicodec).forEach(topology => {
    topology.onConnect(componentsA.peerId, c1)
  })
}

/**
 * Wait for a condition to become true.  When its true, callback is called.
 *
 * @param {() => boolean} predicate
 */
export const waitFor = predicate => pWaitFor(predicate, { interval: 100, timeout: 10000 })

/**
 * Wait until a peer subscribes a topic
 *
 * @param {string} topic
 * @param {PeerId} peer
 * @param {PubSub} node
 */
export const waitForPeerToSubscribe = (topic, peer, node) => {
  return pWaitFor(async () => {
    const peers = await node.getSubscribers(topic)

    if (peers.map(p => p.toString()).includes(peer.toString())) {
      return true
    }

    return false
  }, {
    interval: 100,
    timeout: 5000
  })
}
