import { duplexPair } from 'it-pair/duplex'
import pWaitFor from 'p-wait-for'
import { Gossipsub } from '@achingbrain/libp2p-gossipsub'
import { createEd25519PeerId } from '@libp2p/peer-id-factory'
import { Components } from '@libp2p/interfaces/components'

const { multicodec } = Gossipsub

/**
 * @typedef {import('@libp2p/interfaces/pubsub').PubSub} Pubsub
 * @typedef {import('@libp2p/interfaces/peer-id').PeerId} PeerId
 */

/**
 * @param {Record<string, any>} registrarRecord
 */
const createMockRegistrar = (registrarRecord) => {
  return {
    /** @type {import('libp2p').Libp2p["handle"]} */
    handle: async (multicodecs, handler) => {
      const rec = registrarRecord[multicodecs[0]] || {}

      registrarRecord[multicodecs[0]] = {
        ...rec,
        handler
      }
    },
    /** @type {import('libp2p').Libp2p["unhandle"]} */
    unhandle: async (multicodecs) => {
      delete registrarRecord[multicodecs[0]]
    },
    /**
     * @param {string[]} multicodecs
     * @param {import('@libp2p/interfaces/topology').Topology} topology
     */
    register: async (multicodecs, topology) => {
      const { onConnect, onDisconnect } = topology

      const rec = registrarRecord[multicodecs[0]] || {}

      registrarRecord[multicodecs[0]] = {
        ...rec,
        onConnect,
        onDisconnect
      }

      return multicodecs[0]
    },
    unregister: () => true
  }
}

/**
 * As created by libp2p
 *
 * @param {object} registrarRecord
 * @returns {Promise<{ peerId: PeerId, pubsub: Gossipsub }>}
 */
export const createPubsubNode = async (registrarRecord) => {
  const peerId = await createEd25519PeerId()

  const libp2p = {
    peerId,
    registrar: createMockRegistrar(registrarRecord),
    connectionManager: {
      getAll: () => []
    }
  }

  // @ts-expect-error just enough libp2p
  const pubsub = new Gossipsub(libp2p)
  // @ts-expect-error just enough libp2p
  pubsub.init(new Components(libp2p))

  await pubsub.start()

  return {
    pubsub,
    peerId
  }
}

const ConnectionPair = () => {
  const [d0, d1] = duplexPair()

  return [
    {
      stream: d0,
      newStream: () => Promise.resolve({ stream: d0 })
    },
    {
      stream: d1,
      newStream: () => Promise.resolve({ stream: d1 })
    }
  ]
}

/**
 * @typedef {object} Connectable
 * @property {Pubsub} router
 * @property {any} registrar
 * @property {PeerId} peerId
 *
 * @param {Connectable} pubsubA
 * @param {Connectable} pubsubB
 */
export const connectPubsubNodes = async (pubsubA, pubsubB) => {
  const onConnectA = pubsubA.registrar[multicodec].onConnect
  const onConnectB = pubsubB.registrar[multicodec].onConnect
  const handleA = pubsubA.registrar[multicodec].handler
  const handleB = pubsubB.registrar[multicodec].handler

  // Notice peers of connection
  const [c0, c1] = ConnectionPair()
  await onConnectA(pubsubB.peerId, c0)
  await onConnectB(pubsubA.peerId, c1)

  await handleB({
    protocol: multicodec,
    stream: c1.stream,
    connection: {
      remotePeer: pubsubA.peerId
    }
  })

  await handleA({
    protocol: multicodec,
    stream: c0.stream,
    connection: {
      remotePeer: pubsubB.peerId
    }
  })
}

/**
 * Wait for a condition to become true.  When its true, callback is called.
 *
 * @param {() => boolean} predicate
 */
export const waitFor = predicate => pWaitFor(predicate, { interval: 1000, timeout: 10000 })

/**
 * Wait until a peer subscribes a topic
 *
 * @param {string} topic
 * @param {PeerId} peer
 * @param {Pubsub} node
 */
export const waitForPeerToSubscribe = (topic, peer, node) => {
  return pWaitFor(async () => {
    const peers = await node.getSubscribers(topic)

    if (peers.map(p => p.toString()).includes(peer.toString())) {
      return true
    }

    return false
  }, {
    interval: 1000,
    timeout: 5000
  })
}
