# Media Reading Evaluation — 2026-11-25

20/20 snapshots pass (100%) — 10 podcasts, 10 technical videos.

## Aggregate Baseline Metrics

- **Chapter Recall**: 24/24 (100%), false positives: 0
- **Natural Paragraph Word-Unit Distribution**: min `18` · median `44` · max `96` units (target band: `15–175` units, `2 CJK chars = 1 unit`)
- **Time Anchor Accuracy (`< 0.5s` gate)**: max paragraph-start drift `0.00s`, max phrase-probe drift `0.00s`, character-offset mismatches `0`
- **Agent Cleanup Fidelity & Guardrails**: 3/3 passed (`±20%` word-unit guardrail, monotonic `[MM:SS]` check, and dual-anchor highlight survival)

## Per Snapshot

| snapshot | kind | lang | format | cues → paras | chapters | para units (min/p50/max) | max drift | cleanup | flags |
|---|---|---|---|---:|---:|---:|---:|---|---|
| ✅ 01-dwarkesh-scaling-vtt | podcast | en | vtt | 7 → 4 | 2/2 | 28/47/54 | 0.00s | – | - |
| ✅ 02-lex-compilers-srt | podcast | en | srt | 5 → 4 | 2/2 | 21/22/46 | 0.00s | – | - |
| ✅ 03-changelog-sqlite-p2json | podcast | en | podcast-json | 4 → 2 | 2/2 | 44/44/46 | 0.00s | – | - |
| ✅ 04-acquired-tsmc-longform-vtt | podcast | en | vtt | 7 → 2 | 0 (fp:0) | 63/63/83 | 0.00s | – | - |
| ✅ 05-xiaoyuzhou-rust-async-zh | podcast | zh | srt | 6 → 4 | 2/2 | 24/27/51 | 0.00s | – | - |
| ✅ 06-guigu101-ai-infra-bilingual | podcast | bilingual | vtt | 4 → 2 | 0 (fp:0) | 48/48/48 | 0.00s | – | - |
| ✅ 07-latent-space-agents-whisper | podcast | en | whisper-verbose-json | 5 → 2 | 0 (fp:0) | 47/47/64 | 0.00s | – | - |
| ✅ 08-indie-podcast-sensevoice-vad | podcast | zh | vad-plain-asr | 4 → 2 | 0 (fp:0) | 44/44/49 | 0.00s | pass | - |
| ✅ 09-oxide-bmc-unpunctuated-asr | podcast | en | vtt | 9 → 2 | 0 (fp:0) | 87/87/96 | 0.00s | – | - |
| ✅ 10-radiolab-overlapping-vtt | podcast | en | vtt | 3 → 2 | 0 (fp:0) | 25/25/45 | 0.00s | – | - |
| ✅ 11-karpathy-tokenizer-srv3 | video | en | youtube-srv3 | 4 → 2 (+2 fig) | 2/2 | 40/40/43 | 0.00s | – | - |
| ✅ 12-3blue1brown-attention-vtt | video | en | vtt | 4 → 2 (+2 fig) | 2/2 | 42/42/44 | 0.00s | pass | - |
| ✅ 13-goto-distributed-rolling-json3 | video | en | youtube-json3 | 5 → 1 | 0 (fp:0) | 51/51/51 | 0.00s | – | - |
| ✅ 14-stanford-cs229-unpunctuated-srv3 | video | en | youtube-srv3 | 7 → 2 (+1 fig) | 2/2 | 46/46/64 | 0.00s | – | - |
| ✅ 15-fireship-wasm-rapid-xml | video | en | youtube-xml | 6 → 1 | 0 (fp:0) | 60/60/60 | 0.00s | – | - |
| ✅ 16-veritasium-analog-computing-vtt | video | en | vtt | 6 → 3 | 2/2 | 29/34/42 | 0.00s | – | - |
| ✅ 17-mit-6824-raft-consensus-srt | video | en | srt | 5 → 4 | 2/2 | 18/24/37 | 0.00s | – | - |
| ✅ 18-yt-zh-llm-quantization-srv3 | video | zh | youtube-srv3 | 5 → 2 | 2/2 | 45/45/51 | 0.00s | – | - |
| ✅ 19-rustconf-tokio-scheduler-json3 | video | en | youtube-json3 | 4 → 2 (+2 fig) | 2/2 | 39/39/43 | 0.00s | – | - |
| ✅ 20-neurips-oral-speculative-decoding | video | bilingual | vtt | 4 → 2 | 2/2 | 44/44/47 | 0.00s | pass | - |
