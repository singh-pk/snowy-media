// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// A storyline's layout (docs/architecture.md#layout): items ordered by (position, id), in an AVL
// tree whose nodes hold their subtree's total duration, so an edit, an item's start or the item at
// a time is O(log n). Its shape depends on the order items arrived in, but no result does.

import type { ItemId } from "./ids";
import type { PositionKey } from "./position";

type Node = {
  id: ItemId;
  position: PositionKey;
  duration: number;
  left: Node | undefined;
  right: Node | undefined;
  height: number;
  total: number;
};

/** An item's place in a storyline: where it starts, in flicks, and how long it lasts. */
export type Placed = { id: ItemId; start: number; duration: number };

// Order by position key, then id, both by UTF-16 code unit (never by locale).
function compare(position: PositionKey, id: ItemId, node: Node) {
  if (position !== node.position) return position < node.position ? -1 : 1;
  if (id !== node.id) return id < node.id ? -1 : 1;
  return 0;
}

const height = (node: Node | undefined) => node?.height ?? 0;
const total = (node: Node | undefined) => node?.total ?? 0;

function update(node: Node) {
  node.height = Math.max(height(node.left), height(node.right)) + 1;
  node.total = total(node.left) + node.duration + total(node.right);
  return node;
}

function rotateRight(node: Node, left: Node) {
  node.left = left.right;
  left.right = update(node);
  return update(left);
}

function rotateLeft(node: Node, right: Node) {
  node.right = right.left;
  right.left = update(node);
  return update(right);
}

// Rotates `node` back into balance after one of its subtrees grew or shrank by one level.
function balance(node: Node) {
  update(node);
  const { left, right } = node;

  if (left !== undefined && height(left) - height(right) > 1) {
    const inner = left.right;
    const pivot =
      inner !== undefined && height(left.left) < height(inner) ? rotateLeft(left, inner) : left;
    return rotateRight(node, pivot);
  }

  if (right !== undefined && height(right) - height(left) > 1) {
    const inner = right.left;
    const pivot =
      inner !== undefined && height(right.right) < height(inner)
        ? rotateRight(right, inner)
        : right;
    return rotateLeft(node, pivot);
  }

  return node;
}

function insertNode(root: Node | undefined, node: Node): Node {
  if (root === undefined) return update(node);
  if (compare(node.position, node.id, root) < 0) root.left = insertNode(root.left, node);
  else root.right = insertNode(root.right, node);
  return balance(root);
}

// The subtree without its first node, and that node.
function removeFirst(root: Node): [Node | undefined, Node] {
  if (root.left === undefined) return [root.right, root];
  const [left, first] = removeFirst(root.left);
  root.left = left;
  return [balance(root), first];
}

function removeNode(root: Node | undefined, position: PositionKey, id: ItemId): Node | undefined {
  if (root === undefined) return undefined;
  const order = compare(position, id, root);

  if (order < 0) root.left = removeNode(root.left, position, id);
  else if (order > 0) root.right = removeNode(root.right, position, id);
  else {
    if (root.right === undefined) return root.left;
    const [right, next] = removeFirst(root.right);
    next.left = root.left;
    next.right = right;
    return balance(next);
  }

  return balance(root);
}

function checkDuration(duration: number) {
  if (!Number.isSafeInteger(duration) || duration < 0) {
    throw new RangeError(`not a duration: ${duration}`);
  }
}

// A storyline's length must stay exact, as every time does (src/time.ts).
function checkLength(length: number) {
  if (!Number.isSafeInteger(length)) {
    throw new RangeError(`a storyline of ${length} flicks is past what a number holds exactly`);
  }
}

// Where the node of `id` at `position` starts, in flicks from the sequence's start.
function startIn(root: Node | undefined, position: PositionKey, id: ItemId) {
  let before = 0;
  let cursor = root;

  while (cursor !== undefined) {
    const order = compare(position, id, cursor);
    if (order === 0) return before + total(cursor.left);

    if (order > 0) {
      before += total(cursor.left) + cursor.duration;
      cursor = cursor.right;
    } else cursor = cursor.left;
  }

  throw new RangeError(`not in the storyline: ${id}`);
}

function nextIn(root: Node | undefined, position: PositionKey, id: ItemId) {
  let found: ItemId | undefined;
  let cursor = root;

  while (cursor !== undefined) {
    if (compare(position, id, cursor) < 0) {
      found = cursor.id;
      cursor = cursor.left;
    } else cursor = cursor.right;
  }

  return found;
}

