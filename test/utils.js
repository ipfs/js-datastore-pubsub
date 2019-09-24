'use strict'

const ipfs = require('ipfs')
const DaemonFactory = require('ipfsd-ctl')
const delay = require('delay')

const config = {
  Addresses: {
    API: '/ip4/0.0.0.0/tcp/0',
    Gateway: '/ip4/0.0.0.0/tcp/0',
    Swarm: ['/ip4/0.0.0.0/tcp/0', '/ip4/0.0.0.0/tcp/0/ws']
  }
}

// spawn a daemon
const spawnDaemon = () => {
  const d = DaemonFactory.create({
    exec: ipfs,
    type: 'proc',
    IpfsApi: require('ipfs-http-client')
  })

  return d.spawn({
    disposable: true,
    bits: 512,
    config,
    EXPERIMENTAL: {
      pubsub: true
    }
  })
}

// stop a daemon
const stopDaemon = async (daemon) => {
  await daemon.stop()
  await new Promise((resolve) => setTimeout(() => resolve(), 200))
  return daemon.cleanup()
}

// connect two peers
const connect = (dA, dAId, dB, dBId) => {
  const dALocalAddress = dAId.addresses.find(a => a.includes('127.0.0.1'))
  const dBLocalAddress = dBId.addresses.find(a => a.includes('127.0.0.1'))

  return Promise.all([
    dA.api.swarm.connect(dBLocalAddress),
    dB.api.swarm.connect(dALocalAddress)
  ])
}

// Wait for a condition to become true.  When its true, callback is called.
const waitFor = async (predicate) => {
  for (let i = 0; i < 10; i++) {
    if (await predicate()) {
      return
    }

    await delay(1000)
  }

  throw new Error('waitFor time expired')
}

// Wait until a peer subscribes a topic
const waitForPeerToSubscribe = async (topic, peer, daemon) => {
  for (let i = 0; i < 5; i++) {
    const peers = await daemon.api.pubsub.peers(topic)

    if (peers.includes(peer.id)) {
      return
    }

    await delay(1000)
  }
}

module.exports = {
  connect,
  waitFor,
  waitForPeerToSubscribe,
  spawnDaemon,
  stopDaemon
}
