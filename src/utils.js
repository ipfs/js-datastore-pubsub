'use strict'

const base32 = require('base32.js')
const base64url = require('base64url')

const namespace = '/record/'

module.exports.encodeBase32 = (buf) => {
  const enc = new base32.Encoder()
  return enc.write(buf).finalize()
}

// converts a binary record key to a pubsub topic key.
module.exports.keyToTopic = (key) => {
  // Record-store keys are arbitrary binary. However, pubsub requires UTF-8 string topic IDs
  // Encodes to "/record/base64url(key)"
  return `${namespace}${base64url.encode(key)}`
}

// converts a pubsub topic key to a binary record key.
module.exports.topicToKey = (topic) => {
  return base64url.decode(topic.substring(namespace.length))
}
