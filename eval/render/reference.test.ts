import { describe, expect, it } from "vitest";
import { injectBase } from "./reference";

const URL = "https://example.com/blog/post/";

describe("injectBase", () => {
  it("puts the base first in an existing head", () => {
    expect(injectBase(`<!doctype html><html><head lang="en"><title>x</title></head><body></body></html>`, URL))
      .toBe(`<!doctype html><html><head lang="en"><base href="${URL}"><title>x</title></head><body></body></html>`);
  });

  it("does not mistake <header> for <head>", () => {
    expect(injectBase(`<html><body><header>h</header></body></html>`, URL)).toBe(`<html><head><base href="${URL}"></head><body><header>h</header></body></html>`);
  });

  it("creates a head after <html>, or after the doctype when there is no <html>", () => {
    expect(injectBase(`<html lang="en"><p>x</p></html>`, URL)).toBe(`<html lang="en"><head><base href="${URL}"></head><p>x</p></html>`);
    expect(injectBase(`<!DOCTYPE html><p>x</p>`, URL)).toBe(`<!DOCTYPE html><head><base href="${URL}"></head><p>x</p>`);
    expect(injectBase(`<p>x</p>`, URL)).toBe(`<head><base href="${URL}"></head><p>x</p>`);
  });

  it("resolves the page's own base against the final URL and replaces it", () => {
    const html = `<html><head><meta charset="utf-8"><base href="/assets/" target="_blank"><link href="a.css"></head></html>`;
    expect(injectBase(html, URL)).toBe(`<html><head><base href="https://example.com/assets/"><meta charset="utf-8"><link href="a.css"></head></html>`);
    expect(injectBase(`<head><base href='https://cdn.example.org/x/'></head>`, URL)).toBe(`<head><base href="https://cdn.example.org/x/"></head>`);
  });

  it("ignores a base without href and escapes the URL", () => {
    expect(injectBase(`<head><base target="_top"></head>`, URL)).toBe(`<head><base href="${URL}"></head>`);
    expect(injectBase(`<head></head>`, `https://e.com/?a=1&b="2"`)).toBe(`<head><base href="https://e.com/?a=1&amp;b=&quot;2&quot;"></head>`);
  });
});
