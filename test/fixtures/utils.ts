import pWaitFor from 'p-wait-for'
import { floodsub, multicodec } from '@libp2p/floodsub'
import { createEd25519PeerId } from '@libp2p/peer-id-factory'
import { connectionPair, mockRegistrar, mockConnectionManager } from '@libp2p/interface-mocks'
import { MemoryDatastore } from 'datastore-core'
import { start } from '@libp2p/interfaces/startable'
import type { PeerId } from '@libp2p/interface-peer-id'
import type { Registrar } from '@libp2p/interface-registrar'
import type { Datastore } from 'interface-datastore'
import type { PubSub } from '@libp2p/interface-pubsub'
import type { ConnectionManager } from '@libp2p/interface-connection-manager'

export interface Components {
  peerId: PeerId
  registrar: Registrar
  datastore: Datastore
  pubsub: PubSub
  connectionManager: ConnectionManager
}

/**
 * As created by libp2p
 */
export const createComponents = async (): Promise<Components> => {
  const components: any = {
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

export const connectPubsubNodes = async (componentsA: Components, componentsB: Components): Promise<void> => {
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
 */
export const waitFor = async (predicate: () => boolean): Promise<void> => { await pWaitFor(predicate, { interval: 100, timeout: 10000 }) }

/**
 * Wait until a peer subscribes a topic
 *
 * @param {string} topic
 * @param {PeerId} peer
 * @param {PubSub} node
 */
export const waitForPeerToSubscribe = async (topic: string, peer: PeerId, node: PubSub): Promise<void> => {
  await pWaitFor(async () => {
    const peers = node.getSubscribers(topic)

    if (peers.map(p => p.toString()).includes(peer.toString())) {
      return true
    }

    return false
  }, {
    interval: 100,
    timeout: 5000
  })
}
