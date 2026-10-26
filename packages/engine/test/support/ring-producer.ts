// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// A worker that writes `count` packets into a ring (test/ring.unit.ts): packet i has size(i)
// bytes (test/support/ring-packets.ts), byte j of it is (i + j) & 255, and its pts is i. Posts
// how many it wrote once it ends the ring or the consumer closes it.

import { createOutgoingPacket, createProducer } from "../../src/ring";
import { size } from "./ring-packets";

declare const self: Worker;

self.addEventListener(
  "message",
  ({ data }: MessageEvent<{ ring: SharedArrayBuffer; count: number }>) => {
    const producer = createProducer(data.ring);
    const src = new Uint8Array(3001 + 256);
    for (const [j] of src.entries()) src[j] = j & 255;
    const packet = createOutgoingPacket(src);
    packet.stream = 1;
    let written = 0;

    for (; written < data.count; written++) {
      const n = size(written);
      packet.flags = written & 1;
      packet.pts = BigInt(written);
      packet.dts = BigInt(-written);
      packet.duration = n;
      packet.offset = written & 255;
      packet.size = n;
      if (!producer.write(packet)) break;
    }

    if (written === data.count) producer.end();
    self.postMessage(written);
  },
);
