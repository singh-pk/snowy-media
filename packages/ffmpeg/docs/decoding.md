# Decoding

How to decode the packets that the [README](../README.md#usage)'s example demuxes: audio to 32-bit float planar, as Web Audio plays it, and video to WebCodecs `VideoFrame`s.

## Decoding audio

Audio decodes to 32-bit float planar, the format Web Audio uses. Open a decoder for a stream, send it that stream's packets, and take the frames:

```js
const out = core._malloc(4);
const opened = core._sny_decoder_open(ctx, stream, out);
const dec = core.HEAP32[out >> 2];
core._free(out);
if (opened < 0) throw new Error(core.UTF8ToString(core._sny_strerror(opened)));
const swr = core._sny_converter_alloc();
const frame = core._sny_frame_alloc();
const fltp = core._sny_frame_alloc();

// For each packet of the stream, and once more with 0 at the end to drain:
core._sny_decoder_send(dec, pkt);
while (core._sny_decoder_receive(dec, frame) >= 0) {
  if (core._sny_to_float_planar(swr, frame, fltp) < 0) break;
  const n = core._sny_frame_samples(fltp);
  for (let c = 0; c < core._sny_frame_channels(fltp); c++) {
    const plane = core._sny_frame_plane(fltp, c) >> 2;
    const samples = core.HEAPF32.subarray(plane, plane + n); // copy out before the next frame
  }
}

// When done:
core._sny_frame_free(fltp);
core._sny_frame_free(frame);
core._sny_converter_free(swr);
core._sny_decoder_close(dec);
```

`_sny_decoder_open` returns `AVERROR_DECODER_NOT_FOUND` for a long-tail codec (ATRAC, RealAudio, speech codecs and the like): decode it with `audio-ext` instead. [`test/support/decoder.js`](../test/support/decoder.js) is the complete loop, including the case where the decoder is full and handing a stream to another module. Integer decoders produce exactly what native FFmpeg does; float decoders match within 10⁻⁶.

## Decoding video

Video decoders live in `video` and `video-ext`; `core._sny_codec_module(ctx, stream)` names the one a stream needs, so a page loads only that. Copy the stream's codec parameters across with `_sny_params_export` and open the decoder with `_sny_decoder_open_params(buf, size, threads, out)` on up to one thread per core, at most 8: the module's thread pool, shared by every decoder open in it; then copy each packet across with `_sny_packet_make`, and run the same send/receive loop as for audio. [`test/support/decoder.js`](../test/support/decoder.js) does all of it.

Each decoded frame becomes a WebCodecs `VideoFrame` with one copy out of the WASM heap. The decoder's threads grow the heap as they allocate frames, and `HEAPU8` and the other views follow growth only when the module's own JavaScript next runs on their thread, so code that touches memory a decoder may have allocated, such as a packet's data or a packed frame, views `wasmMemory.buffer` instead:

```js
import { createVideo } from "@snowy-media/ffmpeg/video";

const video = await createVideo();
const sws = video._sny_scaler_alloc();
const out = video._sny_frame_alloc();

// For each frame the decoder returns:
if (video._sny_to_video_format(sws, frame, out) < 0) throw new Error("convert");
const size = video._sny_frame_pack_size(out);
const dst = video._malloc(size);
video._sny_frame_pack(out, dst, size);
// Memory a decoder's thread allocated may lie past video.HEAPU8: view wasmMemory instead.
const picture = new VideoFrame(new Uint8Array(video.wasmMemory.buffer, dst, size), {
  format: video.UTF8ToString(video._sny_frame_video_format(out)), // "I420", "NV12", "RGBA", …
  codedWidth: video._sny_frame_width(out),
  codedHeight: video._sny_frame_height(out),
  timestamp: Number(video._sny_rescale(video._sny_frame_pts(out), tbNum, tbDen, 1, 1_000_000)),
});
video._free(dst);
```

`_sny_to_video_format` passes a frame through untouched when it is in a `VideoFrame` format (4:2:0, 4:2:2 or 4:4:4 at 8, 10 or 12 bits, with alpha up to 10 bits, NV12, or 8-bit RGB with alpha or padding), at any size, and otherwise converts it with libswscale (RGB24, gray and RGB deeper than 8 bits to RGBX, …). The decoder's own frame stays available, planes and all, through `_sny_frame_data` and `_sny_frame_linesize`, for a WebGL or WebGPU renderer that wants what conversion drops, such as RGB deeper than 8 bits. Every decoder produces exactly what native FFmpeg does.
