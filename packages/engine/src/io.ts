// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Serves the FFmpeg core module's reads from a `File` synchronously with `FileReaderSync`, so
// FFmpeg reads a file as it reads a disk (docs/architecture.md#threads). It runs only in a worker,
// as `FileReaderSync` blocks.

import {
  AVERROR_EINVAL,
  AVERROR_EIO,
  AVSEEK_SIZE,
  type CoreModule,
} from "@snowy-media/ffmpeg/core";

/**
 * Installs `core`'s read and seek hooks for one input at a time, so they ignore the input id.
 * Call `open(file)` before each `sny_open`.
 */
export function createFileSource(core: CoreModule) {
  const reader = new FileReaderSync();
  let file = new File([], "");
  let pos = 0;

  core.snyRead = (_io, buf, size) => {
    const end = Math.min(file.size, pos + size);
    if (end <= pos) return 0;

    // A file changed or removed since it was picked fails to read. An exception would unwind
    // through FFmpeg and skip its cleanup, so FFmpeg gets an error instead.
    try {
      // copy: FileReaderSync reads only into a new buffer, so each read is copied into FFmpeg's
      // once. The Blob slice itself copies nothing.
      core.HEAPU8.set(new Uint8Array(reader.readAsArrayBuffer(file.slice(pos, end))), buf);
    } catch {
      return AVERROR_EIO;
    }

    const read = end - pos;
    pos = end;
    return read;
  };

  // `whence` is `SEEK_SET` (0), `SEEK_CUR` (1), `SEEK_END` (2) or `AVSEEK_SIZE`; FFmpeg masks
  // off `AVSEEK_FORCE` before calling.
  core.snySeek = (_io, offset, whence) => {
    if (whence === AVSEEK_SIZE) return BigInt(file.size);
    const next = Number(offset) + (whence === 1 ? pos : whence === 2 ? file.size : 0);
    if (next < 0 || next > file.size) return BigInt(AVERROR_EINVAL);
    pos = next;
    return BigInt(next);
  };

  return {
    open(next: File) {
      file = next;
      pos = 0;
    },
  };
}
