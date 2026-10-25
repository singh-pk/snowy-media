// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// A ring of packets in a SharedArrayBuffer, from one producer thread to one consumer thread,
// with no message per packet. It is a byte stream of records: a 32-byte header, then the
// payload, padded to 32 bytes. A record may wrap around the end of the ring, so a packet of
// any size up to the capacity fits without wasting the space at the end. The producer blocks
// (Atomics.wait) while the ring is full, except to fail, which takes no room; the consumer
// never blocks, and waits (Atomics.waitAsync) for the producer to notify it when it writes to
// an empty ring or fails. A consumer that watches is notified too when the producer's thread
// blocks, on this ring or on another one it writes.
//
// Positions only grow, as 32-bit integers that wrap; the distance between them is the bytes
// in use. Each side writes only its own position, so neither needs a lock.

// Control words, then the records from byte 64, on a cache line of their own.
const WRITE = 0;
const READ = 1;
// 1 while the producer waits for room.
const PRODUCER_WAITING = 2;
const CONSUMER_WAITING = 3;
const CLOSED = 4;
// 1 while the consumer watches for the producer's thread to block.
const WATCHING = 5;
// How many times the producer's thread has blocked while watched, a count to wait on.
const BLOCKS = 6;
// 1 once the producer has failed: the consumer reads FAILED after the records before it.
const FAILURE = 7;
const DATA = 64;
// A header, and the alignment of every record, so a header never wraps.
const HEADER = 32;

/**
 * The engine's ring size: room for seconds of the highest bitrates a browser plays, and for
 * any single packet (docs/architecture.md#packet-ring).
 */
export const RING_CAPACITY = 1 << 23;

/** The stream of the record that follows the last packet. */
export const END = -1;
/** The stream of the packet that ends the packets early, because the producer failed. */
export const FAILED = -2;
/**
 * FFmpeg's values the records carry, AV_PKT_FLAG_KEY and AV_NOPTS_VALUE, here so a consumer
 * need not load FFmpeg for them (test/ring.unit.ts checks them).
 */
export const KEY_FLAG = 1;
export const NO_TIMESTAMP = -(2n ** 63n);

/** A packet as the consumer sees it. `data` is valid until `release`. */
export interface Packet {
  /** The stream index, END or FAILED. */
  stream: number;
  /** AV_PKT_FLAG_* bits, KEY_FLAG among them. */
  flags: number;
  /** Timestamps in the stream's time base; NO_TIMESTAMP when unknown. */
  pts: bigint;
  dts: bigint;
  /** In the stream's time base, a 32-bit integer. */
  duration: number;
  data: Uint8Array;
}

const padded = (size: number) => HEADER + ((size + HEADER - 1) & -HEADER);

/** A ring of `capacity` bytes of records, a power of two of at least 64. */
export function createRing(capacity: number) {
  if (capacity < 2 * HEADER || (capacity & (capacity - 1)) !== 0) {
    throw new RangeError(`ring capacity ${capacity} is not a power of two of at least 64`);
  }

  return new SharedArrayBuffer(DATA + capacity);
}

function views(ring: SharedArrayBuffer) {
  const capacity = ring.byteLength - DATA;
  return {
    capacity,
    control: new Int32Array(ring, 0, DATA / 4),
    bytes: new Uint8Array(ring, DATA, capacity),
    words: new Int32Array(ring, DATA, capacity / 4),
    longs: new BigInt64Array(ring, DATA, capacity / 8),
  };
}

