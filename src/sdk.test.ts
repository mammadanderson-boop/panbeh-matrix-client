// Guards for matrix-js-sdk internals Panbeh relies on: they aren't public API, so an upgrade could drop them silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RustCrypto } from "matrix-js-sdk/lib/rust-crypto/rust-crypto.js";

test("scheduleMessage: the crypto backend (client.getCrypto()) can still encrypt an event", () => {
  assert.equal(typeof RustCrypto.prototype.encryptEvent, "function");
});
