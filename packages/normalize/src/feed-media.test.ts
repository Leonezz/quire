import { describe, expect, it } from "vitest";

import {
  extractDescriptionChapters,
  normalizeFeedCapture,
  parseDurationSeconds,
  sha256Hex,
  stripShowNotesBoilerplate,
} from "./index";

const BUDGET = {
  maxBytes: 2 * 1024 * 1024,
  maxDepth: 60,
  maxEntries: 50,
  maxEntryOutputBytes: 512 * 1024,
  maxNodes: 50_000,
  maxTotalOutputBytes: 4 * 1024 * 1024,
};

function captureOf(xml: string, url = "https://example.com/feed.xml") {
  const bytes = new TextEncoder().encode(xml);
  return {
    budget: BUDGET,
    capture: {
      baseLocator: url,
      bytes,
      contentIdentity: `sha256:${sha256Hex(bytes)}` as const,
      mediaType: "application/xml",
    },
  };
}

describe("feed-media normalization", () => {
  it("parses duration tokens in HH:MM:SS, MM:SS and integer seconds", () => {
    expect(parseDurationSeconds("01:42:10")).toBe(6130);
    expect(parseDurationSeconds("24:05")).toBe(1445);
    expect(parseDurationSeconds("3420")).toBe(3420);
    expect(parseDurationSeconds("0")).toBeUndefined();
    expect(parseDurationSeconds("invalid")).toBeUndefined();
  });

  it("extracts monotonic chapters from show notes and ignores incidental prose times", () => {
    const notes = `
      In this episode we talk about scaling laws and verifiers.
      00:00 Cold Open & Setup
      04:12 - Why Pre-training Scaling Changed Shape
      [18:40] Synthetic Data & Verifiable Reasoning
      1:02:05 Closing Thoughts
      Sponsored by Acme Cloud.
    `;
    expect(extractDescriptionChapters(notes)).toEqual([
      { startSec: 0, title: "Cold Open & Setup" },
      { startSec: 252, title: "Why Pre-training Scaling Changed Shape" },
      { startSec: 1120, title: "Synthetic Data & Verifiable Reasoning" },
      { startSec: 3725, title: "Closing Thoughts" },
    ]);

    expect(extractDescriptionChapters("We met at 14:30 to discuss the paper.")).toEqual([]);

    const gistSource = stripShowNotesBoilerplate(notes);
    expect(gistSource).toContain("In this episode we talk about scaling laws and verifiers.");
    expect(gistSource).not.toContain("04:12");
    expect(gistSource).not.toContain("Acme Cloud");
  });

  it("extracts podcast RSS enclosures, iTunes metadata, Podcasting 2.0 transcripts and chapters", () => {
    const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
  xmlns:podcast="https://podcastindex.org/namespace/1.0"
  xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Dwarkesh Podcast</title>
    <link>https://www.dwarkeshpatel.com</link>
    <description>Deep interviews on AI, history, and science.</description>
    <itunes:author>Dwarkesh Patel</itunes:author>
    <itunes:image href="https://cdn.example.com/show.jpg" />
    <item>
      <title>Ilya Sutskever — Post-Scaling</title>
      <link>https://www.dwarkeshpatel.com/p/ilya</link>
      <guid isPermaLink="false">ep-ilya-2026</guid>
      <pubDate>Wed, 25 Nov 2026 09:00:00 GMT</pubDate>
      <enclosure url="https://cdn.example.com/audio/ilya.mp3" length="98123456" type="audio/mpeg" />
      <itunes:duration>01:42:10</itunes:duration>
      <itunes:episode>88</itunes:episode>
      <itunes:season>3</itunes:season>
      <podcast:transcript url="https://cdn.example.com/subs/ilya.srt" type="application/x-subrip" language="en" />
      <podcast:transcript url="https://cdn.example.com/subs/ilya.json" type="application/json" language="en" />
      <podcast:chapters url="https://cdn.example.com/chapters/ilya.json" type="application/json+chapters" />
      <description><![CDATA[
        <p>Full conversation with Ilya Sutskever on synthetic reasoning.</p>
        <p>00:00 Intro<br/>04:12 Finite Internet Tokens<br/>18:40 Verifiers</p>
      ]]></description>
    </item>
  </channel>
</rss>`;

    const outcome = normalizeFeedCapture(captureOf(rss));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.feed.entries).toHaveLength(1);
    const entry = outcome.feed.entries[0]!;
    expect(entry.media).toEqual({
      author: "Dwarkesh Patel",
      byteLength: 98123456,
      chapters: [
        { startSec: 0, title: "Intro" },
        { startSec: 252, title: "Finite Internet Tokens" },
        { startSec: 1120, title: "Verifiers" },
      ],
      chaptersUrl: "https://cdn.example.com/chapters/ilya.json",
      durationSec: 6130,
      episode: 88,
      imageUrl: "https://cdn.example.com/show.jpg",
      kind: "audio",
      mediaType: "audio/mpeg",
      provider: "podcast",
      season: 3,
      streamUrl: "https://cdn.example.com/audio/ilya.mp3",
      transcripts: [
        { lang: "en", mediaType: "application/json", url: "https://cdn.example.com/subs/ilya.json" },
        { lang: "en", mediaType: "application/x-subrip", url: "https://cdn.example.com/subs/ilya.srt" },
      ],
    });
  });

  it("extracts YouTube Atom entries including yt:videoId, media:description gist and chapters", () => {
    const atom = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"
      xmlns:media="http://search.yahoo.com/mrss/"
      xmlns="http://www.w3.org/2005/Atom">
  <id>yt:channel:UCXUPKJO5MZQN11PqgIvyuvQ</id>
  <title>Andrej Karpathy</title>
  <link rel="alternate" href="https://www.youtube.com/channel/UCXUPKJO5MZQN11PqgIvyuvQ"/>
  <author><name>Andrej Karpathy</name></author>
  <updated>2026-11-24T20:00:00+00:00</updated>
  <entry>
    <id>yt:video:zduSFxRajkE</id>
    <yt:videoId>zduSFxRajkE</yt:videoId>
    <yt:channelId>UCXUPKJO5MZQN11PqgIvyuvQ</yt:channelId>
    <title>Let's build the GPT Tokenizer</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=zduSFxRajkE"/>
    <author><name>Andrej Karpathy</name></author>
    <published>2026-11-24T18:00:00+00:00</published>
    <updated>2026-11-24T20:00:00+00:00</updated>
    <media:group>
      <media:title>Let's build the GPT Tokenizer</media:title>
      <media:thumbnail url="https://i1.ytimg.com/vi/zduSFxRajkE/hqdefault.jpg" width="480" height="360"/>
      <media:description>Tokenization is at the heart of weirdness in LLMs.

00:00 Intro to Tokenization
06:50 Byte-Pair Encoding Algorithm
16:20 Python Indentation &amp; cl100k_base</media:description>
    </media:group>
  </entry>
</feed>`;

    const outcome = normalizeFeedCapture(
      captureOf(atom, "https://www.youtube.com/feeds/videos.xml?channel_id=UCXUPKJO5MZQN11PqgIvyuvQ"),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const entry = outcome.feed.entries[0]!;
    const selection = entry.materialization.representations.find((r) => r.purpose === "selection");
    expect(selection?.content).toContain("Tokenization is at the heart of weirdness in LLMs.");
    expect(entry.media).toEqual({
      author: "Andrej Karpathy",
      chapters: [
        { startSec: 0, title: "Intro to Tokenization" },
        { startSec: 410, title: "Byte-Pair Encoding Algorithm" },
        { startSec: 980, title: "Python Indentation & cl100k_base" },
      ],
      imageUrl: "https://i1.ytimg.com/vi/zduSFxRajkE/hqdefault.jpg",
      kind: "video",
      mediaType: "video/mp4",
      provider: "youtube",
      streamUrl: "https://www.youtube.com/watch?v=zduSFxRajkE",
      videoId: "zduSFxRajkE",
    });
  });

  it("leaves ordinary blog RSS entries without a media field", () => {
    const blog = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Plain Blog</title>
    <link>https://blog.example.com</link>
    <description>Essays</description>
    <item>
      <title>An Essay</title>
      <link>https://blog.example.com/essay</link>
      <description>Some prose without audio.</description>
    </item>
  </channel>
</rss>`;
    const outcome = normalizeFeedCapture(captureOf(blog));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.feed.entries[0]?.media).toBeUndefined();
  });
});