/** The producer's side of `ring`, for a thread that may block. */
export function createProducer(ring: SharedArrayBuffer) {
  const { capacity, control, bytes, words, longs } = views(ring);

  /**
   * Tells a watching consumer that this thread is about to block, on this ring or another,
   * after raising that ring's waiting flag. Taken, so a watch is told once.
   */
  function blocking() {
    const watching = Atomics.load(control, WATCHING) === 1;

    if (watching && Atomics.compareExchange(control, WATCHING, 1, 0) === 1) {
      Atomics.add(control, BLOCKS, 1);
      Atomics.notify(control, BLOCKS);
    }
  }

  // Waits until `need` bytes are free; false once the consumer has closed the ring.
  function reserve(need: number) {
    const written = control[WRITE] ?? 0;

    for (;;) {
      const read = Atomics.load(control, READ);
      if (Atomics.load(control, CLOSED)) return false;
      if (capacity - ((written - read) | 0) >= need) return true;
      // Raised before waiting, so a release after the check above notifies this wait or
      // changes READ before it starts.
      Atomics.store(control, PRODUCER_WAITING, 1);
      blocking();
      Atomics.wait(control, READ, read);
      Atomics.store(control, PRODUCER_WAITING, 0);
    }
  }

  // Whether `need` bytes are free.
  function fits(need: number) {
    return capacity - (((control[WRITE] ?? 0) - Atomics.load(control, READ)) | 0) >= need;
  }

  /**
   * Copies `size` bytes of `src` from `offset` into a record, waiting for room. False once the
   * consumer has closed the ring, so the producer stops.
   */
  function write(
    stream: number,
    flags: number,
    pts: bigint,
    dts: bigint,
    duration: number,
    src: Uint8Array,
    offset: number,
    size: number,
  ) {
    return put(stream, flags, pts, dts, duration, src, offset, size, true);
  }

  /**
   * Copies `size` bytes of `src` from `offset` into a record if the ring has room for it, for
   * a producer that waits on more than this ring. False if it has not, or once the consumer
   * has closed the ring (`closed`).
   */
  function offer(
    stream: number,
    flags: number,
    pts: bigint,
    dts: bigint,
    duration: number,
    src: Uint8Array,
    offset: number,
    size: number,
  ) {
    return put(stream, flags, pts, dts, duration, src, offset, size, false);
  }

  // Writes a record, waiting for room if `wait`, or else only if it fits.
  function put(
    stream: number,
    flags: number,
    pts: bigint,
    dts: bigint,
    duration: number,
    src: Uint8Array,
    offset: number,
    size: number,
    wait: boolean,
  ) {
    const need = padded(size);
    if (need > capacity) throw new RangeError(`a ${size}-byte packet exceeds the ring`);
    if ((duration | 0) !== duration) throw new RangeError(`packet duration ${duration}`);
    if (wait ? !reserve(need) : Atomics.load(control, CLOSED) || !fits(need)) return false;
    const written = control[WRITE] ?? 0;
    const at = written & (capacity - 1);
    words[at >> 2] = size;
    words[(at >> 2) + 1] = stream;
    words[(at >> 2) + 2] = flags;
    words[(at >> 2) + 3] = duration;
    longs[(at >> 3) + 2] = pts;
    longs[(at >> 3) + 3] = dts;
    // A header in the last 32 bytes has its payload at the start.
    const start = (at + HEADER) & (capacity - 1);
    const first = Math.min(size, capacity - start);
    bytes.set(src.subarray(offset, offset + first), start);
    if (first < size) bytes.set(src.subarray(offset + first, offset + size), 0);
    Atomics.store(control, WRITE, (written + need) | 0);
    wakeConsumer();
    return true;
  }

  // Taken, so a busy ring makes no notify calls.
  function wakeConsumer() {
    const waiting = Atomics.load(control, CONSUMER_WAITING) === 1;

    if (waiting && Atomics.compareExchange(control, CONSUMER_WAITING, 1, 0) === 1) {
      Atomics.notify(control, CONSUMER_WAITING);
    }
  }

  /**
   * Whether a record of `size` bytes fits with `spare` bytes left over, for a producer that
   * keeps room for records it must always be able to offer.
   */
  function hasRoom(size: number, spare: number) {
    return fits(padded(size) + spare);
  }

  /** Writes the END record after the last packet, waiting for room, as the tests' producer does. */
  function end() {
    return write(END, 0, 0n, 0n, 0, bytes, 0, 0);
  }

  /** Writes the END record if the ring has room for it, as `offer`. */
  function offerEnd() {
    return offer(END, 0, 0n, 0n, 0, bytes, 0, 0);
  }

  /**
   * Ends the packets with FAILED in place of the rest, at once: it takes no room, so a full
   * ring whose consumer reads no more never holds it back.
   */
  function fail() {
    Atomics.store(control, FAILURE, 1);
    wakeConsumer();
  }

  /** Whether the consumer has closed the ring. */
  function closed() {
    return Atomics.load(control, CLOSED) === 1;
  }

  /**
   * Raises or lowers the flag that has the consumer wake the producer as it frees room. Raised
   * before the producer reads where it waits from and checks the ring, so a release after the
   * check wakes it.
   */
  function waitingForRoom(on: boolean) {
    Atomics.store(control, PRODUCER_WAITING, on ? 1 : 0);
  }

  /**
   * A count to `sleep` on, for a producer that waits on this ring alone: the consumer's
   * position, which every release and a close move.
   */
  function bell() {
    return Atomics.load(control, READ);
  }

  /** Waits until the count moves from `seen`, at once if it already has. */
  function sleep(seen: number) {
    Atomics.wait(control, READ, seen);
  }

  return {
    write,
    offer,
    hasRoom,
    end,
    offerEnd,
    fail,
    blocking,
    closed,
    waitingForRoom,
    bell,
    sleep,
  };
}

/**
 * Stops the producer of `ring`, from any thread: its next write returns false. A wait of the
 * consumer goes on until its own thread closes it.
 */
export function closeRing(ring: SharedArrayBuffer) {
  const { control } = views(ring);
  Atomics.store(control, CLOSED, 1);
  // Moving READ wakes a producer that checked CLOSED just before; it is waiting for space,
  // so READ was not at WRITE.
  Atomics.store(control, READ, Atomics.load(control, WRITE));
  Atomics.notify(control, READ);
}

