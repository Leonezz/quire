declare module "katex/dist/katex.min.css";
declare module "*.css";
declare module "*.css?raw" {
  const source: string;
  export default source;
}
