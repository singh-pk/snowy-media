// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// A ring of packets in a SharedArrayBuffer, from one producer thread to one consumer thread, with
// no message per packet (docs/architecture.md#packet-ring). The producer blocks while the ring is
// full, except to fail, which takes no room; the consumer never blocks.

// Indexes of the control words. The records start at byte 64, so the control words have a cache
// line of their own.
const WRITE = 0;
const READ = 1;
const PRODUCER_WAITING = 2;
const CONSUMER_WAITING = 3;
const CLOSED = 4;
// 1 while the consumer watches for the producer's thread to block.
const WATCHING = 5;
// How many times the producer's thread has blocked while watched, a count to wait on.
const BLOCKS = 6;
// 1 once the producer has failed; the consumer gets FAILED only after every record before it.
const FAILURE = 7;
const DATA = 64;
// The bytes of a record's header, and the alignment of every record, so no header wraps around
// the end of the ring.
const HEADER = 32;
// Bits of a record's size word: PIECE marks a piece of a large packet, LAST its last piece. The
// size takes the low 29 bits, as a record holds at most half the ring, of at most 2^29 bytes.
const PIECE = 1 << 31;
const LAST = 1 << 30;
const SIZE = (1 << 29) - 1;

/**
 * The engine's ring size: room for seconds of the highest bitrates a browser plays
 * (docs/architecture.md#packet-ring).
 */
export const RING_CAPACITY = 1 << 23;

/** The stream of the record that follows the last packet. */
export const END = -1;
/** The stream of the packet a consumer gets in place of the rest once the producer has failed. */
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

/** Which part of its packet a record is: all of it, a piece, or its last piece. */
export const PART = { whole: 0, piece: 1, last: 2 } as const;

/**
 * Where a record's payload is in its ring, `size` bytes from `start`, which may wrap, and which
 * `PART` of its packet it is. A consumer that hands records to another thread unread
 * (`peekPlace`) passes this to that thread's `createPlaceReader`.
 */
export interface Place {
  start: number;
  size: number;
  part: number;
}

const padded = (size: number) => HEADER + ((size + HEADER - 1) & -HEADER);

