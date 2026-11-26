import type { MediaFixture } from "./types";

function timedVideoCues(
  items: readonly { gapBefore?: number; speaker?: string; text: string }[],
  startAtSec = 0,
  charsPerSec = 15,
): { endSec: number; speaker?: string; startSec: number; text: string }[] {
  let cursor = startAtSec;
  return items.map((item) => {
    cursor += item.gapBefore ?? 0.2;
    const startSec = Number(cursor.toFixed(2));
    const dur = Math.max(1.2, Number((item.text.length / charsPerSec).toFixed(2)));
    const endSec = Number((startSec + dur).toFixed(2));
    cursor = endSec;
    return {
      startSec,
      endSec,
      text: item.text,
      ...(item.speaker ? { speaker: item.speaker } : {}),
    };
  });
}

function toClock(sec: number): string {
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  const whole = Math.floor(sec);
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

// 11. Karpathy-style YouTube srv3 XML (`<timedtext><body><p t="..." d="..."><s>...</s></p>`) + chapters + storyboard keyframes
const karpathyCues = timedVideoCues([
  {
    gapBefore: 0,
    text: "Tokenization sits at the boundary between raw Unicode text and the discrete integer sequences that a transformer actually processes.",
  },
  {
    gapBefore: 0.2,
    text: "Many seemingly bizarre failure modes in arithmetic, spelling, and whitespace indentation trace directly back to how byte-pair encoding merges frequent substrings.",
  },
  {
    gapBefore: 2.2,
    text: "Starting from UTF-8 bytes gives you a base vocabulary of two hundred fifty-six tokens before iteratively merging the highest-frequency adjacent pairs.",
  },
  {
    gapBefore: 0.2,
    text: "Because rare scripts or trailing spaces split into more tokens per word, they consume extra context window budget and increase attention cost.",
  },
]);

const karpathySrv3 = [
  '<?xml version="1.0" encoding="utf-8" ?><timedtext format="3"><body>',
  ...karpathyCues.map((c) => {
    const tMs = Math.round(c.startSec * 1000);
    const dMs = Math.round((c.endSec - c.startSec) * 1000);
    const words = c.text.split(" ");
    const spans = words.map((w, idx) => `<s>${idx === 0 ? w : ` ${w}`}</s>`).join("");
    return `<p t="${tMs}" d="${dMs}">${spans}</p>`;
  }),
  "</body></timedtext>",
].join("");

// 12. 3Blue1Brown-style YouTube manual VTT + description chapters + inline storyboard figures + Agent cleanup check
const threeBlueCues = timedVideoCues([
  {
    gapBefore: 0,
    text: "Visualizing self-attention starts with asking how an ambiguous noun like bank updates its embedding vector using surrounding words in the sentence.",
  },
  {
    gapBefore: 0.2,
    text: "Each token projects a query vector asking what context it needs and a key vector advertising what grammatical or semantic attributes it offers.",
  },
  {
    gapBefore: 2.0,
    text: "Taking scaled dot products between queries and keys produces a soft routing matrix whose rows sum to one after the softmax normalization step.",
  },
  {
    gapBefore: 0.2,
    text: "Multiplying those attention weights by value vectors blends contextual meaning directly into the residual stream across multiple parallel heads.",
  },
]);

const threeBlueVtt = [
  "WEBVTT",
  "",
  ...threeBlueCues.map((c) => `${toClock(c.startSec)} --> ${toClock(c.endSec)}\n${c.text}`),
].join("\n\n");

// 13. YouTube `json3` with 2-line ROLLING OVERLAPPING auto-captions (testing `dedupeRollingCues`)
const gotoRollingJson3 = JSON.stringify({
  events: [
    {
      tStartMs: 0,
      dDurationMs: 4200,
      segs: [{ utf8: "distributed consensus protocols must tolerate " }, { utf8: "asynchronous network partitions" }],
    },
    {
      // Overlaps suffix "asynchronous network partitions" -> adds new continuation
      tStartMs: 3900,
      dDurationMs: 5600,
      segs: [
        { utf8: "asynchronous network partitions without ever electing " },
        { utf8: "two conflicting leaders in the same term." },
      ],
    },
    {
      // Exact prefix extension overlap
      tStartMs: 9600,
      dDurationMs: 4500,
      segs: [{ utf8: "Majority quorums guarantee that any two election quorums" }],
    },
    {
      tStartMs: 12000,
      dDurationMs: 5500,
      segs: [
        {
          utf8: "Majority quorums guarantee that any two election quorums intersect in at least one up-to-date voter.",
        },
      ],
    },
    {
      tStartMs: 19500,
      dDurationMs: 7800,
      segs: [
        {
          utf8: "Log replication then commits an entry only after a quorum has durably fsynced that entry to non-volatile storage.",
        },
      ],
    },
  ],
});

// 14. Stanford CS229 lecture: unpunctuated `srv3` auto-captions + description chapters + keyframes
const cs229Cues = timedVideoCues(
  [
    { gapBefore: 0, text: "welcome everyone to lecture four where we derive generalized linear models from exponential family distributions" },
    { gapBefore: 0.15, text: "bernoulli and gaussian likelihoods both belong to this single canonical family parameterized by natural parameter eta" },
    { gapBefore: 0.15, text: "choosing the canonical link function makes the log likelihood concave so gradient ascent converges to a global optimum" },
    { gapBefore: 0.15, text: "softmax regression extends the exact same construction to multinomial outcomes across k mutually exclusive classes" },
    { gapBefore: 2.4, text: "now let us compare generative algorithms like gaussian discriminant analysis against discriminative logistic regression" },
    { gapBefore: 0.15, text: "when your gaussian modeling assumptions hold closely gda needs fewer labeled examples to reach its asymptotic error floor" },
    { gapBefore: 0.15, text: "however logistic regression remains consistent across broader exponential families without modeling input feature densities" },
  ],
  0,
  16,
);

const cs229Srv3 = [
  "<timedtext><body>",
  ...cs229Cues.map(
    (c) => `<p t="${Math.round(c.startSec * 1000)}" d="${Math.round((c.endSec - c.startSec) * 1000)}">${c.text}</p>`,
  ),
  "</body></timedtext>",
].join("");

// 15. Fireship-style rapid `<transcript><text start="..." dur="...">` short cues merged into prose paragraphs
const fireshipCues = timedVideoCues([
  { gapBefore: 0, text: "WebAssembly started as a portable binary target for browsers," },
  { gapBefore: 0.1, text: "delivering near-native linear memory execution inside a deterministic sandbox." },
  { gapBefore: 0.1, text: "With the Component Model and WASI Preview Two, modules compose across languages" },
  { gapBefore: 0.1, text: "using strongly typed WIT interfaces instead of fragile C ABI pointer glue." },
  { gapBefore: 0.1, text: "Edge runtimes cold-start isolated WebAssembly components in under half a millisecond," },
  { gapBefore: 0.1, text: "making per-request sandboxing practical at global scale." },
]);

const fireshipXml = [
  '<?xml version="1.0" encoding="utf-8" ?><transcript>',
  ...fireshipCues.map(
    (c) => `<text start="${c.startSec.toFixed(2)}" dur="${(c.endSec - c.startSec).toFixed(2)}">${c.text}</text>`,
  ),
  "</transcript>",
].join("");

// 16. Veritasium-style video with pre-chapter cold-open cues before Chapter 1 (`startSec: 18`)
const veritasiumCues = timedVideoCues([
  {
    gapBefore: 0,
    text: "Before digital transistors conquered computing, engineers solved differential equations with gears, integrators, and continuous voltages.",
  },
  {
    gapBefore: 0.2,
    text: "What if continuous physics is making an unexpected comeback inside ultra-low-power matrix accelerators today?",
  },
  {
    gapBefore: 4.5,
    text: "Lord Kelvin first sketched a mechanical tide predictor in eighteen seventy-six that summed harmonic cosines using brass pulleys and a single wire.",
  },
  {
    gapBefore: 0.2,
    text: "Vannevar Bush scaled that principle into the Rockefeller Differential Analyzer, computing ballistic trajectories faster than a room of human calculators.",
  },
  {
    gapBefore: 2.2,
    text: "Modern analog crossbar arrays store synaptic weights directly as conductance values, performing matrix-vector multiplication via Kirchhoff current summation.",
  },
  {
    gapBefore: 0.2,
    text: "Thermal noise and analog-to-digital conversion precision remain the primary engineering trade-offs when scaling above eight bits.",
  },
]);

const veritasiumVtt = [
  "WEBVTT",
  "",
  ...veritasiumCues.map((c) => `${toClock(c.startSec)} --> ${toClock(c.endSec)}\n${c.text}`),
].join("\n\n");

// 17. MIT 6.824 Raft lecture: `.srt` with Professor/Student speaker switches + chapters
const mitRaftCues = timedVideoCues([
  {
    speaker: "Professor",
    gapBefore: 0,
    text: "Raft decomposes consensus into leader election, log replication, and safety invariants so students can reason about each transition independently.",
  },
  {
    speaker: "Professor",
    gapBefore: 0.2,
    text: "Every server maintains a monotonically increasing term number that acts as a logical clock whenever network splits heal.",
  },
  {
    speaker: "Student",
    gapBefore: 0.5,
    text: "What prevents a stale leader in an isolated minority partition from serving outdated linearizable reads to a client?",
  },
  {
    speaker: "Professor",
    gapBefore: 0.5,
    text: "Great question. Before answering a linearizable read, the leader must exchange heartbeat rounds with a majority quorum to confirm nobody started a higher term.",
  },
  {
    speaker: "Professor",
    gapBefore: 2.0,
    text: "Log compaction snapshots state machine tables up to the last applied index so slow followers can install a snapshot instead of replaying millions of old entries.",
  },
]);

const mitRaftSrt = mitRaftCues
  .map(
    (c, idx) =>
      `${idx + 1}\n00:${toClock(c.startSec).replace(".", ",")} --> 00:${toClock(c.endSec).replace(".", ",")}\n[${c.speaker}]: ${c.text}`,
  )
  .join("\n\n");

// 18. Chinese YouTube `srv3` technical video with CJK 4-8 char rolling suffix-prefix overlap
const zhQuantSrv3 = [
  "<timedtext><body>",
  '<p t="0" d="4500">模型权重量化的核心目标是在尽量不损失推理精度的前提下降低显存占用</p>',
  '<p t="4300" d="5200">不损失推理精度的前提下降低显存占用，从而让单张消费级显卡能够流畅运行百亿参数模型。</p>',
  '<p t="9700" d="5800">离群激活值是四比特整数量化中最棘手的难题，少数通道的数值幅度可能是普通通道的几十倍。</p>',
  '<p t="18000" d="5400">通过感知激活分布对关键显著权重做等效缩放变换，可以把量化误差均匀分摊到更平滑的矩阵维度上。</p>',
  '<p t="23600" d="5200">配合定制的反量化融合算子，解码阶段的实际令牌生成吞吐量比半精度基线提升了两倍以上。</p>',
  "</body></timedtext>",
].join("");

// 19. RustConf Tokio scheduler `json3` + bulleted `[00:00]` description chapters + storyboard keyframes
const tokioCues = timedVideoCues([
  {
    gapBefore: 0,
    text: "Tokio schedules hundreds of thousands of lightweight asynchronous tasks across a fixed pool of operating system worker threads.",
  },
  {
    gapBefore: 0.2,
    text: "Each worker owns a bounded local run queue of two hundred fifty-six slots backed by a lock-free multi-producer single-consumer ring buffer.",
  },
  {
    gapBefore: 2.2,
    text: "Without a LIFO slot optimization, message-passing ping-pong tasks would wait behind older queued futures before waking on the warm CPU core.",
  },
  {
    gapBefore: 0.2,
    text: "Cooperative task budgets ensure a chatty future yields back to the epoll or kqueue driver after a bounded number of poll invocations.",
  },
]);

const tokioJson3 = JSON.stringify({
  events: tokioCues.map((c) => ({
    tStartMs: Math.round(c.startSec * 1000),
    dDurationMs: Math.round((c.endSec - c.startSec) * 1000),
    segs: [{ utf8: c.text }],
  })),
});

// 20. NeurIPS Oral (Bilingual WebVTT + Agent `cleanup_transcript` validation & highlight survival)
const neuripsCues = timedVideoCues(
  [
    {
      gapBefore: 0,
      text: "speculative decoding uses a compact draft model to propose k candidate tokens in parallel and verifies all of them in one target model forward pass",
    },
    {
      gapBefore: 0.2,
      text: "because rejection sampling matches the exact target distribution speculative decoding accelerates autoregressive latency with zero loss in output quality",
    },
    {
      gapBefore: 2.0,
      text: "在长代码补全和结构化 JSON 生成任务里草稿模型的接受率经常超过百分之八十从而带来两到三倍的端到端加速比",
    },
    {
      gapBefore: 0.2,
      text: "树状推测解码进一步在单次注意力掩码里同时验证多条候选分支最大化利用现代加速卡的算术强度余量",
    },
  ],
  0,
  11,
);

const neuripsVtt = [
  "WEBVTT",
  "",
  ...neuripsCues.map((c) => `${toClock(c.startSec)} --> ${toClock(c.endSec)}\n${c.text}`),
].join("\n\n");

export const VIDEO_FIXTURES: readonly MediaFixture[] = [
  {
    slug: "11-karpathy-tokenizer-srv3",
    title: "Let's Build the GPT Tokenizer",
    url: "https://www.youtube.com/watch?v=zduSFxRajkE",
    kind: "video",
    language: "en",
    format: "youtube-srv3",
    scenario: "YouTube srv3 word-span XML + structured chapters + storyboard keyframe figures",
    mediaType: "application/xml",
    rawTranscript: karpathySrv3,
    structuredChapters: [
      { startSec: 0, title: "Why Tokenization Matters" },
      { startSec: Math.floor(karpathyCues[2]!.startSec), title: "Byte-Pair Encoding on UTF-8" },
    ],
    keyframes: [
      { timeSec: 0, url: "quire-figure://1111111111111111/0.png", width: 320, height: 180 },
      { timeSec: Math.floor(karpathyCues[2]!.startSec), url: "quire-figure://1111111111111111/1.png", width: 320, height: 180 },
    ],
    expectedChapters: ["Why Tokenization Matters", "Byte-Pair Encoding on UTF-8"],
    probes: [
      { phrase: "Tokenization sits at the boundary", expectedSec: karpathyCues[0]!.startSec },
      { phrase: "Starting from UTF-8 bytes gives you", expectedSec: karpathyCues[2]!.startSec },
    ],
    expectedParagraphRange: [2, 2],
  },
  {
    slug: "12-3blue1brown-attention-vtt",
    title: "Attention in Transformers, Visually Explained",
    url: "https://www.youtube.com/watch?v=eMlx5fFNoYc",
    kind: "video",
    language: "en",
    format: "vtt",
    scenario: "Manual YouTube VTT + description chapters + keyframes + Agent cleanup highlight preservation",
    mediaType: "text/vtt",
    rawTranscript: threeBlueVtt,
    descriptionSource: [
      "Visualizing how queries, keys, and values interact.",
      "00:00 Queries and Keys",
      `00:${String(Math.floor(threeBlueCues[2]!.startSec)).padStart(2, "0")} Softmax Routing and Value Blending`,
    ].join("\n"),
    keyframes: [
      { timeSec: 0, url: "quire-figure://2222222222222222/0.png", width: 320, height: 180 },
      { timeSec: Math.floor(threeBlueCues[2]!.startSec), url: "quire-figure://2222222222222222/1.png", width: 320, height: 180 },
    ],
    expectedChapters: ["Queries and Keys", "Softmax Routing and Value Blending"],
    probes: [
      { phrase: "Visualizing self-attention starts", expectedSec: threeBlueCues[0]!.startSec },
      { phrase: "Taking scaled dot products between queries", expectedSec: threeBlueCues[2]!.startSec },
    ],
    expectedParagraphRange: [2, 2],
    agentCleanup: {
      validMarkdown: [
        "## Queries and Keys",
        "",
        "[00:00] **Grant Sanderson**: Visualizing self-attention starts with asking how an ambiguous noun like *bank* updates its embedding vector using surrounding words in the sentence. Each token projects a query vector asking what context it needs, and a key vector advertising what grammatical or semantic attributes it offers.",
        "",
        "## Softmax Routing and Value Blending",
        "",
        `[00:${String(Math.floor(threeBlueCues[2]!.startSec)).padStart(2, "0")}] **Grant Sanderson**: Taking scaled dot products between queries and keys produces a soft routing matrix whose rows sum to one after the softmax normalization step. Multiplying those attention weights by value vectors blends contextual meaning directly into the residual stream across multiple parallel heads.`,
      ].join("\n"),
      highlightedRawQuote: "Multiplying those attention weights by value vectors blends contextual meaning",
      expectedRefinedSubstring: "Multiplying those attention weights by value vectors",
      overSummarizedMarkdown: "[00:00] **Grant**: Self-attention multiplies queries, keys, and values.",
      nonMonotonicMarkdown:
        "[00:25] **Grant**: Visualizing self-attention starts with asking how an ambiguous noun like bank updates its embedding vector using surrounding words in the sentence. Each token projects a query vector asking what context it needs and a key vector advertising what grammatical or semantic attributes it offers.\n\n[00:05] **Grant**: Taking scaled dot products between queries and keys produces a soft routing matrix whose rows sum to one after the softmax normalization step. Multiplying those attention weights by value vectors blends contextual meaning directly into the residual stream across multiple parallel heads.",
    },
  },
  {
    slug: "13-goto-distributed-rolling-json3",
    title: "Consensus Under Network Partitions",
    url: "https://www.youtube.com/watch?v=99999999913",
    kind: "video",
    language: "en",
    format: "youtube-json3",
    scenario: "YouTube json3 2-line rolling auto-captions deduplicated with zero repeated phrases",
    mediaType: "application/json",
    rawTranscript: gotoRollingJson3,
    expectedChapters: [],
    probes: [
      { phrase: "distributed consensus protocols must tolerate", expectedSec: 0 },
      { phrase: "Log replication then commits an entry", expectedSec: 19.5 },
    ],
    expectedParagraphRange: [1, 2],
    forbiddenSubstrings: [
      "asynchronous network partitions asynchronous network partitions",
      "Majority quorums guarantee that any two election quorums Majority quorums",
    ],
  },
  {
    slug: "14-stanford-cs229-unpunctuated-srv3",
    title: "CS229 Lecture 4 — Generalized Linear Models",
    url: "https://www.youtube.com/watch?v=99999999914",
    kind: "video",
    language: "en",
    format: "youtube-srv3",
    scenario: "Unpunctuated university lecture srv3 + description chapters + inline keyframes",
    mediaType: "application/xml",
    rawTranscript: cs229Srv3,
    descriptionSource: [
      "Lecture topics:",
      "00:00 Exponential Family and Canonical Links",
      `00:${String(Math.floor(cs229Cues[4]!.startSec)).padStart(2, "0")} Generative vs Discriminative Classifiers`,
    ].join("\n"),
    keyframes: [{ timeSec: 0, url: "quire-figure://3333333333333333/0.png", width: 320, height: 180 }],
    expectedChapters: ["Exponential Family and Canonical Links", "Generative vs Discriminative Classifiers"],
    probes: [
      { phrase: "welcome everyone to lecture four", expectedSec: cs229Cues[0]!.startSec },
      { phrase: "now let us compare generative algorithms", expectedSec: cs229Cues[4]!.startSec },
    ],
    expectedParagraphRange: [2, 2],
  },
  {
    slug: "15-fireship-wasm-rapid-xml",
    title: "WebAssembly Component Model in 100 Seconds",
    url: "https://www.youtube.com/watch?v=99999999915",
    kind: "video",
    language: "en",
    format: "youtube-xml",
    scenario: "Classic <transcript><text> rapid short cues coalesced into cohesive prose",
    mediaType: "text/xml",
    rawTranscript: fireshipXml,
    expectedChapters: [],
    probes: [{ phrase: "WebAssembly started as a portable binary target", expectedSec: 0 }],
    expectedParagraphRange: [1, 1],
  },
  {
    slug: "16-veritasium-analog-computing-vtt",
    title: "The Unreasonable Return of Analog Computers",
    url: "https://www.youtube.com/watch?v=99999999916",
    kind: "video",
    language: "en",
    format: "vtt",
    scenario: "Pre-chapter cold-open intro preserved above Chapter 1 + multi-chapter recall",
    mediaType: "text/vtt",
    rawTranscript: veritasiumVtt,
    descriptionSource: [
      `00:${String(Math.floor(veritasiumCues[2]!.startSec)).padStart(2, "0")} Kelvin and Mechanical Integrators`,
      `00:${String(Math.floor(veritasiumCues[4]!.startSec)).padStart(2, "0")} Analog Crossbars for Matrix Math`,
    ].join("\n"),
    expectedChapters: ["Kelvin and Mechanical Integrators", "Analog Crossbars for Matrix Math"],
    probes: [
      { phrase: "Before digital transistors conquered computing", expectedSec: 0 },
      { phrase: "Lord Kelvin first sketched a mechanical tide predictor", expectedSec: veritasiumCues[2]!.startSec },
      { phrase: "Modern analog crossbar arrays store synaptic weights", expectedSec: veritasiumCues[4]!.startSec },
    ],
    expectedParagraphRange: [3, 3],
  },
  {
    slug: "17-mit-6824-raft-consensus-srt",
    title: "MIT 6.824 — Raft Distributed Consensus",
    url: "https://www.youtube.com/watch?v=99999999917",
    kind: "video",
    language: "en",
    format: "srt",
    scenario: "Classroom Q&A speaker turn splitting ([Professor] / [Student]) inside chapters",
    mediaType: "application/x-subrip",
    rawTranscript: mitRaftSrt,
    descriptionSource: [
      "00:00 Terms, Quorums, and Read Leases",
      `00:${String(Math.floor(mitRaftCues[4]!.startSec)).padStart(2, "0")} Log Compaction and Snapshots`,
    ].join("\n"),
    expectedChapters: ["Terms, Quorums, and Read Leases", "Log Compaction and Snapshots"],
    probes: [
      { phrase: "Raft decomposes consensus into leader election", expectedSec: mitRaftCues[0]!.startSec },
      { phrase: "What prevents a stale leader", expectedSec: mitRaftCues[2]!.startSec },
      { phrase: "Log compaction snapshots state machine tables", expectedSec: mitRaftCues[4]!.startSec },
    ],
    expectedParagraphRange: [4, 4],
  },
  {
    slug: "18-yt-zh-llm-quantization-srv3",
    title: "四比特权重量化与激活离群值抑制详解",
    url: "https://www.youtube.com/watch?v=99999999918",
    kind: "video",
    language: "zh",
    format: "youtube-srv3",
    scenario: "Chinese YouTube srv3 rolling CJK suffix-prefix overlap deduplication + chapters",
    mediaType: "application/xml",
    rawTranscript: zhQuantSrv3,
    descriptionSource: ["00:00 为什么需要四比特量化与离群值挑战", "00:18 等效缩放变换与反量化融合算子"].join("\n"),
    expectedChapters: ["为什么需要四比特量化与离群值挑战", "等效缩放变换与反量化融合算子"],
    probes: [
      { phrase: "模型权重量化的核心目标", expectedSec: 0 },
      { phrase: "通过感知激活分布对关键显著权重", expectedSec: 18 },
    ],
    expectedParagraphRange: [2, 2],
    forbiddenSubstrings: ["不损失推理精度的前提下降低显存占用不损失推理精度的前提下降低显存占用"],
  },
  {
    slug: "19-rustconf-tokio-scheduler-json3",
    title: "Inside Tokio's Work-Stealing Task Scheduler",
    url: "https://www.youtube.com/watch?v=99999999919",
    kind: "video",
    language: "en",
    format: "youtube-json3",
    scenario: "YouTube json3 + bulleted [MM:SS] chapters + storyboard keyframe figures",
    mediaType: "application/json",
    rawTranscript: tokioJson3,
    descriptionSource: [
      "- [00:00] Local Run Queues and Ring Buffers",
      `- [00:${String(Math.floor(tokioCues[2]!.startSec)).padStart(2, "0")}] LIFO Slot and Cooperative Task Budgets`,
    ].join("\n"),
    keyframes: [
      { timeSec: 0, url: "quire-figure://4444444444444444/0.png", width: 320, height: 180 },
      { timeSec: Math.floor(tokioCues[2]!.startSec), url: "quire-figure://4444444444444444/1.png", width: 320, height: 180 },
    ],
    expectedChapters: ["Local Run Queues and Ring Buffers", "LIFO Slot and Cooperative Task Budgets"],
    probes: [
      { phrase: "Tokio schedules hundreds of thousands", expectedSec: tokioCues[0]!.startSec },
      { phrase: "Without a LIFO slot optimization", expectedSec: tokioCues[2]!.startSec },
    ],
    expectedParagraphRange: [2, 2],
  },
  {
    slug: "20-neurips-oral-speculative-decoding",
    title: "Lossless Speculative Decoding with Draft Trees",
    url: "https://www.youtube.com/watch?v=99999999920",
    kind: "video",
    language: "bilingual",
    format: "vtt",
    scenario: "Bilingual research oral + Agent cleanup_transcript guardrails & highlight re-anchoring",
    mediaType: "text/vtt",
    rawTranscript: neuripsVtt,
    structuredChapters: [
      { startSec: 0, title: "Draft-and-Verify Rejection Sampling" },
      { startSec: Math.floor(neuripsCues[2]!.startSec), title: "树状推测解码与端到端加速" },
    ],
    expectedChapters: ["Draft-and-Verify Rejection Sampling", "树状推测解码与端到端加速"],
    probes: [
      { phrase: "speculative decoding uses a compact draft model", expectedSec: neuripsCues[0]!.startSec },
      { phrase: "在长代码补全和结构化 JSON 生成任务里", expectedSec: neuripsCues[2]!.startSec },
    ],
    expectedParagraphRange: [2, 2],
    agentCleanup: {
      validMarkdown: [
        "## Draft-and-Verify Rejection Sampling",
        "",
        "[00:00] **Speaker**: Speculative decoding uses a compact draft model to propose *k* candidate tokens in parallel and verifies all of them in one target-model forward pass. Because rejection sampling matches the exact target distribution, speculative decoding accelerates autoregressive latency with zero loss in output quality.",
        "",
        "## 树状推测解码与端到端加速",
        "",
        `[00:${String(Math.floor(neuripsCues[2]!.startSec)).padStart(2, "0")}] **Speaker**: 在长代码补全和结构化 JSON 生成任务里，草稿模型的接受率经常超过百分之八十，从而带来两到三倍的端到端加速比。树状推测解码进一步在单次注意力掩码里同时验证多条候选分支，最大化利用现代加速卡的算术强度余量。`,
      ].join("\n"),
      highlightedRawQuote: "树状推测解码进一步在单次注意力掩码里同时验证多条候选分支",
      expectedRefinedSubstring: "树状推测解码进一步在单次注意力掩码里同时验证多条候选分支",
      overSummarizedMarkdown: "[00:00] **Speaker**: Speculative decoding speeds up LLMs by 2-3x.",
      nonMonotonicMarkdown:
        "[00:25] **Speaker**: Speculative decoding uses a compact draft model to propose k candidate tokens in parallel and verifies all of them in one target model forward pass.\n\n[00:02] **Speaker**: 在长代码补全和结构化 JSON 生成任务里草稿模型的接受率经常超过百分之八十从而带来两到三倍的端到端加速比。",
    },
  },
];
