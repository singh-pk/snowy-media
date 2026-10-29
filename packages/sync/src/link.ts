// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// A link to one peer (docs/architecture.md#package-boundaries), over the relay's inbox tracks or a
// direct connection's data channels, so what uses it never refers to MoQ or WebRTC.

import type { ChatControl } from "./chat-requests";
import type { ChunkControl } from "./chunk-requests";
import type { Bytes, KeyId } from "./crypto";
import type { HaveControl } from "./have";
import type { StateControl } from "./state-requests";

export type Message = ChatControl | StateControl | HaveControl | ChunkControl;

/** What a link reports. A handler may return a promise; the link doesn't wait for it. */
export type LinkEvents = {
  /** A control message from the peer, parsed but unchecked: the handler checks every field. */
  message(value: unknown): unknown;
  /** An object the peer sent this one on request. */
  object(key: string, bytes: Bytes): unknown;
  /** The link closed, from either end. Nothing more arrives on it, and nothing sent on it goes. */
  close(): unknown;
};

export type Link = {
  peer: KeyId;
  /** Sends a control message, as JSON: on `inbox/<peer>/<self>/ctl`, or the `ctl` channel. */
  send(message: Message): void;
  /** Sends an object the peer asked for: on `inbox/<peer>/<self>/deliver`, or the channels. */
  deliver(key: string, bytes: Bytes): void;
  on<E extends keyof LinkEvents>(event: E, handler: LinkEvents[E]): void;
  close(): void;
};
