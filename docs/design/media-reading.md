# 播客与视频的收集和阅读（2026-11-25）

一句话：**Quire 不做泛娱乐播客客户端或视频播放器，而是把值得精读的播客与视频变成同一张安静的页面。** 进同一个收件箱分拣，用同一套排版扫读逐字稿与关键帧，用同一支笔划线批注，在需要听原声或看白板推导时由轻量播放器伴随联动。

---

## 1. 目标与阅读合同延伸

90 分钟的对谈播客与 60 分钟的技术演讲，听完/看完耗时极长，而按章节扫读排版良好的文稿只需 15 分钟。把音视频纳入 Quire 的前提是不破坏现有阅读合同（R1–R8）：

| 合同 | 音视频上的定义 |
|---|---|
| **R1 本地与离线** | **文稿必落盘，媒体按需缓存**：逐字稿、Show notes、章节、封面与视频关键帧截图一律存本地，断网可读可搜；50 MB–1 GB 的音视频流默认流式播放，提供一键 `Keep offline` 下载至 `media/`。 |
| **R2 同一套排版** | 逐字稿与 Show notes 统一收敛为 `ReaderDocumentV2`，经 `ReaderDocumentSurface` 渲染为自然段、二级章节标题、说话人回合与 `<figure>` 插图，不引入第二套正文渲染器。 |
| **R3 全局阅读控制** | `Aa`（字体、字号、行宽、行距、Light / Paper / Dark）对逐字稿与 Show notes 完全生效；播放倍速按订阅源记忆。 |
| **R4 目录、进度、搜索** | 章节生成 `<h2>`，右侧刻度轨 `TocRail`（`t`）直接可用；`⌘F` 页内搜词即定位对应时间段落。 |
| **R5 位置记忆** | 独立记忆**文档滚动位置**与**媒体播放秒数**（`media_states` 表）；阅读进度 ≥ 95% 或播放进度 ≥ 90% 记入本周 `finished`。 |
| **R6 / R8 透明与不静默降级** | 顶部质量胶囊标明文稿来源：`publisher transcript` / `captions` / `auto captions` / `local whisper` / `cloud transcript` / `refined by agent` / `show notes only`；无字幕时第 0 秒先给 Show notes 与播放器，明示转写入口，绝不阻塞白屏。 |
| **R7 安全边界** | 渲染进程不直连第三方 CDN（防 Podtrac / Chartable 等播客追踪 Cookie 与指纹）；媒体流走主进程 `quire-media://` 代理，图片与关键帧走 `quire-image://`。 |

---

## 2. 同类产品调研与取舍

| 产品 | 核心做法 | Quire 借鉴 | Quire 不借鉴 |
|---|---|---|---|
| **Readwise Reader** | 视频与逐字稿联动、Enhanced Transcript 补标点分段、跟读漫游后一键归位 | 自然段重排（拒绝碎句字幕）；滚走自动停跟读 + `回到播放处` 按钮；划线与文章同权 | 用 `Space` 抢占翻页键；默认常驻大面积黑色视频窗挤压正文 |
| **Matter** | 播客转写为标准文章版心，听与读随时热切换 | 逐字稿与博客共用同一套排版与高亮体系 | 重移动端听歌队列与朗读万物 |
| **Podwise** | 底部单行伴随播放条、章节大纲、带 `?t=` 时间戳的 Markdown 引用导出 | 播放器退居底部单行伴随条；引用自动附带时间深链 | 预生成六七个摘要/脑图/QA Tab（在 Quire 里按需问 `⌘J` Agent） |
| **Vizle / Slid** | 视频画面跳变抽关键帧穿插进正文，支持抓帧入笔记 | 默认收起视频框，关键帧作为正文 `<figure>` 插图精读，点图再展开画框 | 把视频硬切成死板的 PPT 幻灯片列表 |
| **Apple Podcasts** | 页内搜词直接跳播对应秒数 | `⌘F` 搜词定位时间段 | 歌词式逐词跳动高亮与超大字号低密度排版 |
| **Memo AI / Substack** | Apple Silicon 本地离线转写；图文+播客混合帖双视图切换 | 本机 Whisper 离线优先；混合帖在同一材料下提供 `Article / Transcript` 视图（`v` 切换） | 时间轴字幕校对编辑器 |

