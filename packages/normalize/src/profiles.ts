import type { ProducerDetection, ProducerEvidence } from "./model";
import { ATOM_NAMESPACE, attribute, child, text, type XmlNode } from "./xml";

type ProfileMatch = ProducerDetection & { score: number };

function evidence(field: string, value: string, strength: ProducerEvidence["strength"] = "strong"): ProducerEvidence {
  return { field, strength, value };
}

function generatorFacts(feed: XmlNode) {
  const generator = child(feed, "generator", feed.namespaceUri === ATOM_NAMESPACE ? ATOM_NAMESPACE : "");
  return {
    text: text(generator),
    uri: generator ? attribute(generator, "uri") ?? "" : "",
    version: generator ? attribute(generator, "version") ?? "" : "",
  };
}

function match(key: string, version: string, values: ProducerEvidence[], score = 100): ProfileMatch {
  return { evidence: values, key, score, version };
}

export function detectProducer(feed: XmlNode, dialect: "atom" | "rss"): ProducerDetection {
  const generator = generatorFacts(feed);
  const candidates: ProfileMatch[] = [];

  if (
    dialect === "atom" &&
    generator.text === "WordPress" &&
    /^https?:\/\/wordpress\.org\/?$/u.test(generator.uri) &&
    /^[\w.-]{1,64}$/u.test(generator.version)
  ) {
    candidates.push(match("wordpress", "1", [
      evidence("feed.generator.text", generator.text),
      evidence("feed.generator.uri", generator.uri),
      evidence("feed.generator.version", generator.version),
    ]));
  } else if (dialect === "rss" && /^https?:\/\/wordpress\.org\/\?v=[\w.-]{1,64}$/u.test(generator.text)) {
    candidates.push(match("wordpress", "1", [evidence("feed.generator", generator.text)]));
  }
  if (dialect === "rss" && /^Ghost [\w.-]{1,64}$/u.test(generator.text)) {
    candidates.push(match("ghost", "1", [evidence("feed.generator", generator.text)]));
  }
  if (dialect === "rss" && generator.text === "Substack") {
    candidates.push(match("substack", "1", [evidence("feed.generator", generator.text)]));
  }
  if (dialect === "rss" && generator.text === "Medium") {
    candidates.push(match("medium", "1", [evidence("feed.generator", generator.text)]));
  }
  if (dialect === "rss" && (generator.text === "Hugo" || /^Hugo [\w.-]{1,64}$/u.test(generator.text) || generator.text === "Hugo -- gohugo.io")) {
    candidates.push(match("hugo", "1", [evidence("feed.generator", generator.text)]));
  }
  if (
    dialect === "atom" &&
    generator.text === "Jekyll" &&
    /^https:\/\/jekyllrb\.com\/?$/u.test(generator.uri) &&
    /^[\w.-]{1,64}$/u.test(generator.version)
  ) {
    candidates.push(match("jekyll-feed", "1", [
      evidence("feed.generator.text", generator.text),
      evidence("feed.generator.uri", generator.uri),
      evidence("feed.generator.version", generator.version),
    ]));
  }
  if (dialect === "rss" && generator.text === "Hexo") {
    candidates.push(match("hexo", "1", [evidence("feed.generator", generator.text)]));
  } else if (dialect === "atom" && generator.text === "Hexo" && /^https?:\/\/hexo\.io\/?$/u.test(generator.uri)) {
    candidates.push(match("hexo", "1", [evidence("feed.generator.text", generator.text), evidence("feed.generator.uri", generator.uri)]));
  }

  candidates.sort((left, right) => right.score - left.score || left.key.localeCompare(right.key));
  const winner = candidates[0];
  if (!winner || (candidates[1] && candidates[1].score === winner.score && candidates[1].key !== winner.key)) {
    return { evidence: [], key: "generic", version: "1" };
  }
  return { evidence: winner.evidence, key: winner.key, version: winner.version };
}

export function rssDescriptionRole(producerKey: string): "ambiguous" | "summary" {
  return ["ghost", "hexo", "hugo", "medium", "substack", "wordpress"].includes(producerKey) ? "summary" : "ambiguous";
}
