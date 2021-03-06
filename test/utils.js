'use strict'

const PeerId = require('peer-id')
// @ts-ignore
const DuplexPair = require('it-pair/duplex')

const Gossipsub = require('libp2p-gossipsub')
const { multicodec } = Gossipsub

const pWaitFor = require('p-wait-for')

/**
 * @typedef {import('libp2p-interfaces/src/pubsub')} Pubsub
 */

/**
 * @param {Record<string, any>} registrarRecord
 */
const createMockRegistrar = (registrarRecord) => {
  return {
    /** @type {import('libp2p')["handle"]} */
    handle: (multicodecs, handler) => {
      const rec = registrarRecord[multicodecs[0]] || {}

      registrarRecord[multicodecs[0]] = {
        ...rec,
        handler
      }
    },
    /**
     *
     * @param {import('libp2p-interfaces/src/topology') & { multicodecs: string[] }} arg
     */
    register: ({ multicodecs, _onConnect, _onDisconnect }) => {
      const rec = registrarRecord[multicodecs[0]] || {}

      registrarRecord[multicodecs[0]] = {
        ...rec,
        onConnect: _onConnect,
        onDisconnect: _onDisconnect
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
 */
exports.createPubsubNode = async (registrarRecord) => {
  const peerId = await PeerId.create({ bits: 1024 })

  const libp2p = {
    peerId,
    registrar: createMockRegistrar(registrarRecord),
    connectionManager: {
      getAll: () => []
    }
  }

  // @ts-ignore just enough libp2p
  const pubsub = new Gossipsub(libp2p)

  await pubsub.start()

  return pubsub
}

const ConnectionPair = () => {
  const [d0, d1] = DuplexPair()

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
 *
 * @param {Connectable} pubsubA
 * @param {Connectable} pubsubB
 */
exports.connectPubsubNodes = async (pubsubA, pubsubB) => {
  const onConnectA = pubsubA.registrar[multicodec].onConnect
  const onConnectB = pubsubB.registrar[multicodec].onConnect
  const handleA = pubsubA.registrar[multicodec].handler
  const handleB = pubsubB.registrar[multicodec].handler

  // Notice peers of connection
  const [c0, c1] = ConnectionPair()
  await onConnectA(pubsubB.router.peerId, c0)
  await onConnectB(pubsubA.router.peerId, c1)

  await handleB({
    protocol: multicodec,
    stream: c1.stream,
    connection: {
      remotePeer: pubsubA.router.peerId
    }
  })

  await handleA({
    protocol: multicodec,
    stream: c0.stream,
    connection: {
      remotePeer: pubsubB.router.peerId
    }
  })
}

/**
 * Wait for a condition to become true.  When its true, callback is called.
 *
 * @param {() => boolean} predicate
 */
exports.waitFor = predicate => pWaitFor(predicate, { interval: 1000, timeout: 10000 })

/**
 * Wait until a peer subscribes a topic
 *
 * @param {string} topic
 * @param {PeerId} peer
 * @param {Pubsub} node
 */
exports.waitForPeerToSubscribe = (topic, peer, node) => {
  return pWaitFor(async () => {
    const peers = await node.getSubscribers(topic)

    if (peers.includes(peer.toB58String())) {
      return true
    }

    return false
  }, {
    interval: 1000,
    timeout: 5000
  })
}
