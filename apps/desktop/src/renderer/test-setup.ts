// Renderer test setup: what jsdom lacks and react-aria / the layout primitives reach for. A no-op under Node.
if (typeof window !== "undefined") {
  if (!("ResizeObserver" in window)) {
    class ResizeObserverStub { observe() { /* jsdom has no layout */ } unobserve() { /* nothing observed */ } disconnect() { /* nothing observed */ } }
    Object.defineProperty(window, "ResizeObserver", { value: ResizeObserverStub, configurable: true });
  }
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", { configurable: true, value: (query: string) => ({ matches: false, media: query, onchange: null, addListener() { /* legacy */ }, removeListener() { /* legacy */ }, addEventListener() { /* unused */ }, removeEventListener() { /* unused */ }, dispatchEvent: () => false }) });
  }
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => undefined;
  // react-aria's collections escape their ids with CSS.escape, which jsdom does not ship.
  const css = (window as unknown as { CSS?: { escape?: (value: string) => string } }).CSS;
  if (!css?.escape) Object.defineProperty(window, "CSS", { configurable: true, value: { ...(css ?? {}), escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`) } });
}