/** A ring of `capacity` bytes of records, a power of two from 64 to 2^29. */
export function createRing(capacity: number) {
  if (capacity < 2 * HEADER || capacity > 1 << 29 || (capacity & (capacity - 1)) !== 0) {
    throw new RangeError(`ring capacity ${capacity} is not a power of two from 64 to 2^29`);
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

type Views = ReturnType<typeof views>;

/**
 * A packet as a producer writes it: `size` bytes of `data` from `offset`. A producer fills one
 * it keeps for every packet, so writing a packet allocates nothing.
 */
export interface OutgoingPacket {
  /** The stream index, or END. */
  stream: number;
  flags: number;
  pts: bigint;
  dts: bigint;
  /** A 32-bit integer. */
  duration: number;
  data: Uint8Array;
  offset: number;
  size: number;
}

export function createOutgoingPacket(data: Uint8Array = new Uint8Array(0)): OutgoingPacket {
  return { stream: 0, flags: 0, pts: 0n, dts: 0n, duration: 0, data, offset: 0, size: 0 };
}

// Where a record's payload comes from in its packet's data, and its size word's marks.
interface Piece {
  offset: number;
  size: number;
  mark: number;
}

/**
 * Tells a watching consumer that the producer's thread is about to block, on this ring or
 * another, after raising that ring's waiting flag. It clears WATCHING with a compare-exchange,
 * so each watch hears of one block only.
 */
function blocking(control: Int32Array) {
  const watching = Atomics.load(control, WATCHING) === 1;

  if (watching && Atomics.compareExchange(control, WATCHING, 1, 0) === 1) {
    Atomics.add(control, BLOCKS, 1);
    Atomics.notify(control, BLOCKS);
  }
}

// Waits until `need` bytes are free; false once the consumer has closed the ring.
function reserve({ capacity, control }: Views, need: number) {
  const written = control[WRITE] ?? 0;

  for (;;) {
    const read = Atomics.load(control, READ);
    if (Atomics.load(control, CLOSED)) return false;
    if (capacity - ((written - read) | 0) >= need) return true;
    // Raised before waiting, so a release after the check above notifies this wait or
    // changes READ before it starts.
    Atomics.store(control, PRODUCER_WAITING, 1);
    blocking(control);
    Atomics.wait(control, READ, read);
    Atomics.store(control, PRODUCER_WAITING, 0);
  }
}

// Whether `need` bytes are free and the ring is open. CLOSED is read after READ because a close
// moves READ up to WRITE, so the free bytes counted never include those a close freed, which a
// reader on another thread (`createPlaceReader`) may still be copying from.
function fits({ capacity, control }: Views, need: number) {
  const free = capacity - (((control[WRITE] ?? 0) - Atomics.load(control, READ)) | 0) >= need;
  return !Atomics.load(control, CLOSED) && free;
}

// Notifies only while the consumer's waiting flag is up, and clears it with a compare-exchange,
// so a busy ring makes no `notify` calls.
function wakeConsumer(control: Int32Array) {
  const waiting = Atomics.load(control, CONSUMER_WAITING) === 1;

  if (waiting && Atomics.compareExchange(control, CONSUMER_WAITING, 1, 0) === 1) {
    Atomics.notify(control, CONSUMER_WAITING);
  }
}

// Copies the header of `packet` and the payload `piece` says into a record at the producer's
// position, and publishes it. The caller has made room for it.
function store(v: Views, packet: OutgoingPacket, { offset, size, mark }: Piece) {
  const { capacity, control, bytes, words, longs } = v;
  const written = control[WRITE] ?? 0;
  const at = written & (capacity - 1);
  words[at >> 2] = size | mark;
  words[(at >> 2) + 1] = packet.stream;
  words[(at >> 2) + 2] = packet.flags;
  words[(at >> 2) + 3] = packet.duration;
  longs[(at >> 3) + 2] = packet.pts;
  longs[(at >> 3) + 3] = packet.dts;
  // A header in the last 32 bytes of the ring has its payload at the ring's start.
  const start = (at + HEADER) & (capacity - 1);
  const first = Math.min(size, capacity - start);
  const src = packet.data;
  bytes.set(src.subarray(offset, offset + first), start);
  if (first < size) bytes.set(src.subarray(offset + first, offset + size), 0);
  Atomics.store(control, WRITE, (written + padded(size)) | 0);
  wakeConsumer(control);
}

// The producer's side of `control` apart from writing: failing, and what a producer that waits
// on more than one ring waits with.
function producerSignals(control: Int32Array) {
  return {
    /** Tells a watching consumer that this thread is about to block, on this ring or another. */
    blocking: () => blocking(control),
    /**
     * Ends the packets with FAILED in place of the rest, at once: it takes no room, so a full
     * ring whose consumer reads no more never holds it back.
     */
    fail() {
      Atomics.store(control, FAILURE, 1);
      wakeConsumer(control);
    },
    closed: () => Atomics.load(control, CLOSED) === 1,
    /**
     * Raises or lowers the flag that has the consumer wake the producer as it frees room. Raise
     * it before reading the count to wait on and checking the ring, so a release after the
     * check wakes the producer.
     */
    waitingForRoom(on: boolean) {
      Atomics.store(control, PRODUCER_WAITING, on ? 1 : 0);
    },
    /**
     * A count to `sleep` on, for a producer that waits on this ring alone: the consumer's
     * position, which every release and a close move.
     */
    bell: () => Atomics.load(control, READ),
    /** Waits until the count moves from `seen`, at once if it already has. */
    sleep(seen: number) {
      Atomics.wait(control, READ, seen);
    },
  };
}

/** The producer's side of `ring`, for a thread that may block. */
export function createProducer(ring: SharedArrayBuffer) {
  const v = views(ring);
  const { capacity, control, bytes } = v;
  // The packet in pieces, by its stream, timestamp and size, and its bytes written so far,
  // while its other pieces wait for room. One packet at a time is in pieces.
  const split = { sent: 0, stream: 0, pts: 0n, size: 0 };
  // Whether `put` waits for room (`write`) or gives up when there is none (`offer`).
  const mode = { wait: true };
  const piece: Piece = { offset: 0, size: 0, mark: 0 };
  const ending = createOutgoingPacket(bytes);
  ending.stream = END;

  /**
   * Copies `packet` into a record, waiting for room. False once the consumer has closed the
   * ring, so the producer stops.
   */
  function write(packet: OutgoingPacket) {
    mode.wait = true;
    return put(packet);
  }

  /**
   * Copies `packet` into a record if the ring has room for it, for a producer that waits on
   * more than this ring. False if it has not, or once the consumer has closed the ring
   * (`closed`).
   */
  function offer(packet: OutgoingPacket) {
    mode.wait = false;
    return put(packet);
  }

  // Writes a packet as `mode` says. One over half the ring goes as pieces, and `split.sent` counts
  // the bytes of those written, so a caller that found no room offers the same packet again for
  // the rest.
  function put(packet: OutgoingPacket) {
    const { stream, pts, duration, offset, size } = packet;
    if ((duration | 0) !== duration) throw new RangeError(`packet duration ${duration}`);
    if (padded(size) <= capacity / 2) return record(packet, offset, size, 0);

    if (split.sent > 0 && (stream !== split.stream || pts !== split.pts || size !== split.size)) {
      throw new RangeError(`packet of stream ${stream} offered while another is in pieces`);
    }

    split.stream = stream;
    split.pts = pts;
    split.size = size;

    while (split.sent < size) {
      const n = Math.min(capacity / 4, size - split.sent);
      const mark = PIECE | (split.sent + n === size ? LAST : 0);

      if (!record(packet, offset + split.sent, n, mark)) {
        if (Atomics.load(control, CLOSED)) split.sent = 0;
        return false;
      }

      split.sent += n;
    }

    split.sent = 0;
    return true;
  }

  function record(packet: OutgoingPacket, offset: number, size: number, mark: number) {
    const need = padded(size);
    const room = mode.wait ? reserve(v, need) : fits(v, need);
    if (!room) return false;
    piece.offset = offset;
    piece.size = size;
    piece.mark = mark;
    store(v, packet, piece);
    return true;
  }

  return Object.assign(producerSignals(control), {
    /** A packet to fill and hand to `write` or `offer`, for a caller that keeps none of its own. */
    packet: createOutgoingPacket(),
    write,
    offer,
    /** Writes the END record after the last packet, waiting for room, as the tests and bench do. */
    end: () => write(ending),
    /** Writes the END record if the ring has room for it, as `offer`. */
    offerEnd: () => offer(ending),
  });
}

/**
 * Stops the producer of `ring`, from any thread: its next write returns false. A wait of the
 * consumer goes on until its own thread closes it.
 */
export function closeRing(ring: SharedArrayBuffer) {
  const { control } = views(ring);
  Atomics.store(control, CLOSED, 1);
  // Moving READ wakes a producer that checked CLOSED just before it was set. That producer waits
  // for room, so READ was not at WRITE and the store changes it.
  Atomics.store(control, READ, Atomics.load(control, WRITE));
  Atomics.notify(control, READ);
}

// Where the consumer's handlers go: `blocked` for each watch the producer's thread answers by
// blocking, `freed` as it frees room the producer waits for and as it closes the ring.
interface ConsumerEvents {
  blocked: () => void;
  freed: () => void;
}

// The consumer's side of `ring` apart from reading: waiting, closing, and watching the
// producer's thread.
function consumerSignals(ring: SharedArrayBuffer, control: Int32Array, events: ConsumerEvents) {
  const { blocked, freed } = events;
  const blocks = { heard: Atomics.load(control, BLOCKS) };

  /**
   * Resolves once the ring holds a packet or the producer fails, or at once when it is closed.
   * A late notify may also resolve it with the ring still empty, so a caller peeks again.
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

  /** Whether either side has closed the ring. */
  const closed = () => Atomics.load(control, CLOSED) === 1;

  // Runs `blocked` as the count of blocks moves, until the ring closes. Started with the count
  // unmoved, so it first waits, and `blocked` always runs in a later task.
  async function listen() {
    while (!closed()) {
      const count = Atomics.load(control, BLOCKS);

      // `blocked` runs once for each block counted, as each block took one watch.
      if (count !== blocks.heard) {
        for (; blocks.heard !== count; blocks.heard = (blocks.heard + 1) | 0) blocked();
        continue;
      }

      const { async, value } = Atomics.waitAsync(control, BLOCKS, count);
      if (async) await value;
    }
  }

  void listen();
  return {
    wait,
    close,
    closed,
    producerWaiting: () => Atomics.load(control, PRODUCER_WAITING) === 1,
    /**
     * Has `blocked` run when the producer's thread next blocks. Call it before reading
     * `producerWaiting`, so a block that comes after that read still runs `blocked`.
     */
    watch() {
      Atomics.store(control, WATCHING, 1);
    },
  };
}

// What copies `size` bytes from `start` in the ring of `v`, which may wrap, into `into` at `at`.
function copier({ capacity, bytes }: Views) {
  return (start: number, size: number, into: Uint8Array, at: number) => {
    const first = Math.min(size, capacity - start);
    into.set(bytes.subarray(start, start + first), at);
    if (first < size) into.set(bytes.subarray(0, size - first), at + first);
  };
}

// A packet's pieces put back together, `length` bytes of `data` so far.
interface Pieces {
  data: Uint8Array;
  length: number;
}

// Adds the `size` bytes from `start` that `copy` copies to `pieces`, its buffer grown to the
// largest packet so far.
function addPiece(pieces: Pieces, copy: ReturnType<typeof copier>, start: number, size: number) {
  const length = pieces.length + size;

  if (pieces.data.length < length) {
    const grown = new Uint8Array(Math.max(length, 2 * pieces.data.length));
    // copy: the pieces so far, into a buffer that holds the next.
    grown.set(pieces.data.subarray(0, pieces.length));
    pieces.data = grown;
  }

  copy(start, size, pieces.data, pieces.length);
  pieces.length = length;
}

/**
 * Copies payloads out of `ring` where a consumer that hands records on unread found them
 * (`peekPlace`), on any thread; the consumer frees a record only once this has copied it. `read`
 * copies one into `into` at `at`, and `join` adds a piece to `pieces`, which its user empties.
 */
export function createPlaceReader(ring: SharedArrayBuffer) {
  const copy = copier(views(ring));
  const pieces: Pieces = { data: new Uint8Array(0), length: 0 };
  return {
    pieces,
    read: ({ start, size }: Place, into: Uint8Array, at: number) => copy(start, size, into, at),
    join: ({ start, size }: Place) => addPiece(pieces, copy, start, size),
  };
}

// Puts back together what a consumer cannot read in place in the ring: a record that wraps, and
// a packet in pieces.
function createJoiner(v: Views) {
  const { capacity, bytes } = v;
  const copy = copier(v);
  // Where a record that wraps is put back together; it grows to the largest such packet.
  const joined = { data: new Uint8Array(0) };
  // Where a packet's pieces are put back together, apart from `joined`, as other records may
  // come between them; `done` once its last piece is in, until it is released.
  const pieces = { data: new Uint8Array(0), length: 0, done: false };

  // The `size` bytes of a whole record from `start`, put back together in `joined` if they wrap.
  function whole(start: number, size: number) {
    if (size <= capacity - start) return bytes.subarray(start, start + size);

    if (joined.data.length < size) {
      joined.data = new Uint8Array(Math.max(size, 2 * joined.data.length));
    }

    copy(start, size, joined.data, 0);
    return joined.data.subarray(0, size);
  }

  // Adds the piece of `size` bytes from `start`, its size word `word`, to `pieces`, unless the
  // last piece is in already and the packet not yet released, as on a second `peek`.
  function join(start: number, size: number, word: number) {
    if (pieces.done) return;
    addPiece(pieces, copy, start, size);
    pieces.done = (word & LAST) !== 0;
  }

  return { pieces, whole, join };
}

function partOf(word: number) {
  if (!(word & PIECE)) return PART.whole;
  return word & LAST ? PART.last : PART.piece;
}

/**
 * Reads the records of the ring of `v` into `packet`, a header at a time, for its consumer: where
 * the next is, what a peek with none next returns, and the next unread.
 */
function createHeads(v: Views, packet: Packet) {
  const { capacity, control, bytes, words, longs } = v;
  const empty = bytes.subarray(0, 0);
  // Whether the producer had failed when `next` found no record.
  const ended = { failed: false };

  function header(at: number) {
    packet.stream = words[(at >> 2) + 1] ?? 0;
    packet.flags = words[(at >> 2) + 2] ?? 0;
    packet.duration = words[(at >> 2) + 3] ?? 0;
    packet.pts = longs[(at >> 3) + 2] ?? 0n;
    packet.dts = longs[(at >> 3) + 3] ?? 0n;
  }

  // Where the next record is, its header read into `packet`; undefined while there is none: the
  // ring empty or closed, or the producer failed with every record read, which `ended` notes.
  function next() {
    const read = control[READ] ?? 0;
    // FAILURE is read before WRITE, so once it is set, WRITE counts every record before it.
    const failed = Atomics.load(control, FAILURE) === 1;
    ended.failed = false;
    if (Atomics.load(control, CLOSED)) return undefined;

    if (Atomics.load(control, WRITE) === read) {
      ended.failed = failed;
      return undefined;
    }

    header(read & (capacity - 1));
    return read;
  }

  // What a peek with no record next returns: FAILED once the producer has failed, or undefined.
  function none() {
    if (!ended.failed) return undefined;
    packet.stream = FAILED;
    packet.data = empty;
    return packet;
  }

  /**
   * The next record as `peek` would, but unread, for a consumer that hands it to another thread
   * to copy out of the ring (`createPlaceReader`): its packet's header, with no data, and where its
   * payload is, in `place`. A packet in pieces comes a piece at a time, each one to release.
   */
  function peekPlace(place: Place): Packet | undefined {
    const read = next();
    if (read === undefined) return none();
    const at = read & (capacity - 1);
    const word = words[at >> 2] ?? 0;
    place.start = (at + HEADER) & (capacity - 1);
    place.size = word & SIZE;
    place.part = partOf(word);
    packet.data = empty;
    return packet;
  }

  return { next, none, peekPlace };
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
  const v = views(ring);
  const { capacity, control, bytes, words } = v;
  const packet: Packet = { stream: 0, flags: 0, pts: 0n, dts: 0n, duration: 0, data: bytes };
  const { pieces, whole, join } = createJoiner(v);
  const { next, none, peekPlace } = createHeads(v, packet);

  // Frees the record of `size` bytes at `read`.
  function advance(read: number, size: number) {
    Atomics.store(control, READ, (read + padded(size)) | 0);

    if (Atomics.load(control, PRODUCER_WAITING)) {
      Atomics.notify(control, READ);
      freed();
    }
  }

  /**
   * The next packet, valid until `release`; undefined while the ring is empty or closed. Once
   * the producer has failed and every record is read, a FAILED packet, which `release` leaves.
   */
  function peek(): Packet | undefined {
    for (;;) {
      const read = next();
      if (read === undefined) return none();
      const at = read & (capacity - 1);
      const word = words[at >> 2] ?? 0;
      const size = word & SIZE;
      const start = (at + HEADER) & (capacity - 1);

      if (!(word & PIECE)) {
        packet.data = whole(start, size);
        return packet;
      }

      join(start, size, word);

      if (pieces.done) {
        packet.data = pieces.data.subarray(0, pieces.length);
        return packet;
      }

      // A piece before the last is copied into `pieces` already, so it is freed at once to make
      // room for the next.
      advance(read, size);
    }
  }

  /**
   * Frees the record `peek` or `peekPlace` returned; nothing once the ring is closed, or for
   * FAILED.
   */
  function release() {
    const read = control[READ] ?? 0;
    if (Atomics.load(control, CLOSED) || Atomics.load(control, WRITE) === read) return;
    const word = words[(read & (capacity - 1)) >> 2] ?? 0;

    if (word & LAST) {
      pieces.length = 0;
      pieces.done = false;
    }

    advance(read, word & SIZE);
  }

  return Object.assign(consumerSignals(ring, control, { blocked, freed }), {
    peek,
    peekPlace,
    release,
  });
}