---

## 3. 产品形态与交互设计

### 3.1 收集与分拣（复用 `⌘N` 与 `Inbox`）

1. **`⌘N` 一框探测（`AddSheet`）**：
   - **Podcast RSS / Apple Podcasts 节目页**：识别为播客订阅源，Apple 节目链接自动反查底层开放 RSS 入库。
   - **Apple Podcasts 单集（含 `?i=`） / YouTube 单视频**：主按钮 `Read episode` / `Read video`（`↵`），副按钮顺手提供 `Subscribe to <频道/节目>`。
   - **YouTube 频道（`/@handle`、`/channel/`）与播放列表**：转官方 Atom 订阅，默认开启 `Ignore Shorts (≤ 60s)` 过滤短视频噪音。
   - **含单集音频的专栏网页**（如 Substack 播客帖）：作为单个材料入库，同时登记 `web`（正文）与 `transcript`（播客逐字稿）视图。
2. **侧栏与列表**：
   - 侧栏 `LIBRARY` 增加 `Podcasts` 与 `Videos` 切面；`SOURCES` 照常显示健康点与未读数。
   - `Inbox` 右栏预览（不标已读）展示封面缩略图、媒体时长与预提取的**章节时间戳速览**，三键/四键分拣（`↵ / k / q / e`）完全不变。

### 3.2 阅读与伴随播放表面

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ 标题 · 节目/频道 · 38% · 1h 42m     [captions ▾] [Transcript|Notes] [t][i][✎][Aa][Ask] │
├──────────────────────────────────────────────────────────────────────────────┤
│   [视频材料可选展开 (m)：顶部限高同步画面框；默认收起，正文中内嵌关键帧插图]       │
│                                                                              │
│          ## Why Pre-training Scaling Changed Shape                     ▏     │
│                                                                        ┃     │
│   04:12  Dwarkesh Patel                                                ▏     │
│          Let's start with the obvious question everyone in the field…        │
│                                                                              │
│   04:38  Ilya Sutskever                                                      │
│        ┃ Pre-training as we knew it had one very special property:           │
│        ┃ compute grew faster than tokens, until the internet became finite.  │
│                                                                              │
│      ┌────────────────────────────────────────────────────────────────┐      │
│      │ [⏸] 04:51 / 1:42:10  ━━━●───────────  [-15s][+30s] [1.5×] [◎] [↓] │      │
│      └────────────────────────────────────────────────────────────────┘      │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **打开绝不自动出声**：默认安静阅读；点击页边时间戳、选区 `▶` 试听或底部播放键才出声。
- **Smart Follow（跟读不抢滚轮）**：播放时以柔和左线标记当前自然段并跟随滚动；一旦用户手动滚动视口阅读其他章节，立即暂停自动滚屏并浮现 `Jump to 04:51` 归位按钮。
- **跨材料后台续听（Sidebar `Now Playing`）**：正在播放播客时若切回 `Inbox` 或点开播客提及的库内论文，音频不断流，在侧栏底部（Settings 上方）浮现紧凑的 `Now Playing` 控制条，点击标题即回到当前播放段落。
- **键盘快捷键（零冲突）**：`Space` 始终保留给翻页阅读；媒体材料打开时绑定 `k`（播放/暂停）、`j` / `l`（后退 15s / 快进 30s，视频 ±10s）、`[` / `]`（倍速 ±0.25×）、`m`（展开/收起视频画框）、`v`（切换 `Transcript / Notes` 视图）。

---

## 4. 数据契约与存储布局

### 4.1 跨进程类型扩展（`apps/desktop/src/shared/contracts.ts` & `src-tauri/src/types.rs`）

