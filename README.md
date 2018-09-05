# datastore-pubsub

[![](https://img.shields.io/badge/made%20by-Protocol%20Labs-blue.svg?style=flat-square)](http://protocol.ai)
[![](https://img.shields.io/badge/project-IPFS-blue.svg?style=flat-square)](http://ipfs.io/)
[![](https://img.shields.io/badge/freenode-%23ipfs-blue.svg?style=flat-square)](http://webchat.freenode.net/?channels=%23ipfs)
[![standard-readme](https://img.shields.io/badge/standard--readme-OK-green.svg?style=flat-square)](https://github.com/RichardLitt/standard-readme)
[![js-standard-style](https://img.shields.io/badge/code%20style-standard-brightgreen.svg?style=flat-square)](https://github.com/feross/standard)

> provides an implementation of an interface-datastore compliant api for pubsub

## Lead Maintainer

[Vasco Santos](https://github.com/vasco-santos).

## Table of Contents

- [Install](#install)
- [Usage](#usage)
- [API](#api)
- [Contribute](#contribute)
- [License](#license)

### Install

> npm install datastore-pubsub

## Usage

```js
const DatastorePubsub = require('datastore-pubsub')

const dsPubsub = new DatastorePubsub(pubsub, datastore, peerId, validator)
```

## API

#### Setup

```js
new DatastorePubsub(pubsub, datastore, peerId, validator)
```

Creates a DatastorePubsub instance.

Arguments:

- `pubsub` (Object): implementation of a pubsub (must have publish and subscribe functions), such as [libp2p/pubsub](https://github.com/libp2p/js-libp2p/blob/master/src/pubsub.js).
- `datastore` (Object): datastore compliant with [interface-datastore](https://github.com/ipfs/interface-datastore), such as [datastore-fs](https://github.com/ipfs/js-datastore-fs).
- `peerId` (`PeerId` [Instance](https://github.com/libp2p/js-peer-id)): peer identifier object.
- `validator` (Object): containing validate function and select function.

Note: `validator` object must be composed by two functions, `validate (data, peerId, callback)` and `select (receivedRecod, currentRecord, callback)`. `validate` aims to verify if a new record received by pubsub is valid to be stored locally by the node. If it is valid and the node already has a local record stored, `select` is the function provided to be responsible for deciding which record is the best (newer) between the already stored and the received through pubsub. A `validator` example can be found at: TODO (js-ipns)

```js
const dsPubsub = new DatastorePubsub(pubsub, datastore, peerId, validator)
```

#### Get

```js
dsPubsub.get(key, callback)
```

Try to subscribe a topic with Pubsub and receive the current local value if available.

Arguments:

- `key` (`Key` [Instance](https://github.com/ipfs/interface-datastore/blob/master/src/key.js)): a key representing a unique identifier of the object to subscribe.
- `callback` (function): operation result.

`callback` must follow `function (err, data) {}` signature, where `err` is an error if the operation was not successful. If no `err` is received, a `data` is received containing the most recent known record stored (`Buffer`).

#### Put

```js
dsPubsub.put(key, val, callback)
```

Publishes a value through pubsub.

Arguments:

- `key` (`Key` [Instance](https://github.com/ipfs/interface-datastore/blob/master/src/key.js)): a key representing a unique identifier of the object to publish.
- `val` (Buffer): value to be propagated.
- `callback` (function): operation result.

`callback` must follow `function (err) {}` signature, where `err` is an error if the operation was not successful.

## Contribute

Feel free to join in. All welcome. Open an [issue](https://github.com/ipfs/js-ipns/issues)!

This repository falls under the IPFS [Code of Conduct](https://github.com/ipfs/community/blob/master/code-of-conduct.md).

[![](https://cdn.rawgit.com/jbenet/contribute-ipfs-gif/master/img/contribute.gif)](https://github.com/ipfs/community/blob/master/contributing.md)

## License

Copyright (c) Protocol Labs, Inc. under the **MIT License**. See [LICENSE file](./LICENSE) for details.
