import type { Item } from "@read/core";

// Example data until the store lands. Marked as fixtures; never shown as the user's own.
export const items: Item[] = [
  { id: "a", sourceId: "srw", sourceTitle: "Systems Research Weekly · Mara Ilić", title: "Evaluation harnesses in the wild", gist: "Nine public harnesses and the assumptions each bakes in; most leak the test set through the prompt template.", publishedAt: "2026-09-16T09:12:00Z", readingMinutes: 8, signals: { code: true }, readState: "unread" },
  { id: "b", sourceId: "arxiv", sourceTitle: "arXiv cs.CL · Chen, Okafor, Ilić", title: "Position bias in retrieval-augmented evaluation", gist: "We measure how passage order shifts judged answer quality across 12 models and propose a debiasing protocol.", publishedAt: "2026-09-16T08:40:00Z", readingMinutes: 22, signals: { math: true, figures: true }, readState: "unread" },
  { id: "c", sourceId: "jxnl", sourceTitle: "jxnl.co", title: "Why long-context models still need retrieval", gist: "Cost, latency, and the failure modes that a bigger window does not fix.", publishedAt: "2026-09-16T07:55:00Z", readingMinutes: 11, signals: {}, readState: "unread" },
  { id: "d", sourceId: "ey", sourceTitle: "eugeneyan.com", title: "Fine-tuning is not what you think", gist: "Most fine-tuning wins in the wild are data cleaning wins. Three experiments to tell them apart.", publishedAt: "2026-09-16T07:30:00Z", readingMinutes: 9, signals: { code: true }, readState: "unread", introducedBy: "agent" },
  { id: "e", sourceId: "kexue", sourceTitle: "科学空间", title: "动量的新理解：逼近特征层面的梯度下降", gist: "把动量看成对特征空间梯度的近似，可以解释为什么它在宽网络上更稳。", publishedAt: "2026-09-16T06:01:00Z", readingMinutes: 14, signals: { math: true, lang: "zh" }, readState: "unread" },
  { id: "f", sourceId: "bsky", sourceTitle: "bsky.team", title: "Bluesky's Firehose, one year in", gist: "Only the feed summary is available; the full text is fetched when you open it.", publishedAt: "2026-09-16T05:20:00Z", readingMinutes: 4, signals: {}, readState: "unread", summaryOnly: true },
  { id: "g", sourceId: "srw", sourceTitle: "Systems Research Weekly", title: "The evaluation harness I actually use", gist: "Notes from a year of benchmarks: one script, one JSONL, one plot per claim.", publishedAt: "2026-09-15T22:14:00Z", readingMinutes: 6, signals: { code: true }, readState: "read" },
];

export function signalsOf(item: Item): string[] {
  const out: string[] = [];
  if (item.signals.code) out.push("code");
  if (item.signals.math) out.push("math");
  if (item.signals.figures) out.push("figures");
  if (item.signals.lang) out.push(item.signals.lang);
  return out;
}

export function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