```ts
export type SourceKind = "feed" | "arxiv" | "podcast" | "youtube";

export type SourceDetection =
  | { kind: "feed"; url: string; title?: string }
  | { kind: "podcast"; url: string; title?: string; siteUrl?: string }
  | { kind: "youtube"; url: string; channelId?: string; title?: string }
  | { kind: "arxiv"; category: string; title: string }
  | { kind: "page"; url: string; feed?: string }
  | { kind: "episode"; url: string; mediaKind: "audio" | "video"; title?: string; durationSec?: number; feed?: string };

export interface ItemSignals {
  code?: boolean;
  math?: boolean;
  figures?: boolean;
  lang?: string;
  media?: "audio" | "video";
  durationSec?: number;
  hasTranscript?: boolean;
  chapters?: { startSec: number; title: string }[];
}

export type MaterialKind =
  | "webpage" | "blogPost" | "newsletter" | "newsArticle"
  | "journalArticle" | "preprint" | "conferencePaper"
  | "book" | "bookSection" | "report" | "thesis" | "document"
  | "podcastEpisode" | "videoRecording"
  | "note";

export type CreatorRole = "author" | "editor" | "translator" | "contributor" | "host" | "guest";

export type MaterialViewId = "web" | "pdf" | "markdown" | "text" | "artifact" | "transcript" | "shownotes";

export type TranscriptOrigin =
  | "official"        // Podcasting 2.0 <podcast:transcript> 或网页自带文稿
  | "captions"        // 平台人工字幕轨
  | "auto_captions"   // 平台自动 ASR 字幕（无标点/碎句，提示可交由 Agent 重排）
  | "local_asr"       // 本机 Whisper 模型离线转写
  | "cloud_asr"       // OpenAI-compatible 远端/自建 ASR 接口转写
  | "agent_refined"   // 经 Agent 补标点、分段、识说话人（保留原始时间锚点）
  | "absent";         // 尚无逐字稿（先展示 Show notes + 播放器）

export interface MediaInfo {
  kind: "audio" | "video";
  provider: "podcast" | "youtube" | "web";
  streamUrl: string;
  videoId?: string;
  durationSec?: number;
  /** 本地已下载缓存的字节数（存在 <dataDir>/media/<id>.<ext> 时填充） */
  cachedBytes?: number;
  transcriptOrigin: TranscriptOrigin;
  chapters?: { startSec: number; title: string }[];
}

/** 逐字稿自然段到纯文本偏移与媒体秒数的双向映射表（同构于 PDF 的 TextViewAnchor） */
export interface TranscriptAnchor {
  paragraphIndex: number;
  /** 在 view.plain 中的起止字符偏移 */
  start: number;
  end: number;
  /** 媒体播放起止秒数 */
  startSec: number;
  endSec: number;
  speaker?: string;
}

// Annotation 新增可选时间区间（双锚点：text-quote:v2 + timeRange）
export interface Annotation {
  // ...既有字段不变
  timeRange?: [startSec: number, endSec: number];
}

// Settings 新增 ASR 与媒体配置
export type AsrProvider = "local" | "openai_compatible";

export interface AsrSettings {
  asrProvider: AsrProvider;
  /** OpenAI 兼容端点，如 https://api.groq.com/openai/v1、https://api.siliconflow.cn/v1 或 http://127.0.0.1:8000/v1 */
  asrBaseUrl: string;
  /** 模型标识，如 whisper-large-v3-turbo 或 FunAudioLLM/SenseVoiceSmall */
  asrModel: string;
  /** Key 存于系统钥匙串，仅回报布尔状态；连接 localhost 自建服务时允许无 Key */
  asrApiKeySet: boolean;
  /** 本机 Whisper 模型状态 */
  localWhisperModel: string;
  removeCachedMediaAfterFinish: boolean;
}
```

### 4.2 磁盘与 SQLite Schema v5 布局

