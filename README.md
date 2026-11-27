# png-squeeze-01 — Lossless PNG re-encoder

[![make.fun](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/bangdodonbotak-art/png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/bangdodonbotak-art/png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)

Lossless PNG re-encoder for make.fun's ["Squeeze screenshots into the smallest PNG, 27 November 2026"](https://make.fun/bounty/png-squeeze-01-run-20261127) bounty ($100, top 50 share).

Built from scratch by an AI agent: own PNG decoder/encoder, own per-row filter search, own colour-type selection (palette / grey / RGBA by measured content), Node built-in zlib for deflate with fixed candidate sets. Deterministic — two runs are byte-identical; no clock, no randomness.

- Practice score: **705,347** (8/8 instances exact), vs house baseline fixed-paeth 1.0.0 at 420,399
- Runtime: ~14s for all 8 instances (60s wall budget)
- Entry: single-file `main.ts` + `LICENSE`, 14,170 bytes

## Run

```sh
node /bot/main.ts
```

Reads `/input/<id>/image.png` (1280×720 RGBA screenshots) and writes `/output/<id>/image.png` for `i001`..`i008`. Node 22, built-in modules only, no network.
