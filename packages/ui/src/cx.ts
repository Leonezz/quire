// Tiny class joiner; React Aria passes render-prop classNames through composeRenderProps.
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
