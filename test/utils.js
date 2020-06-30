'use strict'

const PeerId = require('peer-id')
const DuplexPair = require('it-pair/duplex')

const Pubsub = require('libp2p-gossipsub')
const { multicodec } = require('libp2p-gossipsub')

const pWaitFor = require('p-wait-for')

const createMockRegistrar = (registrarRecord) => ({
  handle: (multicodecs, handler) => {
    const rec = registrarRecord[multicodecs[0]] || {}

    registrarRecord[multicodecs[0]] = {
      ...rec,
      handler
    }
  },
  register: ({ multicodecs, _onConnect, _onDisconnect }) => {
    const rec = registrarRecord[multicodecs[0]] || {}

    registrarRecord[multicodecs[0]] = {
      ...rec,
      onConnect: _onConnect,
      onDisconnect: _onDisconnect
    }

    return multicodecs[0]
  },
  unregister: () => {}
})

// as created by libp2p
exports.createPubsubNode = async (registrarRecord) => {
  const peerId = await PeerId.create({ bits: 1024 })
  const pubsub = new Pubsub(peerId, createMockRegistrar(registrarRecord))

  await pubsub.start()

  return {
    peerId: pubsub.peerId,
    subscribe: (topic, handler) => {
      pubsub.subscribe(topic)

      pubsub.on(topic, handler)
    },
    unsubscribe: (topic, handler) => {
      if (!handler) {
        pubsub.removeAllListeners(topic)
      } else {
        pubsub.removeListener(topic, handler)
      }

      pubsub.unsubscribe(topic)
    },
    publish: (topic, data) => pubsub.publish(topic, data),
    getTopics: () => pubsub.getTopics(),
    getSubscribers: (topic) => pubsub.getSubscribers(topic),
    stop: () => pubsub.stop()
  }
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

// Wait for a condition to become true.  When its true, callback is called.
exports.waitFor = predicate => pWaitFor(predicate, { interval: 1000, timeout: 10000 })

// Wait until a peer subscribes a topic
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