```
<dataDir>/
 ├─ quire.sqlite                        # Schema v5：sources.config 列 + media_states 表
 ├─ materials/
 │   ├─ <id>.json                       # StoredRecord（含 media: MediaInfo）
 │   ├─ <id>.transcript.json            # MaterialViewContent（ReaderDocumentV2 + timeAnchors[]）
 │   ├─ <id>.transcript.raw.json        # 原始未润色 cues[{ startSec, endSec, text, speaker? }]
 │   └─ <id>.shownotes.json             # 创作者原始图文 Show notes 视图
 ├─ figures/<id>/frame-<ms>.jpg         # 视频关键帧截图（直接走现有 quire-image://figure/）
 ├─ media/<id>.<mp3|m4a|mp4>            # 可选离线媒体缓存（Settings › Storage 可一键清空）
 └─ models/<model>.bin                  # 本机离线 Whisper GGUF 模型
```

SQLite v5 迁移（`src-tauri/src/db.rs`）：
```sql
ALTER TABLE sources ADD COLUMN config TEXT NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS media_states (
  material_id TEXT PRIMARY KEY,
  position_sec REAL NOT NULL DEFAULT 0,
  duration_sec REAL,
  playback_speed REAL NOT NULL DEFAULT 1.0,
  updated_at TEXT NOT NULL
);
```

`StorageUsage` 增加 `media: u64` 与 `models: u64` 两项统计。

---

## 5. 五条核心技术管线

### 5.1 管线 A：来源探测、Apple Lookup 与 Feed 归一化

1. **Apple Podcasts 反查（零爬虫、保留区域码）**：
   解析 `https?://podcasts\.apple\.com/(?:([a-z]{2})/)?podcast/[^/]+/id(\d+)(?:\?.*?\bi=(\d+))?`：
   - **关键细节**：必须把 URL 中的地区码 `country`（如 `cn`、`jp`，缺省 `us`）透传给 `https://itunes.apple.com/lookup?id={cid}&country={cc}&entity=podcastEpisode&limit=200`，否则非美区独播节目会返回空结果。
   - 节目页直接取 `feedUrl` 按开放 Podcast RSS 订阅；单集页匹配 `trackId` 取得 `episodeUrl`（音频流）、`trackTimeMillis`、`description` 与所属 `feedUrl`。
2. **命名空间感知的 Feed 扩展（`@read/normalize`）**：
   在 `xml.ts` / `module.ts` 中解析：
   - RSS 2.0 `<enclosure>` + `itunes:duration / author / episode / image` + Podcasting 2.0 `podcast:transcript` / `podcast:chapters`；
   - YouTube Atom（`youtube.com/feeds/videos.xml?channel_id=...` 或 `playlist_id=...`）中的 `yt:videoId`、`yt:channelId`、`media:group > media:description`；
   - 从 Show notes / 视频描述中预提取递增时间戳行生成 `signals.chapters`，并剥离常见推广尾块再生成 `gist`。

### 5.2 管线 B：YouTube 字幕、Storyboard 关键帧与双层播放适配

1. **无 Key 元数据与字幕提取**：
   主进程请求视频页提取 `ytInitialPlayerResponse` JSON：
   - **字幕择优**：从 `captionTracks` 选择 `人工同语种 > 人工英/中 > 自动同语种 (kind="asr")`，拉取 `srv3`（含句与词偏移）或 `vtt` 字幕并存入 `<id>.transcript.raw.json`。
   - **章节提取**：优先读 `playerOverlays...macroMarkersListItemRenderer` 官方章节，回退读简介时间戳。
2. **双层播放与关键帧适配器（防签名轮换脆弱性）**：
   - **Tier 1（内置零外部依赖，默认）**：
     - **关键帧**：解析 `playerStoryboardSpecRenderer` 雪碧图规格（`$L` 层级、`$N` 页号、行列网格 `rows × cols`），按章节时间点下载对应拼板并在 Rust 中裁剪出单张帧存为 `figures/<id>/frame-<ms>.jpg`，正文中以 `quire-figure://<id>/frame-<ms>.jpg` 引用（`reader-document-v2-contract.ts` 已放行 `quire-figure:`，零 schema 改动）。
     - **伴随画框**：展开画框时挂载自定义协议 `quire-player://youtube/<videoId>` 受控子框架（内部仅加载无控件 `youtube-nocookie.com` IFrame API，由外部 `mediaStore` 通过 `postMessage` 驱动 `play / pause / seekTo / setPlaybackRate`）。
   - **Tier 2（本地增强模式，检测到本机 `yt-dlp` 时自动启用，也可在 Settings 指定路径，同 `codexPath`）**：
     - 解析原生音视频流交由 `quire-media://stream/<id>` 原生 `<video>` 播放，完整解锁**视频离线缓存**、**高清场景切换帧提取**以及**无字幕视频抽音轨本地转写**。