/**
 * The consumer's side of `ring`, for a thread that never blocks. `blocked` runs once for each
 * `watch` when the producer's thread then blocks, in a later task. `freed` runs as it frees room
 * while the producer waits, and as it closes the ring, for a producer that waits on more than
 * this ring (src/pcm.ts).
 */
export function createConsumer(
  ring: SharedArrayBuffer,
  blocked: () => void = () => {},
  freed: () => void = () => {},
) {
  const { capacity, control, bytes, words, longs } = views(ring);
  // The blocks heard.
  const blocks = { heard: Atomics.load(control, BLOCKS) };
  const packet: Packet = { stream: 0, flags: 0, pts: 0n, dts: 0n, duration: 0, data: bytes };
  // Where a record that wraps is put back together; it grows to the largest such packet.
  let joined = new Uint8Array(0);

  /**
   * The next packet, valid until `release`; undefined while the ring is empty or closed. Once
   * the producer has failed and every record is read, a FAILED packet, which `release` leaves.
   */
  function peek(): Packet | undefined {
    const read = control[READ] ?? 0;
    // Read before WRITE, so a failure seen comes after every record it sees.
    const failed = Atomics.load(control, FAILURE) === 1;
    if (Atomics.load(control, CLOSED)) return undefined;

    if (Atomics.load(control, WRITE) === read) {
      if (!failed) return undefined;
      packet.stream = FAILED;
      packet.data = bytes.subarray(0, 0);
      return packet;
    }

    const at = read & (capacity - 1);
    const size = words[at >> 2] ?? 0;
    packet.stream = words[(at >> 2) + 1] ?? 0;
    packet.flags = words[(at >> 2) + 2] ?? 0;
    packet.duration = words[(at >> 2) + 3] ?? 0;
    packet.pts = longs[(at >> 3) + 2] ?? 0n;
    packet.dts = longs[(at >> 3) + 3] ?? 0n;
    const start = (at + HEADER) & (capacity - 1);
    const first = capacity - start;

    if (size <= first) {
      packet.data = bytes.subarray(start, start + size);
    } else {
      if (joined.length < size) joined = new Uint8Array(Math.max(size, 2 * joined.length));
      joined.set(bytes.subarray(start), 0);
      joined.set(bytes.subarray(0, size - first), first);
      packet.data = joined.subarray(0, size);
    }

    return packet;
  }

  /** Frees the packet `peek` returned; nothing once the ring is closed, or for FAILED. */
  function release() {
    const read = control[READ] ?? 0;
    if (Atomics.load(control, CLOSED) || Atomics.load(control, WRITE) === read) return;
    const size = words[(read & (capacity - 1)) >> 2] ?? 0;
    Atomics.store(control, READ, (read + padded(size)) | 0);

    if (Atomics.load(control, PRODUCER_WAITING)) {
      Atomics.notify(control, READ);
      freed();
    }
  }

  /**
   * Resolves once the ring holds a packet or the producer fails, or at once when it is closed;
   * now and then on a late notify with the ring still empty, so a caller peeks again.
   */
  async function wait() {
    if (Atomics.load(control, CLOSED)) return;
    // Raised before the check, so a write after it either notifies this wait or changes WRITE
    // first. A producer that took the flag leaves it lowered, and the wait returns at once.
    Atomics.store(control, CONSUMER_WAITING, 1);

    const failed = Atomics.load(control, FAILURE) === 1;

    if (failed || Atomics.load(control, WRITE) !== (control[READ] ?? 0)) {
      Atomics.store(control, CONSUMER_WAITING, 0);
      return;
    }

    const { async, value } = Atomics.waitAsync(control, CONSUMER_WAITING, 1);
    if (async) await value;
  }

  /** Stops the producer, and ends a wait of this consumer's own: no write will. */
  function close() {
    closeRing(ring);
    freed();
    Atomics.store(control, CONSUMER_WAITING, 0);
    Atomics.notify(control, CONSUMER_WAITING);
    Atomics.notify(control, BLOCKS);
  }

  /** Whether the producer waits for room. */
  function producerWaiting() {
    return Atomics.load(control, PRODUCER_WAITING) === 1;
  }

  /** Whether either side has closed the ring. */
  function closed() {
    return Atomics.load(control, CLOSED) === 1;
  }

  /**
   * Has `blocked` run when the producer's thread next blocks. Before reading whether it
   * waits, so a block after the read runs it.
   */
  function watch() {
    Atomics.store(control, WATCHING, 1);
  }

  // Runs `blocked` as the count of blocks moves, until the ring closes. Started with the count
  // unmoved, so it first waits, and `blocked` always runs in a later task.
  async function listen() {
    while (!closed()) {
      const count = Atomics.load(control, BLOCKS);

      // Once for each block, as each took a watch.
      if (count !== blocks.heard) {
        for (; blocks.heard !== count; blocks.heard = (blocks.heard + 1) | 0) blocked();
        continue;
      }

      const { async, value } = Atomics.waitAsync(control, BLOCKS, count);
      if (async) await value;
    }
  }

  void listen();
  return { peek, release, wait, close, closed, producerWaiting, watch };
}
