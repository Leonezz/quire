import { describe, expect, it } from "vitest";
import { approximateQuoteMatch } from "./approximate-quote";

// The matcher works on canonical (whitespace-free) text, as the resolver hands it over.
const canonical = (value: string) => value.replace(/\s+/g, "");

describe("approximate quote match", () => {
  it("re-places a quote whose sentence had one word changed", () => {
    const quote = canonical("The cache keeps every response for an hour before it asks again.");
    const text = canonical("Intro text. The cache keeps every response for a day before it asks again. Outro text.");
    const match = approximateQuoteMatch(text, quote, { prefix: canonical("Intro text."), suffix: canonical("Outro text.") });
    expect(match).toBeDefined();
    expect(text.slice(match!.start, match!.end)).toBe(canonical("The cache keeps every response for a day before it asks again."));
  });

  it("never places a quote on unrelated text", () => {
    const quote = canonical("The cache keeps every response for an hour before it asks again.");
    const text = canonical("A different article about gardening, soil, and the slow work of compost.");
    expect(approximateQuoteMatch(text, quote, { prefix: "", suffix: "" })).toBeUndefined();
  });

  it("does not stretch past one edit in eight characters", () => {
    const quote = canonical("conditional requests for cache validation");
    // Nine of the 37 characters differ: closer to a rewrite than an edit.
    const text = canonical("Before. unconditional replies for page invalidations. After.");
    expect(approximateQuoteMatch(text, quote, { prefix: "Before.", suffix: "After." })).toBeUndefined();
  });

  it("leaves a quote of fewer than eight characters to the exact pass", () => {
    expect(approximateQuoteMatch("theprotocolusesconditional", "protocl", { prefix: "the", suffix: "uses" })).toBeUndefined();
  });

  it("places a short quote only where its context still agrees", () => {
    const quote = canonical("See Section 3.2");
    const elsewhere = canonical("Unrelated lead-in. See Section 3.1 for the rest.");
    expect(approximateQuoteMatch(elsewhere, quote, { prefix: canonical("as described below."), suffix: canonical("for details on caching") })).toBeUndefined();
    const inPlace = canonical("as described below. See Section 3.4 for details on caching");
    const match = approximateQuoteMatch(inPlace, quote, { prefix: canonical("as described below."), suffix: canonical("for details on caching") });
    expect(match && inPlace.slice(match.start, match.end)).toBe(canonical("See Section 3.4"));
  });

  it("lets the stored context choose between equally close candidates", () => {
    const quote = canonical("the request is retried after a short backoff");
    const text = canonical("Reads: the request is retried after a shorter backoff, then fails. Writes: the request is retried after a shorter backoff, then succeeds.");
    const match = approximateQuoteMatch(text, quote, { prefix: "Writes:", suffix: ",thensucceeds." });
    expect(match).toBeDefined();
    expect(match!.start).toBe(text.lastIndexOf(canonical("the request is retried")));
  });

  it("gives up when candidates cannot be told apart", () => {
    const quote = canonical("the request is retried after a short backoff");
    const text = canonical("A: the request is retried after a shorter backoff. B: the request is retried after a shorter backoff.");
    expect(approximateQuoteMatch(text, quote, { prefix: "", suffix: "" })).toBeUndefined();
  });

  it("uses the captured position to break a tie in context", () => {
    const quote = canonical("the request is retried after a short backoff");
    const text = canonical("A: the request is retried after a shorter backoff. B: the request is retried after a shorter backoff.");
    const second = text.lastIndexOf("therequest");
    const match = approximateQuoteMatch(text, quote, { prefix: "", suffix: "", position: second });
    expect(match?.start).toBe(second);
  });

  it("stays fast on a long article with a long edited quote", () => {
    const sentence = (index: number) => `Paragraph ${index} talks about topic ${index * 7919 % 1000} at some length.`;
    const text = canonical(Array.from({ length: 2500 }, (_, index) => sentence(index)).join(" "));
    expect(text.length).toBeGreaterThan(100_000);
    const original = canonical(Array.from({ length: 40 }, (_, index) => sentence(1200 + index)).join(" "));
    const quote = original.replace("topic", "subject");
    const started = performance.now();
    const match = approximateQuoteMatch(text, quote, { prefix: canonical(sentence(1199)).slice(-32), suffix: canonical(sentence(1240)).slice(0, 32) });
    const elapsed = performance.now() - started;
    expect(match?.start).toBe(text.indexOf(canonical(sentence(1200))));
    expect(elapsed).toBeLessThan(1000);
  });
});
