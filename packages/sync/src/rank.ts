// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Ranking peers by hash (docs/architecture.md#gaps-and-repair): who to ask for missing chat,
// or for the session's state on join. Each asker ranks the same candidates the same way for the
// same question, while different questions spread over different peers, with nothing agreed in
// advance.

import type { KeyId } from "./crypto";

const encoder = new TextEncoder();

/**
 * The candidates, lowest `SHA-256(candidate ‖ part ‖ …)` first. `‖` joins with a newline, which
 * no key id holds, so no two inputs hash the same bytes.
 */
export async function rank(candidates: KeyId[], ...parts: Array<string | number>) {
  const scored = await Promise.all(
    candidates.map(async (candidate) => {
      const bytes = encoder.encode(parts.reduce<string>((text, p) => `${text}\n${p}`, candidate));
      const hash = await crypto.subtle.digest("SHA-256", bytes);
      return { candidate, score: new Uint8Array(hash).toHex() };
    }),
  );
  scored.sort((a, b) => (a.score < b.score ? -1 : 1));
  return scored.map((s) => s.candidate);
}