### 5.3 管线 C：逐字稿去重、自然段聚合与双锚点定位（`packages/normalize/src/transcript.ts`）

```
RawCue[] (VTT / SRT / Podcast JSON / srv3 / Whisper) + Chapter[]
  │
  ├─ 1. 滚动重叠消除：消除 YouTube 自动字幕相邻 cue 前后缀重复
  ├─ 2. 章节注入：在 Chapter.startSec 处插入 ReaderV2Heading (depth: 2, anchor: "t-<sec>")
  ├─ 3. 自然段状态机合并：
  │      - 换说话人 (speaker 改变) → 分段
  │      - 停顿间隔 ≥ 1.5s 且已满 40 词 (或 80 CJK 字) → 分段
  │      - 满 110–170 词 (或 220–340 CJK 字) 且遇句末标点 (. ? ! 。 ？ ！) → 分段
  │      - 无标点自动字幕兜底：连续 140 词无标点时取最大停顿处 (≥ 0.4s) 强制分段
  ├─ 4. 视频关键帧插入：章节起点插入 ReaderV2Figure (quire-figure://...)
  └─ 5. 输出：ReaderDocumentV2 + GFM Markdown (带 [MM:SS] 供 Agent 读) + plain + TranscriptAnchor[]
```

- **DOM 零污染渲染**：`ReaderView` 根据 `timeAnchors[paragraphIndex]` 在对应 `<p>` 旁通过 `aria-hidden="true"` 装饰槽绘制页边时间戳与说话人。`text-quote-selection.ts` 天然忽略 `aria-hidden="true"` 节点，复制、搜词、CSS Custom Highlight 完全复用现有代码。
- **双锚点回退**：保存划线时用选区在 `plain` 中的偏移反查 `TranscriptAnchor[]` 写入 `annotation.timeRange`。当后续逐字稿被 Agent 重排后，若 `text-quote` 精确匹配失效，用 `timeRange` 定位对应自然段做近似高亮。

### 5.4 管线 D：`quire-media://` Range 流式协议与全局 `mediaStore`

1. **协议与 CSP**：
   - `index.html` CSP 仅增量添加 `media-src 'self' blob: quire-media:;`（若用 Tier 1 视频框则 `frame-src quire-artifact: quire-player:;`）。
   - Rust 注册异步协议 `quire-media://stream/<materialId>`：
     - 若 `<dataDir>/media/<id>.<ext>` 已缓存：解析 `Range: bytes=start-end`，`File::seek` 读取对应区间返回 `206 Partial Content`，断网拖动进度条毫秒级响应；
     - 若未缓存：用无 Cookie 的 `reqwest::Client`（经 `assert_public_http_url` 校验每次重定向目标，阻断内网跳转）向上游转发 `Range` 请求并流式透传字节。
2. **渲染层 `mediaStore.ts`（`useSyncExternalStore` 单例）**：
   驻留于 `App.tsx` 顶层而非 `ReaderView` 内部，切视图（`v`）或切去读其他论文时不断流，每 5 秒及暂停/退出时将播放进度写入 `media_states` 表。

### 5.5 管线 E：通用 ASR 协议、静音切片兜底与 Agent 保锚重排

