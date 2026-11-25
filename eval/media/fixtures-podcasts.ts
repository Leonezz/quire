import type { MediaFixture } from "./types";

/**
 * Helper to build deterministic timed cues where duration matches speaking rate (~15 chars/sec for English,
 * ~4.5 chars/sec for Chinese) so both paragraph boundary anchors and proportional phrase interpolation reflect
 * realistic acoustic speech timing.
 */
function timedSequence(
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

function toClockVtt(sec: number, forceHours = false): string {
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  const whole = Math.floor(sec);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  if (forceHours || h > 0) {
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

function toClockSrt(sec: number): string {
  return toClockVtt(sec, true).replace(".", ",");
}

// 1. Dwarkesh-style interview: WebVTT `<v Speaker>` + HTML show-notes chapters
const dwarkeshCues = timedSequence([
  {
    speaker: "Dwarkesh Patel",
    gapBefore: 0,
    text: "Welcome back to the podcast. Today we are examining why pretraining scaling laws shifted toward inference-time search and verifiable reward signals across mathematics and software engineering.",
  },
  {
    speaker: "Dwarkesh Patel",
    gapBefore: 0.25,
    text: "When you look at compute budgets over the next three years, how much of the frontier gain comes from larger base models versus test-time reasoning trajectories?",
  },
  {
    speaker: "Noam Brown",
    gapBefore: 0.6,
    text: "If you trace poker and Diplomacy back a few years, the key lesson was that spending ten seconds of search at decision time can match a hundredfold increase in parameter count.",
  },
  {
    speaker: "Noam Brown",
    gapBefore: 0.25,
    text: "Language models needed a general representation of world knowledge first, so pretraining had to come before search could generalize outside narrow board games.",
  },
  {
    speaker: "Dwarkesh Patel",
    gapBefore: 2.2,
    text: "Let us move to verification bottlenecks. In code and formal proofs you have a compiler, whereas in open-ended biology or historical analysis there is no crisp unit test.",
  },
  {
    speaker: "Noam Brown",
    gapBefore: 0.5,
    text: "Verification is often asymmetric even without a formal compiler. Evaluating whether a proposed synthesis route violates thermodynamics is still substantially easier than inventing the route from scratch.",
  },
  {
    speaker: "Noam Brown",
    gapBefore: 0.25,
    text: "That asymmetry is what lets learned reward models and critique loops extend search beyond competitive programming into scientific literature synthesis.",
  },
]);

const dwarkeshVtt = [
  "WEBVTT",
  "",
  ...dwarkeshCues.map(
    (c) => `${toClockVtt(c.startSec)} --> ${toClockVtt(c.endSec)}\n<v ${c.speaker}>${c.text}</v>`,
  ),
].join("\n\n");

// 2. Lex-style systems interview: SRT with `[Speaker]:` + trailing chapter timestamps in show notes
const lexCues = timedSequence([
  {
    speaker: "Host",
    gapBefore: 0,
    text: "Let us start at the metal. Why did compiler IR design converge on static single assignment form, and where does SSA still hurt modern vectorizing backends?",
  },
  {
    speaker: "Chris Lattner",
    gapBefore: 0.5,
    text: "SSA made sparse dataflow analyses fast and composable because every value has a single definition point, turning global graph problems into local dominance walks.",
  },
  {
    speaker: "Chris Lattner",
    gapBefore: 0.2,
    text: "Where classic flat SSA struggled was representing multi-level domain abstractions like tensor tiles, async coroutines, and hardware dialects in one monolithic IR.",
  },
  {
    speaker: "Host",
    gapBefore: 2.0,
    text: "And that directly motivated MLIR with nested regions and dialect conversion passes instead of lowering everything straight into low-level machine instructions.",
  },
  {
    speaker: "Chris Lattner",
    gapBefore: 0.4,
    text: "Exactly. Keeping loop nests and memory layout semantics intact until late lowering lets an accelerator backend fuse operations without reverse-engineering pointer arithmetic.",
  },
]);

const lexSrt = lexCues
  .map((c, idx) => `${idx + 1}\n${toClockSrt(c.startSec)} --> ${toClockSrt(c.endSec)}\n[${c.speaker}]: ${c.text}`)
  .join("\n\n");

// 3. Changelog-style Podcasting 2.0 JSON transcript + noise cues + JSON chapters
const changelogCues = timedSequence([
  {
    speaker: "Jerod",
    gapBefore: 0,
    text: "SQLite runs on billions of devices, yet developers still underestimate how far write-ahead logging and strict tables take a single-node embedded database.",
  },
  {
    speaker: "Jerod",
    gapBefore: 0.2,
    text: "With WAL mode enabled, concurrent readers never block on a single writer appending frames to the write-ahead log on local NVMe storage.",
  },
  {
    speaker: "Richard Hipp",
    gapBefore: 0.6,
    text: "We originally designed SQLite so flight software would never depend on a separate database daemon that could crash or run out of file descriptors.",
  },
  {
    speaker: "Richard Hipp",
    gapBefore: 0.25,
    text: "Because queries execute inside your own process address space, twenty small point lookups avoid every microsecond of socket serialization and context switching.",
  },
]);

const changelogJson = JSON.stringify({
  version: "1.0.0",
  segments: [
    { startTime: 0, endTime: 1.5, body: "[music]" },
    ...changelogCues.map((c) => ({
      startTime: c.startSec,
      endTime: c.endSec,
      speaker: c.speaker,
      body: c.text,
    })),
    { startTime: 90, endTime: 92, body: "[laughter]" },
  ],
});

// 4. Acquired-style long-form narrative (> 1 hour clock timestamps `1:02:00` + multi-paragraph monologue)
const acquiredCues = timedSequence(
  [
    {
      gapBefore: 0,
      text: "By nineteen eighty-seven Morris Chang recognized a structural split in semiconductors that integrated device manufacturers had completely overlooked.",
    },
    {
      gapBefore: 0.2,
      text: "Fabs were growing exponentially expensive to capitalize while chip architects wanted to iterate on logic design without raising two billion dollars for lithography cleanrooms.",
    },
    {
      gapBefore: 0.2,
      text: "Pure-play foundry manufacturing promised every fabless startup that TSMC would never compete against its own customers with internal processor products.",
    },
    {
      gapBefore: 0.2,
      text: "That trust covenant unlocked Nvidia, Broadcom, Qualcomm, and eventually Apple silicon, compounding yield learning across hundreds of distinct tape-outs every quarter.",
    },
    {
      gapBefore: 2.1,
      text: "When extreme ultraviolet lithography arrived at seven nanometers, that accumulated process discipline turned into an almost insurmountable manufacturing moat.",
    },
    {
      gapBefore: 0.2,
      text: "Even minor improvements in pellicle durability and light source uptime translated directly into billions of dollars of wafer output at ninety percent utilization.",
    },
    {
      gapBefore: 0.2,
      text: "Incidentally, the board announced the Arizona expansion at 3:30 PM Taipei time, though the engineering ramp spanned four full calendar years.",
    },
  ],
  3720,
);

const acquiredVtt = [
  "WEBVTT",
  "",
  ...acquiredCues.map((c) => `${toClockVtt(c.startSec, true)} --> ${toClockVtt(c.endSec, true)}\n${c.text}`),
].join("\n\n");

// 5. Xiaoyuzhou Chinese Tech Podcast (.srt + Chinese speaker prefixes + sponsor boilerplate stripping)
const xiaoyuzhouCues = timedSequence(
  [
    {
      speaker: "主播",
      gapBefore: 0,
      text: "欢迎来到本期节目，今天我们深入聊聊异步运行时在高并发存储引擎里的真实开销与工程权衡。",
    },
    {
      speaker: "主播",
      gapBefore: 0.2,
      text: "很多团队在引入异步框架之后发现尾延迟反而升高了，核心原因往往是跨线程工作窃取破坏了处理器缓存局部性。",
    },
    {
      speaker: "嘉宾",
      gapBefore: 0.6,
      text: "没错，在现代固态硬盘与内核轮询接口普及之后，单次输入输出请求的硬件延迟已经降到了几十微秒量级。",
    },
    {
      speaker: "嘉宾",
      gapBefore: 0.2,
      text: "如果每次状态机唤醒都要经历原子队列竞争和跨核迁移，调度器本身的成本就会接近底层存储介质的访问时间。",
    },
    {
      speaker: "主播",
      gapBefore: 2.0,
      text: "那采用每核独占事件循环与共享无锁缓冲池的线程绑定架构，在代码可维护性上会带来哪些新的挑战？",
    },
    {
      speaker: "嘉宾",
      gapBefore: 0.5,
      text: "最关键的约束是任何阻塞系统调用都不能混入计算线程，必须通过显式的消息通道把慢速任务隔离在独立线程池之外。",
    },
  ],
  0,
  4.8,
);

const xiaoyuzhouSrt = xiaoyuzhouCues
  .map((c, idx) => `${idx + 1}\n${toClockSrt(c.startSec)} --> ${toClockSrt(c.endSec)}\n${c.speaker}: ${c.text}`)
  .join("\n\n");

// 6. Bilingual AI Infra Podcast (WebVTT mixing Chinese & English technical identifiers)
const bilingualCues = timedSequence(
  [
    {
      speaker: "张伟",
      gapBefore: 0,
      text: "在大模型在线推理场景下，Prefill 阶段属于典型的算力受限任务，而 Decode 阶段则完全受限于显存带宽与 KV Cache 容量。",
    },
    {
      speaker: "张伟",
      gapBefore: 0.2,
      text: "当我们把 PagedAttention 和 Continuous Batching 结合起来之后，显存碎片率从百分之四十直接降到了百分之四以内。",
    },
    {
      speaker: "Lin",
      gapBefore: 0.6,
      text: "更进一步的做法是把 Prefill 和 Decode 拆到不同的 GPU 节点池上，通过高速 RDMA 网络传输键值缓存张量。",
    },
    {
      speaker: "Lin",
      gapBefore: 0.25,
      text: "这样既不会让长上下文输入阻塞正在流式生成的请求，也能针对 CUDA Graph 固定批量大小做极致内核融合优化。",
    },
  ],
  0,
  5.5,
);

const bilingualVtt = [
  "WEBVTT",
  "",
  ...bilingualCues.map((c) => `${toClockVtt(c.startSec)} --> ${toClockVtt(c.endSec)}\n<v ${c.speaker}>${c.text}</v>`),
].join("\n\n");

// 7. OpenAI / Groq Whisper `verbose_json` output with acoustic >= 1.5s pauses
const whisperCues = timedSequence([
  {
    gapBefore: 0,
    text: "Reliable tool-using agents depend far more on deterministic schema validation and idempotent state transitions than on clever prompt phrasing.",
  },
  {
    gapBefore: 0.2,
    text: "Whenever an external API returns a transient timeout or a partial payload, the runtime should surface a structured error code so the model can retry cleanly.",
  },
  {
    gapBefore: 0.2,
    text: "Keeping context windows compact by paging through long documents on demand also prevents attention dilution in multi-step research loops.",
  },
  {
    gapBefore: 2.0,
    text: "In our production traces, bounding each tool response to six thousand characters cut token spend in half while raising citation accuracy by fourteen points.",
  },
  {
    gapBefore: 0.2,
    text: "Every cited claim still points back to an immutable snapshot on disk, allowing readers to verify exact quotes months after the session ran.",
  },
]);

const whisperVerboseJson = JSON.stringify({
  task: "transcribe",
  language: "english",
  duration: whisperCues[whisperCues.length - 1]!.endSec,
  segments: whisperCues.map((c, id) => ({
    id,
    start: c.startSec,
    end: c.endSec,
    text: ` ${c.text}`,
  })),
});

// 8. Plain-text ASR fallback (`vad-plain-asr`: SenseVoiceSmall / gpt-4o-transcribe returning only `{"text"}` per VAD chunk)
const vadPlainChunks = JSON.stringify([
  {
    startSec: 0,
    endSec: 28,
    text: "独立播客往往没有官方时间轴字幕，但通过客户端静音能量谷值切分音频流，依然可以把每段语音精准锚定在物理起止秒数之内。即使远端语音识别模型只返回纯文本字符串，分段时间戳也不会发生累积漂移。",
  },
  {
    startSec: 29.8,
    endSec: 58,
    text: "当读者在文稿里划下一句重点笔记时，阅读器会同时保存文本前后缀定位器与对应的音频秒数区间。哪怕之后使用智能体重新润色标点和段落，原有的高亮依然能够稳稳落回对应的自然段。",
  },
]);

// 9. Completely unpunctuated raw ASR monologue (> 200 words without `.?!`, testing `MAX_UNPUNCTUATED_WORDS` pause fallback)
const unpunctuatedSegments = [
  { gapBefore: 0, text: "board management controllers sit on a tiny auxiliary processor beside the main server cpu and stay powered whenever standby voltage reaches the rack" },
  { gapBefore: 0.15, text: "legacy firmware stacks accumulated millions of lines of unverified c code with shared mutable globals and network daemons listening on management ports" },
  { gapBefore: 0.15, text: "when we designed hubris we asked what happens if every driver task has a statically allocated memory region chosen at compile time" },
  { gapBefore: 0.15, text: "there is no dynamic heap allocator in the kernel and tasks cannot spawn threads or map executable pages at runtime" },
  { gapBefore: 0.75, text: "interprocess communication uses synchronous rendezvous messages whose payload sizes are known to the rust type system before flashing the image" },
  { gapBefore: 0.15, text: "if a spi peripheral driver panics on a malformed bus transaction the supervisor restarts only that isolated task in microseconds" },
  { gapBefore: 0.15, text: "meanwhile thermal fan control loops keep running deterministically because fault domains never share raw pointers across protection boundaries" },
  { gapBefore: 0.7, text: "auditing the entire trusted computing base becomes tractable for three engineers instead of requiring an army of security patch maintainers" },
  { gapBefore: 0.15, text: "that architectural simplicity is why static task isolation beats retrofitting sandboxes onto general purpose operating systems inside firmware" },
];
const oxideUnpunctuatedCues = timedSequence(unpunctuatedSegments, 0, 16);
const oxideVtt = [
  "WEBVTT",
  "",
  ...oxideUnpunctuatedCues.map((c) => `${toClockVtt(c.startSec)} --> ${toClockVtt(c.endSec)}\n${c.text}`),
].join("\n\n");

// 10. Radiolab-style narrative VTT with HTML entities, inline `<00:00:02.100><c>` karaoke tags, and `♪` music cues
const radiolabVtt = [
  "WEBVTT",
  "NOTE Exported with inline word timestamps & entities",
  "",
  "00:00.000 --> 00:02.000\n♪",
  "",
  "00:02.000 --> 00:11.600\n<v Jad>When Claude Shannon published &quot;A Mathematical Theory of Communication&quot; in 1948, engineers assumed <00:06.500><c>noise</c> always required lowering transmission power or slowing the symbol rate.</v>",
  "",
  "00:11.800 --> 00:21.400\n<v Jad>Shannon proved something astonishing &amp; counterintuitive: below channel capacity, you can drive error probability arbitrarily close to zero with redundant coding.</v>",
  "",
  "00:22.000 --> 00:31.800\n<v Robert>Wait &#39;til you hear how long it took hardware designers to actually approach Shannon&#39;s limit using turbo codes and low-density parity checks on deep-space probes.</v>",
  "",
  "00:32.000 --> 00:34.000\n[music]",
].join("\n");

export const PODCAST_FIXTURES: readonly MediaFixture[] = [
  {
    slug: "01-dwarkesh-scaling-vtt",
    title: "Scaling Search vs Pretraining",
    url: "https://dwarkesh.example.org/p/inference-scaling",
    kind: "podcast",
    language: "en",
    format: "vtt",
    scenario: "WebVTT <v Speaker> turns + HTML show-notes chapter extraction",
    mediaType: "text/vtt",
    rawTranscript: dwarkeshVtt,
    descriptionSource:
      "<p>Episode outline:</p><ul><li>00:00 Pretraining vs Inference Search</li><li>00:46 Verification Asymmetry</li></ul><p>Sponsored by ExampleCloud.</p>",
    expectedChapters: ["Pretraining vs Inference Search", "Verification Asymmetry"],
    probes: [
      { phrase: "Welcome back to the podcast.", expectedSec: dwarkeshCues[0]!.startSec },
      { phrase: "If you trace poker and Diplomacy", expectedSec: dwarkeshCues[2]!.startSec },
      { phrase: "Let us move to verification bottlenecks.", expectedSec: dwarkeshCues[4]!.startSec },
    ],
    expectedParagraphRange: [4, 5],
  },
  {
    slug: "02-lex-compilers-srt",
    title: "SSA, MLIR, and Compiler Backends",
    url: "https://lex.example.org/episodes/mlir-compilers",
    kind: "podcast",
    language: "en",
    format: "srt",
    scenario: "SubRip (.srt) bracket speakers + trailing timestamp chapters",
    mediaType: "application/x-subrip",
    rawTranscript: lexSrt,
    descriptionSource: [
      "Compiler design conversation.",
      "- Why SSA Won and Where It Hurts - 00:00",
      "- Nested Regions in MLIR - 00:32",
      "Follow us: https://example.org",
    ].join("\n"),
    expectedChapters: ["Why SSA Won and Where It Hurts", "Nested Regions in MLIR"],
    probes: [
      { phrase: "Let us start at the metal.", expectedSec: lexCues[0]!.startSec },
      { phrase: "SSA made sparse dataflow analyses", expectedSec: lexCues[1]!.startSec },
      { phrase: "And that directly motivated MLIR", expectedSec: lexCues[3]!.startSec },
    ],
    expectedParagraphRange: [4, 4],
  },
  {
    slug: "03-changelog-sqlite-p2json",
    title: "Why SQLite Runs Everywhere",
    url: "https://changelog.example.org/podcast/sqlite-wal",
    kind: "podcast",
    language: "en",
    format: "podcast-json",
    scenario: "Podcasting 2.0 JSON segments + structured chapters + [music]/[laughter] filtering",
    mediaType: "application/json",
    rawTranscript: changelogJson,
    structuredChapters: [
      { startSec: 0, title: "Write-Ahead Logging Concurrency" },
      { startSec: Math.floor(changelogCues[2]!.startSec), title: "In-Process Latency Advantage" },
    ],
    expectedChapters: ["Write-Ahead Logging Concurrency", "In-Process Latency Advantage"],
    probes: [
      { phrase: "SQLite runs on billions of devices", expectedSec: changelogCues[0]!.startSec },
      { phrase: "We originally designed SQLite", expectedSec: changelogCues[2]!.startSec },
    ],
    expectedParagraphRange: [2, 3],
    forbiddenSubstrings: ["[music]", "[laughter]"],
  },
  {
    slug: "04-acquired-tsmc-longform-vtt",
    title: "TSMC and the Pure-Play Foundry Model",
    url: "https://acquired.example.org/episodes/tsmc",
    kind: "podcast",
    language: "en",
    format: "vtt",
    scenario: "Multi-hour HH:MM:SS timestamps (>1h) + false-positive prose clock guard (3:30 PM)",
    mediaType: "text/vtt",
    rawTranscript: acquiredVtt,
    descriptionSource: "Recorded live. The press briefing happened at 3:30 PM Taipei time.",
    expectedChapters: [],
    probes: [
      { phrase: "By nineteen eighty-seven Morris Chang", expectedSec: acquiredCues[0]!.startSec },
      { phrase: "When extreme ultraviolet lithography arrived", expectedSec: acquiredCues[4]!.startSec },
    ],
    expectedParagraphRange: [2, 3],
  },
  {
    slug: "05-xiaoyuzhou-rust-async-zh",
    title: "高并发存储引擎中的异步调度权衡",
    url: "https://xiaoyuzhou.example.org/episode/async-io",
    kind: "podcast",
    language: "zh",
    format: "srt",
    scenario: "Chinese podcast SRT + CJK zero-space joining + Chinese speaker & chapter markers",
    mediaType: "text/srt",
    rawTranscript: xiaoyuzhouSrt,
    descriptionSource: [
      "本期探讨现代 NVMe 存储与异步运行时设计。",
      "00:00 工作窃取与缓存局部性",
      `00:${String(Math.floor(xiaoyuzhouCues[4]!.startSec)).padStart(2, "0")} 线程绑定架构的隔离约束`,
      "本期赞助：某云基础设施",
    ].join("\n"),
    expectedChapters: ["工作窃取与缓存局部性", "线程绑定架构的隔离约束"],
    probes: [
      { phrase: "欢迎来到本期节目", expectedSec: xiaoyuzhouCues[0]!.startSec },
      { phrase: "没错，在现代固态硬盘", expectedSec: xiaoyuzhouCues[2]!.startSec },
      { phrase: "那采用每核独占事件循环", expectedSec: xiaoyuzhouCues[4]!.startSec },
    ],
    expectedParagraphRange: [4, 4],
    forbiddenSubstrings: ["本期赞助"],
  },
  {
    slug: "06-guigu101-ai-infra-bilingual",
    title: "推理集群的 Prefill 与 Decode 分离架构",
    url: "https://guigu101.example.org/episodes/disaggregated-serving",
    kind: "podcast",
    language: "bilingual",
    format: "vtt",
    scenario: "Bilingual Chinese/English technical podcast + mixed CJK/Latin word-unit parity",
    mediaType: "text/vtt",
    rawTranscript: bilingualVtt,
    expectedChapters: [],
    probes: [
      { phrase: "在大模型在线推理场景下", expectedSec: bilingualCues[0]!.startSec },
      { phrase: "更进一步的做法是把 Prefill 和 Decode", expectedSec: bilingualCues[2]!.startSec },
    ],
    expectedParagraphRange: [2, 2],
  },
  {
    slug: "07-latent-space-agents-whisper",
    title: "Deterministic Tool Schemas for Coding Agents",
    url: "https://latentspace.example.org/p/tool-schemas",
    kind: "podcast",
    language: "en",
    format: "whisper-verbose-json",
    scenario: "OpenAI / Groq Whisper verbose_json segments + >=1.5s acoustic pause paragraph break",
    mediaType: "application/json",
    rawTranscript: whisperVerboseJson,
    expectedChapters: [],
    probes: [
      { phrase: "Reliable tool-using agents depend", expectedSec: whisperCues[0]!.startSec },
      { phrase: "In our production traces, bounding", expectedSec: whisperCues[3]!.startSec },
    ],
    expectedParagraphRange: [2, 2],
  },
  {
    slug: "08-indie-podcast-sensevoice-vad",
    title: "无字幕独立播客的静音切片转写实测",
    url: "https://indie.example.org/episodes/vad-chunking",
    kind: "podcast",
    language: "zh",
    format: "vad-plain-asr",
    scenario: "Text-only ASR endpoint (SenseVoiceSmall / gpt-4o-transcribe) anchored via physical VAD chunk bounds",
    rawTranscript: vadPlainChunks,
    expectedChapters: [],
    probes: [
      { phrase: "独立播客往往没有官方时间轴字幕", expectedSec: 0 },
      { phrase: "当读者在文稿里划下一句重点笔记时", expectedSec: 29.8 },
    ],
    expectedParagraphRange: [2, 2],
    agentCleanup: {
      validMarkdown: [
        "## 静音切片与时间锚点",
        "",
        "[00:00] **主播**: 独立播客往往没有官方时间轴字幕，但通过客户端静音能量谷值切分音频流，依然可以把每段语音精准锚定在物理起止秒数之内。即使远端语音识别模型只返回纯文本字符串，分段时间戳也不会发生累积漂移。",
        "",
        "## 双重定位保护批注",
        "",
        "[00:29] **主播**: 当读者在文稿里划下一句重点笔记时，阅读器会同时保存文本前后缀定位器与对应的音频秒数区间。哪怕之后使用智能体重新润色标点和段落，原有的高亮依然能够稳稳落回对应的自然段。",
      ].join("\n"),
      highlightedRawQuote: "阅读器会同时保存文本前后缀定位器与对应的音频秒数区间",
      expectedRefinedSubstring: "阅读器会同时保存文本前后缀定位器",
      overSummarizedMarkdown: "[00:00] **主播**: 本集介绍了静音切片与双重定位。",
      nonMonotonicMarkdown:
        "[00:35] **主播**: 独立播客往往没有官方时间轴字幕，但通过客户端静音能量谷值切分音频流，依然可以把每段语音精准锚定在物理起止秒数之内。\n\n[00:10] **主播**: 当读者在文稿里划下一句重点笔记时，阅读器会同时保存文本前后缀定位器与对应的音频秒数区间。",
    },
  },
  {
    slug: "09-oxide-bmc-unpunctuated-asr",
    title: "Hubris and Static Task Isolation in Firmware",
    url: "https://oxide.example.org/podcasts/hubris-firmware",
    kind: "podcast",
    language: "en",
    format: "vtt",
    scenario: "220-word completely unpunctuated raw ASR stream split cleanly at >=0.4s acoustic valleys",
    mediaType: "text/vtt",
    rawTranscript: oxideVtt,
    expectedChapters: [],
    probes: [
      { phrase: "board management controllers sit on a tiny", expectedSec: oxideUnpunctuatedCues[0]!.startSec },
    ],
    expectedParagraphRange: [2, 3],
  },
  {
    slug: "10-radiolab-overlapping-vtt",
    title: "Claude Shannon and Channel Capacity",
    url: "https://radiolab.example.org/episodes/channel-capacity",
    kind: "podcast",
    language: "en",
    format: "vtt",
    scenario: "WebVTT inline karaoke <c> tags, HTML entities (&quot;/&amp;/&#39;), and ♪ music stripping",
    mediaType: "text/vtt",
    rawTranscript: radiolabVtt,
    expectedChapters: [],
    probes: [
      { phrase: 'When Claude Shannon published "A Mathematical Theory of Communication"', expectedSec: 2 },
      { phrase: "Wait 'til you hear how long it took hardware designers", expectedSec: 22 },
    ],
    expectedParagraphRange: [2, 2],
    forbiddenSubstrings: ["<c>", "&quot;", "&#39;", "♪", "[music]"],
  },
];
