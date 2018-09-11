'use strict'

const ipfs = require('ipfs')
const DaemonFactory = require('ipfsd-ctl')

const parallel = require('async/parallel')
const retry = require('async/retry')
const series = require('async/series')

const config = {
  Addresses: {
    API: '/ip4/0.0.0.0/tcp/0',
    Gateway: '/ip4/0.0.0.0/tcp/0',
    Swarm: ['/ip4/0.0.0.0/tcp/0', '/ip4/0.0.0.0/tcp/0/ws']
  }
}

// spawn a daemon
const spawnDaemon = (callback) => {
  DaemonFactory.create({ exec: ipfs, type: 'proc' })
    .spawn({
      args: ['--enable-pubsub-experiment'],
      disposable: true,
      bits: 512,
      config
    }, callback)
}

// stop a daemon
const stopDaemon = (daemon, callback) => {
  series([
    (cb) => daemon.stop(cb),
    (cb) => setTimeout(cb, 200),
    (cb) => daemon.cleanup(cb)
  ], callback)
}

// connect two peers
const connect = (dA, dAId, dB, dBId, callback) => {
  const dALocalAddress = dAId.addresses.find(a => a.includes('127.0.0.1'))
  const dBLocalAddress = dBId.addresses.find(a => a.includes('127.0.0.1'))

  parallel([
    (cb) => dA.api.swarm.connect(dBLocalAddress, cb),
    (cb) => dB.api.swarm.connect(dALocalAddress, cb)
  ], callback)
}

// Wait for a condition to become true.  When its true, callback is called.
const waitFor = (predicate, callback) => {
  const ttl = Date.now() + (10 * 1000)
  const self = setInterval(() => {
    if (predicate()) {
      clearInterval(self)
      return callback()
    }
    if (Date.now() > ttl) {
      clearInterval(self)
      return callback(new Error('waitFor time expired'))
    }
  }, 500)
}

// Wait until a peer subscribes a topic
const waitForPeerToSubscribe = (topic, peer, daemon, callback) => {
  retry({
    times: 5,
    interval: 1000
  }, (next) => {
    daemon.api.pubsub.peers(topic, (error, peers) => {
      if (error) {
        return next(error)
      }

      if (!peers.includes(peer.id)) {
        return next(new Error(`Could not find peer ${peer.id}`))
      }

      return next()
    })
  }, callback)
}

module.exports = {
  connect,
  waitFor,
  waitForPeerToSubscribe,
  spawnDaemon,
  stopDaemon
}
