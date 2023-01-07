# datastore-pubsub <!-- omit in toc -->

[![ipfs.tech](https://img.shields.io/badge/project-IPFS-blue.svg?style=flat-square)](https://ipfs.tech)
[![Discuss](https://img.shields.io/discourse/https/discuss.ipfs.tech/posts.svg?style=flat-square)](https://discuss.ipfs.tech)
[![codecov](https://img.shields.io/codecov/c/github/ipfs/js-datastore-pubsub.svg?style=flat-square)](https://codecov.io/gh/ipfs/js-datastore-pubsub)
[![CI](https://img.shields.io/github/actions/workflow/status/ipfs/js-datastore-pubsub/js-test-and-release.yml?branch=master\&style=flat-square)](https://github.com/ipfs/js-datastore-pubsub/actions/workflows/js-test-and-release.yml?query=branch%3Amaster)

> Responsible for providing an interface-datastore compliant api to pubsub

## Table of contents <!-- omit in toc -->

- [Install](#install)
  - [Browser `<script>` tag](#browser-script-tag)
- [Usage](#usage)
- [API](#api)
  - - [Setup](#setup)
    - [Get](#get)
    - [Put](#put)
    - [Unsubscribe](#unsubscribe)
- [Contribute](#contribute)
- [API Docs](#api-docs)
- [License](#license)
- [Contribute](#contribute-1)

## Install

```console
$ npm i datastore-pubsub
```

### Browser `<script>` tag

Loading this module through a script tag will make it's exports available as `DatastorePubsub` in the global namespace.

```html
<script src="https://unpkg.com/datastore-pubsub/dist/index.min.js"></script>
```

## Usage

```js
import { PubSubDatastore } from 'datastore-pubsub'

const dsPubsub = new PubSubDatastore(pubsub, datastore, peerId, validator)
```

## API

#### Setup

```js
new PubSubDatastore(pubsub, datastore, peerId, validator, subscriptionKeyFn)
```

Creates a DatastorePubsub instance.

Arguments:

- `pubsub` (Object): implementation of a pubsub (must have publish and subscribe functions), such as [libp2p/pubsub](https://github.com/libp2p/js-libp2p/blob/master/src/pubsub.js).
- `datastore` (Object): datastore compliant with [interface-datastore](https://github.com/ipfs/interface-datastore), such as [datastore-fs](https://github.com/ipfs/js-datastore-fs).
- `peerId` (`PeerId` [Instance](https://github.com/libp2p/js-peer-id)): peer identifier object.
- `validator` (Object): containing validate function and select function.
- `subscriptionKeyFn` (function): function to manipulate the key topic received according to the needs, as well as to block the message received to be published.

Note: `validator` object must be composed by two functions, `validate (record: uint8Array, peerId: PeerId) => boolean` and `select (received: uint8Array, current: uint8Array) => boolean`. `validate` aims to verify if a new record received by pubsub is valid to be stored locally by the node. If it is valid and the node already has a local record stored, `select` is the function provided to be responsible for deciding which record is the best (newer) between the already stored and the received through pubsub. A `validator` example can be found at: TODO (js-ipns)

```js
const dsPubsub = new DatastorePubsub(pubsub, datastore, peerId, validator)
```

#### Get

```js
const buf = await dsPubsub.get(key)
```

Try to subscribe a topic with Pubsub and receive the current local value if available.

Arguments:

- `key` (Uint8Array): a key representing a unique identifier of the object to subscribe.

Returns `Promise<Uint8Array>` containing the most recent known record stored.

#### Put

```js
await dsPubsub.put(key, val)
```

Publishes a value through pubsub.

Arguments:

- `key` (Uint8Array): a key representing a unique identifier of the object to publish.
- `val` (Uint8Array): value to be propagated.

Returns `Promise<void>`

#### Unsubscribe

```js
await dsPubsub.unsubscribe(key)
```

Unsubscribe a previously subscribe value.

Arguments:

- `key` (Uint8Array): a key representing a unique identifier of the object to publish.

Returns `Promise<void>`

## Contribute

Feel free to join in. All welcome. Open an [issue](https://github.com/ipfs/js-ipns/issues)!

This repository falls under the IPFS [Code of Conduct](https://github.com/ipfs/community/blob/master/code-of-conduct.md).

[![](https://cdn.rawgit.com/jbenet/contribute-ipfs-gif/master/img/contribute.gif)](https://github.com/ipfs/community/blob/master/CONTRIBUTING.md)

## API Docs

- <https://ipfs.github.io/js-datastore-pubsub>

## License

Licensed under either of

- Apache 2.0, ([LICENSE-APACHE](LICENSE-APACHE) / <http://www.apache.org/licenses/LICENSE-2.0>)
- MIT ([LICENSE-MIT](LICENSE-MIT) / <http://opensource.org/licenses/MIT>)

## Contribute

Contributions welcome! Please check out [the issues](https://github.com/ipfs/js-datastore-pubsub/issues).

Also see our [contributing document](https://github.com/ipfs/community/blob/master/CONTRIBUTING_JS.md) for more information on how we work, and about contributing in general.

Please be aware that all interactions related to this repo are subject to the IPFS [Code of Conduct](https://github.com/ipfs/community/blob/master/code-of-conduct.md).

Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion in the work by you, as defined in the Apache-2.0 license, shall be dual licensed as above, without any additional terms or conditions.

[![](https://cdn.rawgit.com/jbenet/contribute-ipfs-gif/master/img/contribute.gif)](https://github.com/ipfs/community/blob/master/CONTRIBUTING.md)
