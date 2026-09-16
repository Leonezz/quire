export type ArticleSiteAdapterContext = Readonly<{
  document: Document;
  source: URL;
}>;

export type ArticleSiteAdapterApplication = Readonly<{
  key: string;
  version: string;
  content: string;
}>;

export interface ArticleSiteAdapter {
  readonly key: string;
  readonly version: string;
  apply(
    context: ArticleSiteAdapterContext,
  ): ArticleSiteAdapterApplication | undefined;
}

const TYPECHO_KEXUE_KEY = "typecho-kexue";
const TYPECHO_KEXUE_VERSION = "1";
const KEXUE_HOSTS = new Set(["kexue.fm", "www.kexue.fm"]);
const RFC_EDITOR_KEY = "rfc-editor-xml2rfc";
const RFC_EDITOR_VERSION = "1";
const RFC_EDITOR_HOSTS = new Set(["rfc-editor.org", "www.rfc-editor.org"]);

export function articleSiteAdapterRule(
  application: Pick<ArticleSiteAdapterApplication, "key" | "version">,
) {
  return `article.site-adapter.${application.key}@${application.version}`;
}

const typechoKexueAdapter: ArticleSiteAdapter = {
  key: TYPECHO_KEXUE_KEY,
  version: TYPECHO_KEXUE_VERSION,
  apply({ document, source }) {
    if (!KEXUE_HOSTS.has(source.host)) return undefined;

    const generators = document.querySelectorAll('meta[name="generator"]');
    if (generators.length !== 1) return undefined;
    const generator = generators[0]?.getAttribute("content")?.trim();
    if (!generator?.startsWith("Typecho")) return undefined;

    const postContents = document.querySelectorAll("#PostContent");
    if (postContents.length !== 1) return undefined;

    const clone = document.cloneNode(true) as Document;
    const clonedPostContents = clone.querySelectorAll("#PostContent");
    if (clonedPostContents.length !== 1) return undefined;
    const contentRoot = clonedPostContents[0];
    contentRoot
      .querySelectorAll("#content_tips, #pay")
      .forEach((element) => element.remove());

    return {
      key: typechoKexueAdapter.key,
      version: typechoKexueAdapter.version,
      content: contentRoot.outerHTML,
    };
  },
};

const rfcEditorAdapter: ArticleSiteAdapter = {
  key: RFC_EDITOR_KEY,
  version: RFC_EDITOR_VERSION,
  apply({ document, source }) {
    if (!RFC_EDITOR_HOSTS.has(source.host)) return undefined;
    const pathMatch = /^\/rfc\/rfc(\d+)\.html?$/iu.exec(source.pathname);
    if (!pathMatch) return undefined;

    const generators = document.querySelectorAll('meta[name="generator"]');
    const numbers = document.querySelectorAll('meta[name="rfc.number"]');
    const titles = document.querySelectorAll("h1#title");
    if (
      generators.length !== 1 ||
      !generators[0]?.getAttribute("content")?.trim().startsWith("xml2rfc ") ||
      numbers.length !== 1 ||
      numbers[0]?.getAttribute("content")?.trim() !== pathMatch[1] ||
      titles.length !== 1
    )
      return undefined;

    const clone = document.cloneNode(true) as Document;
    const body = clone.body;
    const clonedTitles = clone.querySelectorAll("h1#title");
    if (!body || clonedTitles.length !== 1) return undefined;
    body
      .querySelectorAll(
        "script, style, table.ears, #external-metadata, #internal-metadata, #rfcnum, #toc, .docInfo, a.pilcrow",
      )
      .forEach((element) => element.remove());

    return {
      key: rfcEditorAdapter.key,
      version: rfcEditorAdapter.version,
      content: `<article data-source-format="xml2rfc">${body.innerHTML}</article>`,
    };
  },
};

const ARTICLE_SITE_ADAPTERS: readonly ArticleSiteAdapter[] = [
  rfcEditorAdapter,
  typechoKexueAdapter,
];

export function applyArticleSiteAdapter(
  context: ArticleSiteAdapterContext,
): ArticleSiteAdapterApplication | undefined {
  for (const adapter of ARTICLE_SITE_ADAPTERS) {
    const application = adapter.apply(context);
    if (application) return application;
  }
  return undefined;
}