function previousIn(root: Node | undefined, position: PositionKey, id: ItemId) {
  let found: ItemId | undefined;
  let cursor = root;

  while (cursor !== undefined) {
    if (compare(position, id, cursor) > 0) {
      found = cursor.id;
      cursor = cursor.right;
    } else cursor = cursor.left;
  }

  return found;
}

function keyAfterIn(root: Node | undefined, position: PositionKey) {
  let found: PositionKey | undefined;
  let cursor = root;

  while (cursor !== undefined) {
    if (cursor.position > position) {
      found = cursor.position;
      cursor = cursor.left;
    } else cursor = cursor.right;
  }

  return found;
}

function atIn(root: Node | undefined, t: number): Placed | undefined {
  let before = 0;
  let cursor = root;

  while (cursor !== undefined) {
    const left = total(cursor.left);

    if (t < before + left) cursor = cursor.left;
    else if (t < before + left + cursor.duration) {
      return { id: cursor.id, start: before + left, duration: cursor.duration };
    } else {
      before += left + cursor.duration;
      cursor = cursor.right;
    }
  }

  return undefined;
}

function* itemsIn(root: Node | undefined): Generator<Placed> {
  const stack: Node[] = [];
  let cursor = root;
  let before = 0;

  while (cursor !== undefined || stack.length > 0) {
    while (cursor !== undefined) {
      stack.push(cursor);
      cursor = cursor.left;
    }

    const visited = stack.pop();
    if (visited === undefined) return;
    yield { id: visited.id, start: before, duration: visited.duration };
    before += visited.duration;
    cursor = visited.right;
  }
}

/** An empty storyline. Items are identified by id; each id is in it at most once. */
export function createStoryline() {
  let root: Node | undefined;
  const nodes = new Map<ItemId, Node>();

  function node(id: ItemId) {
    const found = nodes.get(id);
    if (found === undefined) throw new RangeError(`not in the storyline: ${id}`);
    return found;
  }

  /** Adds an item at `position`, lasting `duration` flicks. */
  function insert(id: ItemId, position: PositionKey, duration: number) {
    if (nodes.has(id)) throw new RangeError(`already in the storyline: ${id}`);
    checkDuration(duration);
    checkLength(total(root) + duration);
    const added: Node = {
      id,
      position,
      duration,
      left: undefined,
      right: undefined,
      height: 1,
      total: duration,
    };
    nodes.set(id, added);
    root = insertNode(root, added);
  }

  /** Removes an item; what followed it closes up. */
  function remove(id: ItemId) {
    const { position } = node(id);
    root = removeNode(root, position, id);
    nodes.delete(id);
  }

  /** Moves an item to `position`; what it leaves closes up, and what follows where it lands moves along. */
  function move(id: ItemId, position: PositionKey) {
    const { duration } = node(id);
    remove(id);
    insert(id, position, duration);
  }

  /** Changes an item's length; everything after it moves by the difference. */
  function setDuration(id: ItemId, duration: number) {
    checkDuration(duration);
    const { position, duration: before } = node(id);
    checkLength(total(root) - before + duration);
    remove(id);
    insert(id, position, duration);
  }

  return {
    insert,
    remove,
    move,
    setDuration,
    /** Where an item starts, in flicks from the sequence's start. */
    start: (id: ItemId) => startIn(root, node(id).position, id),
    /** The item playing at `t` flicks: the one with `start <= t < start + duration`. */
    at: (t: number) => atIn(root, t),
    /** The smallest position key in the storyline after `position`, if there is one. */
    keyAfter: (position: PositionKey) => keyAfterIn(root, position),
    /** The item after `id` in order, if there is one. */
    next: (id: ItemId) => nextIn(root, node(id).position, id),
    /** The item before `id` in order, if there is one. */
    previous: (id: ItemId) => previousIn(root, node(id).position, id),
    /** Every item in order, with its start. */
    *items() {
      yield* itemsIn(root);
    },
    has: (id: ItemId) => nodes.has(id),
    /** The storyline's length: the sum of every item's duration. */
    duration: () => total(root),
    /** The tree's height, which stays below 1.45 log2(n + 2): for tests. */
    height: () => height(root),
    get size() {
      return nodes.size;
    },
  };
}