#### 1. 为什么采用“客户端静音切片（VAD Chunking）+ 双模 ASR 协议”？
主流 ASR 生态以 **OpenAI `/v1/audio/transcriptions`** 为事实标准（通吃 OpenAI、Groq、硅基流动 SiliconFlow、以及本机 Speaches / whisper.cpp / vLLM 等自建容器），但直接传整集播客会撞上两道裂痕：① **25 MB 单文件上限**；② **部分模型（如 `SenseVoiceSmall`、`gpt-4o-transcribe`）只回纯文本 `{"text"}` 不支持 `verbose_json` 时间戳**。

主进程 `src-tauri/src/transcribe.rs` 统一前置一层纯 Rust 音频预处理即可彻底抹平：

```
音频流 / 本地缓存
  ──▶ symphonia 进程内解码为 16kHz 单声道 PCM（零外部 ffmpeg 依赖）
  ──▶ RMS 能量谷值检测（在 30–60s 窗口的自然停顿 ≥ 350ms 处切分，硬上限 90s）
  ──▶ 产出带精确物理起止秒数的切片序列 Chunk[i] = { index, startSec, endSec, wavBytes }
        │
        ├─ 模式 1：Built-in Local（默认零配置）
        │    whisper-rs（开启 macOS Metal 加速）逐片推理 → 词/句级时间戳 + startSec 偏移
        │
        └─ 模式 2：OpenAI Compatible（配置 Base URL + API Key + Model，并发 3 workers）
             POST {asrBaseUrl}/audio/transcriptions
             - 优先请求 response_format="verbose_json"：取返回 segments[] + startSec 偏移；
             - 若端点不支持 verbose_json（报 400 或无 segments）：自动降级请求 response_format="json"，
               直接以该静音切片自身的物理 [chunk.startSec, chunk.endSec] 作为该段时间戳兜底！
```

- **安全隔离细节**：与网页抓取严格禁止私网地址不同，用户在 `Settings` 显式填写的 `asrBaseUrl` **允许 `http://localhost` / `127.0.0.1`**（且允许空 API Key），以便无缝对接本机运行的 Speaches / whisper.cpp / vLLM 服务；其余远端地址要求 `https://`，API Key 经 `KeychainAesEncryptor` 存 macOS 钥匙串。
- **流式边转边读**：`TranscriptionService` 维护后台任务注册表（对齐 `AgentService`），每完成 2 个切片即重新组装增量 `ReaderDocumentV2` 广播 `transcribe:event`，读者点下转写几秒内就能开始从头往下读。

#### 2. Agent 保锚书面化重排（`cleanup_transcript`）
对 `auto_captions` 或原始 ASR 初稿，点击 `Clean up with the agent` 在 `agent.rs` 启动受控任务：
- 工具 `transcript_read_raw` 分页提供带 `[MM:SS]` 的原始 cues 及标题、嘉宾、Show notes；
- 工具 `transcript_save_refined` 接收重排后的结构化文稿（`## 章节标题` + `[MM:SS] **Speaker**: 补全标点与专有名词后的自然段`）；
- **保存前硬护栏（借鉴 `artifact-review.ts`）**：
  1. 校验所有 `[MM:SS]` 单调递增且落在 `transcript.raw.json` 的真实时间轴内；
  2. 校验总词数与原字幕偏差在 **±20% 以内**（严防模型偷懒把逐字稿压缩成摘要，超出偏差即返回错误要求 Agent 完整重排）；
  3. 通过后写回 `<id>.transcript.json`（原始 `raw.json` 保留不动，随时可重跑或对勘）。

---

## 6. Tauri IPC 命令与事件清单

