import pWaitFor from 'p-wait-for'
import { GossipSub } from '@achingbrain/libp2p-gossipsub'
import { createEd25519PeerId } from '@libp2p/peer-id-factory'
import { connectionPair, mockRegistrar, mockConnectionManager } from '@libp2p/interface-compliance-tests/mocks'
import { Components } from '@libp2p/interfaces/components'
import { MemoryDatastore } from 'datastore-core'

const { multicodec } = GossipSub

/**
 * @typedef {import('@libp2p/interfaces/pubsub').PubSub} PubSub
 * @typedef {import('@libp2p/interfaces/peer-id').PeerId} PeerId
 */

/**
 * As created by libp2p
 *
 * @returns {Promise<Components>}
 */
export const createComponents = async () => {
  const components = new Components({
    peerId: await createEd25519PeerId(),
    registrar: mockRegistrar(),
    datastore: new MemoryDatastore(),
    connectionManager: mockConnectionManager()
  })

  const pubsub = new GossipSub({
    emitSelf: true,
    allowPublishToZeroPeers: true
  })
  pubsub.init(components)
  await pubsub.start()

  components.setPubSub(pubsub)

  return components
}

/**
 *
 * @param {Components} componentsA
 * @param {Components} componentsB
 */
export const connectPubsubNodes = async (componentsA, componentsB) => {
  // Notify peers of connection
  const [c0, c1] = connectionPair(componentsA, componentsB)

  componentsA.getRegistrar().getTopologies(multicodec).forEach(topology => {
    topology.onConnect(componentsB.getPeerId(), c0)
  })
  componentsB.getRegistrar().getTopologies(multicodec).forEach(topology => {
    topology.onConnect(componentsA.getPeerId(), c1)
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