| 命令 / 事件 | 签名摘要 | 用途 |
|---|---|---|
| `media_state_get` / `media_state_save` | `(materialId) -> Option<MediaState>` / `(state) -> ()` | 读取与持久化播放进度、倍速 |
| `media_cache_download` / `media_cache_remove` | `(materialId) -> ()` | 下载单集媒体供离线播放 / 删除单集媒体缓存 |
| `media_cache_clear_all` | `() -> u64` | 清空 `media/` 目录释放磁盘（保留逐字稿与批注） |
| `event: media:cache:progress` | `{ materialId, downloadedBytes, totalBytes, phase }` | 离线缓存进度推送 |
| `transcribe_start` / `transcribe_cancel` | `(materialId, provider?) -> { jobId }` / `(materialId) -> ()` | 启动或取消后台转写任务 |
| `transcribe_jobs` | `() -> Vec<TranscribeJobSnapshot>` | 面板挂载时同步进行中的转写快照 |
| `event: transcribe:event` | `Preparing \| Progress \| Completed \| Failed` | 流式转写进度与增量上屏通知 |
| `asr_model_status` / `asr_model_download` | `() -> AsrModelStatus` / `(modelName) -> ()` | 查询与下载本机 Whisper GGUF 模型（含 SHA-256 校验） |
| `asr_test_connection` | `() -> Result<{ latencyMs, supportsVerboseJson }, String>` | Settings 中一键校验自定义 ASR 端点连通性与时间戳能力 |

---

## 7. 分刀落地计划

遵循 `docs/plan.md` 工作方式：先写引擎纯函数与单测，再补 `@read/ui` 原语与 Storybook 故事，最后接桌面端壳；每一刀独立可用、独立提交。

1. **第 1 刀：Feed 扩展与逐字稿自然段归一化引擎（`@read/normalize` + 契约）**
   - 实现 RSS `<enclosure>` / `itunes:*` / `<podcast:transcript>` / YouTube Atom 解析；实现 `transcript.ts`（VTT / SRT / Podcast JSON / `srv3` 解析、重叠消除、自然段聚合、章节标题生成、`TranscriptAnchor[]` 偏移表）；扩展 `contracts.ts` 与 `types.rs` 类型。
   - **验收**：双语、无标点自动字幕、多人对谈三类 fixture 100% 产出合法 `ReaderDocumentV2`，字符偏移与秒数零漂移。
2. **第 2 刀：Podcast RSS + Apple Podcasts 收集与伴随音频阅读器**
   - 实现 `detect_source` 播客与 Apple Lookup 探测、`quire-media://` HTTP 206 Range 流式代理与离线缓存、SQLite v5 `media_states`；实现全局 `mediaStore`、底部伴随播放条、侧栏 `Now Playing`、页边时间戳、Smart Follow、双锚点划线与带 `#t=` 引用导出。
   - **验收**：订阅播客或粘贴 Apple 单集即可分拣入库；`k / j / l` 播放穿梭、点字跳音、切去读论文不断流、断网可读可听已缓存单集。
3. **第 3 刀：YouTube 订阅与视频图文阅读视图**
   - 实现 YouTube 频道/播放列表订阅（默认过滤 Shorts）与单视频解析、字幕轨与章节拉取、Storyboard 关键帧裁剪入 `quire-figure://`、顶部可折叠伴随视频框（`m` 切换，Tier 1 `quire-player:` 沙箱 + Tier 2 `yt-dlp` 原生流）。
   - **验收**：打开技术演讲视频默认呈现“逐字稿 + 关键帧插图”干净文章页；点击插图或按 `m` 展开顶部同步画面。
4. **第 4 刀：通用 ASR 转写运行时（本机 Metal + OpenAI 兼容端点）与 Agent 书面化重排**
   - 实现 Rust `TranscriptionService`（`symphonia` 解码 + 静音切片 + `whisper-rs` Metal 本机推理 + `OpenAI Compatible` 并发客户端及物理时间兜底）；`Settings` ASR 配置、钥匙串加密、模型下载与 `Storage` 媒体缓存清理；Agent `cleanup_transcript` 保锚重排与词数护栏。
   - **验收**：无字幕独立播客边转边读；硅基流动 `SenseVoice`（纯文本）与 Groq `Whisper`（`verbose_json`）均能产出精确段落时间戳；粗糙字幕经 Agent 重排后原有划线不丢失。
5. **第 5 刀：音视频评测集（`eval/media/`）**
   - 收集 20 条真实播客与技术视频快照，自动化评测章节召回、段落长度分布、时间锚点误差（`< 0.5s`）与 Agent 重排保真度，接入现有质量报告基线。
