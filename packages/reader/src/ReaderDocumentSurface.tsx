import {
  createContext,
  Fragment,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { safeExternalUrl } from "./external-url";
import { MathFormula } from "./MathFormula";
import type {
  ReaderDocumentV1,
  ReaderDocumentV2,
  ReaderNode,
  ReaderV2FlowNode,
  ReaderV2FootnoteDefinition,
  ReaderV2FootnoteReference,
  ReaderV2PhrasingNode,
  ReaderV2Table,
  ReaderV2TableCell,
  ReaderV2TableRow,
  ReaderV2TableSection,
} from "./model";
import { resolveReaderDocument } from "./registry";
import { RichCodeBlock } from "./RichCodeBlock";

export type ReaderFallback = {
  content: string;
  format: "gfm" | "plain";
};

export type ReaderDocumentSurfaceProps = {
  fallbackLabel?: string;
  fallback: ReaderFallback;
  imageSourceFor?: (sourceUrl: string) => string | undefined;
  onOpenLink?: (url: string) => void;
  payload: unknown;
  resolveImageSource?: (
    sourceUrl: string,
    signal: AbortSignal,
  ) => Promise<string | undefined>;
  resolveRemoteImageSource?: (
    sourceUrl: string,
    signal: AbortSignal,
  ) => Promise<string | undefined>;
  schema: string;
  showFallbackNotice?: boolean;
};

type ReaderImageBudget = {
  acceptedSources: Map<string, string>;
  retainedCharacters: number;
  requestedUrls: Set<string>;
};

type ReaderHostPolicy = Pick<
  ReaderDocumentSurfaceProps,
  | "imageSourceFor"
  | "onOpenLink"
  | "resolveImageSource"
  | "resolveRemoteImageSource"
> & { imageBudget?: ReaderImageBudget };

const ReaderHostPolicyContext = createContext<ReaderHostPolicy>({});

const MAX_IMAGE_CACHE_ENTRIES = 64;
const MAX_IMAGE_CACHE_CHARACTERS = 32_000_000;
const MAX_OWNED_IMAGE_SOURCE_CHARACTERS = 12_000_000;
// Images come from the host's local cache (data URLs), so a long, picture-heavy article may ask for all of them.
// Hosts (and tests) may lower these.
export const readerImageLimits = { maxRequestsPerSurface: 400, maxPendingRequests: 400 };
const MAX_RETAINED_IMAGE_CHARACTERS_PER_SURFACE = 24_000_000;
const MAX_CONCURRENT_IMAGE_REQUESTS = 6;
const IMAGE_REQUEST_TIMEOUT_MS = 15_000;
type ImageResolver = NonNullable<
  ReaderDocumentSurfaceProps["resolveImageSource"]
>;
const imageCaches = new WeakMap<ImageResolver, Map<string, string>>();
type InFlightImageResolution = {
  consumers: number;
  controller: AbortController;
  promise: Promise<string | undefined>;
};
const inFlightImageResolutions = new WeakMap<
  ImageResolver,
  Map<string, InFlightImageResolution>
>();
type QueuedImageRequest = {
  run: () => void;
};
const queuedImageRequests: QueuedImageRequest[] = [];
let activeImageRequests = 0;
let imageRequestPumpScheduled = false;

function ownedImageSource(source: string | undefined) {
  if (!source) return undefined;
  if (source.startsWith("blob:")) return source;
  if (source.length > MAX_OWNED_IMAGE_SOURCE_CHARACTERS) return undefined;
  if (
    /^data:image\/(?:avif|gif|jpeg|png|webp);base64,[a-z\d+/=\s]+$/i.test(
      source,
    )
  ) {
    return source;
  }
  return undefined;
}

function cacheFor(resolver: ImageResolver) {
  let cache = imageCaches.get(resolver);
  if (!cache) {
    cache = new Map();
    imageCaches.set(resolver, cache);
  }
  return cache;
}

function cacheImageSource(
  resolver: ImageResolver,
  sourceUrl: string,
  resolvedSource: string,
) {
  const cache = cacheFor(resolver);
  cache.delete(sourceUrl);
  cache.set(sourceUrl, resolvedSource);
  let cachedCharacters = Array.from(cache.values()).reduce(
    (total, source) => total + source.length,
    0,
  );
  while (
    cache.size > MAX_IMAGE_CACHE_ENTRIES ||
    cachedCharacters > MAX_IMAGE_CACHE_CHARACTERS
  ) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cachedCharacters -= cache.get(oldest)?.length ?? 0;
    cache.delete(oldest);
  }
}

function reserveImageRequest(
  budget: ReaderImageBudget | undefined,
  sourceUrl: string,
) {
  if (!budget || budget.requestedUrls.has(sourceUrl)) return true;
  if (budget.requestedUrls.size >= readerImageLimits.maxRequestsPerSurface) return false;
  budget.requestedUrls.add(sourceUrl);
  return true;
}

function retainImageSource(
  budget: ReaderImageBudget | undefined,
  sourceUrl: string,
  source: string,
) {
  if (!budget) return true;
  const retained = budget.acceptedSources.get(sourceUrl);
  if (retained === source) return true;
  const nextCharacters =
    budget.retainedCharacters - (retained?.length ?? 0) + source.length;
  if (nextCharacters > MAX_RETAINED_IMAGE_CHARACTERS_PER_SURFACE) return false;
  budget.acceptedSources.set(sourceUrl, source);
  budget.retainedCharacters = nextCharacters;
  return true;
}

function pumpImageRequests() {
  while (
    activeImageRequests < MAX_CONCURRENT_IMAGE_REQUESTS &&
    queuedImageRequests.length > 0
  ) {
    const request = queuedImageRequests.shift();
    request?.run();
  }
}

function scheduleImageRequestPump() {
  if (imageRequestPumpScheduled) return;
  imageRequestPumpScheduled = true;
  queueMicrotask(() => {
    imageRequestPumpScheduled = false;
    pumpImageRequests();
  });
}

function enqueueImageRequest(
  signal: AbortSignal,
  request: () => Promise<string | undefined>,
  onTimeout: () => void,
) {
  if (signal.aborted) {
    return Promise.reject(new Error("READER_IMAGE_REQUEST_ABORTED"));
  }
  if (
    activeImageRequests + queuedImageRequests.length >=
    readerImageLimits.maxPendingRequests
  ) {
    return Promise.reject(new Error("READER_IMAGE_QUEUE_FULL"));
  }

  return new Promise<string | undefined>((resolve, reject) => {
    let state: "queued" | "running" | "settled" = "queued";
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const queuedRequest: QueuedImageRequest = {
      run() {
        if (state !== "queued") return;
        state = "running";
        activeImageRequests += 1;
        if (signal.aborted) {
          settle({
            error: new Error("READER_IMAGE_REQUEST_ABORTED"),
            status: "rejected",
          });
          return;
        }
        timeout = setTimeout(() => {
          settle({
            error: new Error("READER_IMAGE_REQUEST_TIMED_OUT"),
            status: "rejected",
          });
          onTimeout();
        }, IMAGE_REQUEST_TIMEOUT_MS);
        let requestPromise: Promise<string | undefined>;
        try {
          requestPromise = request();
        } catch (error) {
          settle({ error, status: "rejected" });
          return;
        }
        void requestPromise.then(
          (value) => settle({ status: "resolved", value }),
          (error: unknown) => settle({ error, status: "rejected" }),
        );
      },
    };

    function removeQueuedRequest() {
      const index = queuedImageRequests.indexOf(queuedRequest);
      if (index >= 0) queuedImageRequests.splice(index, 1);
    }

    function settle(
      outcome:
        | { status: "resolved"; value: string | undefined }
        | { error: unknown; status: "rejected" },
    ) {
      if (state === "settled") return;
      const wasRunning = state === "running";
      if (state === "queued") removeQueuedRequest();
      state = "settled";
      if (timeout !== undefined) clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      if (wasRunning) activeImageRequests -= 1;
      if (outcome.status === "resolved") resolve(outcome.value);
      else reject(outcome.error);
      scheduleImageRequestPump();
    }

    function abort() {
      settle({
        error: new Error("READER_IMAGE_REQUEST_ABORTED"),
        status: "rejected",
      });
    }

    signal.addEventListener("abort", abort, { once: true });
    queuedImageRequests.push(queuedRequest);
    pumpImageRequests();
  });
}

function acquireImageResolution(resolver: ImageResolver, sourceUrl: string) {
  let resolutions = inFlightImageResolutions.get(resolver);
  if (!resolutions) {
    resolutions = new Map();
    inFlightImageResolutions.set(resolver, resolutions);
  }
  let resolution = resolutions.get(sourceUrl);
  if (!resolution) {
    const controller = new AbortController();
    const nextResolution = {
      consumers: 0,
      controller,
      promise: Promise.resolve(undefined) as Promise<string | undefined>,
    } satisfies InFlightImageResolution;
    nextResolution.promise = enqueueImageRequest(
      controller.signal,
      () => resolver(sourceUrl, controller.signal),
      () => controller.abort(),
    )
      .then((result) => {
        return ownedImageSource(result);
      })
      .finally(() => {
        if (resolutions?.get(sourceUrl) === nextResolution) {
          resolutions.delete(sourceUrl);
        }
      });
    resolution = nextResolution;
    resolutions.set(sourceUrl, resolution);
  }
  resolution.consumers += 1;
  let released = false;
  return {
    promise: resolution.promise,
    release() {
      if (released) return;
      released = true;
      resolution.consumers -= 1;
      if (resolution.consumers === 0) {
        resolution.controller.abort();
        if (resolutions?.get(sourceUrl) === resolution) {
          resolutions.delete(sourceUrl);
        }
      }
    },
  };
}

function HostLink({
  children,
  targetAnchor,
  title,
  url,
}: {
  children: ReactNode;
  targetAnchor?: string | null;
  title?: string;
  url: string;
}) {
  const { onOpenLink } = useContext(ReaderHostPolicyContext);
  const footnoteIndex = useContext(FootnoteIndexContext);
  if (targetAnchor) {
    const targetId = readerAnchorId(footnoteIndex.namespace, targetAnchor);
    return (
      <a
        className="reader-document-link"
        data-reader-link-anchor={targetAnchor}
        href={`#${targetId}`}
        title={title}
      >
        {children}
      </a>
    );
  }
  const externalUrl = safeExternalUrl(url);

  if (!externalUrl) {
    return <span data-reader-link="blocked">{children}</span>;
  }

  return (
    <a
      className="reader-document-link"
      data-reader-link={externalUrl}
      href={externalUrl}
      onClick={(event) => {
        if (
          !onOpenLink ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        onOpenLink(externalUrl);
      }}
      rel="noreferrer"
      target="_blank"
      title={title}
    >
      {children}
    </a>
  );
}

function HostImage({
  alt,
  sourceUrl,
  title,
}: {
  alt: string;
  sourceUrl: string;
  title?: string;
}) {
  const {
    imageBudget,
    imageSourceFor,
    resolveImageSource,
    resolveRemoteImageSource,
  } = useContext(ReaderHostPolicyContext);
  const [remoteRequest, setRemoteRequest] = useState({
    attempt: 0,
    generation: imageBudget,
    sourceUrl,
  });
  const automaticRemoteAttempt = resolveRemoteImageSource ? 1 : 0;
  const remoteAttempt =
    remoteRequest.generation === imageBudget &&
    remoteRequest.sourceUrl === sourceUrl
      ? Math.max(remoteRequest.attempt, automaticRemoteAttempt)
      : automaticRemoteAttempt;
  const activeResolver =
    remoteAttempt > 0 && resolveRemoteImageSource
      ? resolveRemoteImageSource
      : resolveImageSource;
  let synchronousCandidate: string | undefined;
  try {
    synchronousCandidate = ownedImageSource(imageSourceFor?.(sourceUrl));
  } catch {
    synchronousCandidate = undefined;
  }
  const synchronousSource =
    synchronousCandidate &&
    retainImageSource(imageBudget, sourceUrl, synchronousCandidate)
      ? synchronousCandidate
      : undefined;

  const cachedCandidate = activeResolver
    ? cacheFor(activeResolver).get(sourceUrl)
    : undefined;
  const cachedSource =
    cachedCandidate &&
    retainImageSource(imageBudget, sourceUrl, cachedCandidate)
      ? cachedCandidate
      : undefined;
  const [resolution, setResolution] = useState<{
    resolver?: ReaderDocumentSurfaceProps["resolveImageSource"];
    source?: string;
    sourceUrl: string;
    status: "loading" | "resolved" | "unresolved";
  }>(() => ({
    resolver: activeResolver,
    sourceUrl,
    status: activeResolver ? "loading" : "unresolved",
  }));
  const asynchronousSource =
    resolution.resolver === activeResolver && resolution.sourceUrl === sourceUrl
      ? resolution.source
      : undefined;
  const resolvedSource =
    synchronousSource ?? cachedSource ?? asynchronousSource;
  const imageMeaning =
    Array.from(new Set([alt.trim(), title?.trim() ?? ""].filter(Boolean))).join(
      " — ",
    ) || "untitled image";

  useEffect(() => {
    if (synchronousSource || cachedSource || !activeResolver) return;
    if (!reserveImageRequest(imageBudget, sourceUrl)) {
      setResolution({
        resolver: activeResolver,
        sourceUrl,
        status: "unresolved",
      });
      return;
    }
    const request = acquireImageResolution(activeResolver, sourceUrl);
    let subscribed = true;
    setResolution({ resolver: activeResolver, sourceUrl, status: "loading" });
    void request.promise
      .then((safeResult) => {
        if (!subscribed) return;
        if (
          !safeResult ||
          !retainImageSource(imageBudget, sourceUrl, safeResult)
        ) {
          setResolution({
            resolver: activeResolver,
            sourceUrl,
            status: "unresolved",
          });
          return;
        }
        cacheImageSource(activeResolver, sourceUrl, safeResult);
        setResolution({
          resolver: activeResolver,
          source: safeResult,
          sourceUrl,
          status: "resolved",
        });
      })
      .catch(() => {
        if (subscribed) {
          setResolution({
            resolver: activeResolver,
            sourceUrl,
            status: "unresolved",
          });
        }
      });
    return () => {
      subscribed = false;
      request.release();
    };
  }, [
    activeResolver,
    cachedSource,
    imageBudget,
    remoteAttempt,
    sourceUrl,
    synchronousSource,
  ]);

  if (!resolvedSource) {
    const status =
      activeResolver &&
      (resolution.resolver !== activeResolver ||
        resolution.sourceUrl !== sourceUrl ||
        resolution.status === "loading")
        ? "loading"
        : "unresolved";
    return (
      <span
        aria-busy={status === "loading" ? "true" : undefined}
        data-reader-image={status}
        title={title}
      >
        <span aria-label={imageMeaning} role="img">
          {alt ||
            (status === "loading" ? "Loading image" : "Image unavailable")}
        </span>
        {status === "unresolved" && resolveRemoteImageSource ? (
          <button
            aria-label={`${remoteAttempt > 0 ? "Retry remote image" : "Load remote image"}: ${imageMeaning}`}
            data-reader-load-remote-image=""
            onClick={() =>
              setRemoteRequest({
                attempt: remoteAttempt + 1,
                generation: imageBudget,
                sourceUrl,
              })
            }
            title="Connects to the source once, then pins the image to this article version."
            type="button"
          >
            {remoteAttempt > 0 ? "Retry remote image" : "Load remote image"}
          </button>
        ) : null}
      </span>
    );
  }

  return (
    <img
      alt={alt}
      data-reader-image="resolved"
      decoding="async"
      loading="lazy"
      referrerPolicy="no-referrer"
      src={resolvedSource}
      title={title}
    />
  );
}

function ReaderChildren({ children }: { children: ReaderNode[] }) {
  return children.map((node, index) => (
    <ReaderNodeView key={index} node={node} />
  ));
}

function compactAccessibleMeaning(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 180);
}

function tableRegionName(meaning: string) {
  const compactMeaning = compactAccessibleMeaning(meaning);
  return compactMeaning
    ? `Scrollable table: ${compactMeaning}`
    : "Scrollable table";
}

function readerNodeText(node: ReaderNode): string {
  switch (node.type) {
    case "text":
    case "inlineCode":
      return node.value;
    case "image":
      return node.alt || node.title || "";
    case "break":
      return " ";
    case "code":
    case "thematicBreak":
      return "";
    case "heading":
    case "paragraph":
    case "emphasis":
    case "strong":
    case "delete":
    case "link":
    case "blockquote":
    case "list":
    case "listItem":
    case "table":
    case "tableRow":
    case "tableCell":
      return node.children.map(readerNodeText).join(" ");
  }
}

function ReaderTable({
  node,
}: {
  node: Extract<ReaderNode, { type: "table" }>;
}) {
  const [heading, ...body] = node.children;
  const meaning =
    heading?.type === "tableRow"
      ? heading.children
          .filter((cell) => cell.type === "tableCell")
          .map((cell) => cell.children.map(readerNodeText).join(" "))
          .join(" / ")
      : "";

  function row(rowNode: ReaderNode, header: boolean): ReactNode {
    if (rowNode.type !== "tableRow") return null;
    return (
      <tr>
        {rowNode.children.map((cell, index) => {
          if (cell.type !== "tableCell") return null;
          return header ? (
            <th key={index} scope="col">
              <ReaderChildren children={cell.children} />
            </th>
          ) : (
            <td key={index}>
              <ReaderChildren children={cell.children} />
            </td>
          );
        })}
      </tr>
    );
  }

  return (
    <div
      aria-label={tableRegionName(meaning)}
      className="reader-document-table"
      role="region"
      tabIndex={0}
    >
      <table>
        {heading ? <thead>{row(heading, true)}</thead> : null}
        {body.length > 0 ? (
          <tbody>
            {body.map((rowNode, index) => (
              <Fragment key={index}>{row(rowNode, false)}</Fragment>
            ))}
          </tbody>
        ) : null}
      </table>
    </div>
  );
}

function ReaderNodeView({ node }: { node: ReaderNode }): ReactNode {
  switch (node.type) {
    case "text":
      return node.value;
    case "heading": {
      const children = <ReaderChildren children={node.children} />;
      if (node.depth === 1) return <h1>{children}</h1>;
      if (node.depth === 2) return <h2>{children}</h2>;
      if (node.depth === 3) return <h3>{children}</h3>;
      if (node.depth === 4) return <h4>{children}</h4>;
      if (node.depth === 5) return <h5>{children}</h5>;
      return <h6>{children}</h6>;
    }
    case "paragraph":
      return (
        <p>
          <ReaderChildren children={node.children} />
        </p>
      );
    case "emphasis":
      return (
        <em>
          <ReaderChildren children={node.children} />
        </em>
      );
    case "strong":
      return (
        <strong>
          <ReaderChildren children={node.children} />
        </strong>
      );
    case "delete":
      return (
        <del>
          <ReaderChildren children={node.children} />
        </del>
      );
    case "link":
      return (
        <HostLink title={node.title ?? undefined} url={node.url}>
          <ReaderChildren children={node.children} />
        </HostLink>
      );
    case "image":
      return (
        <HostImage
          alt={node.alt}
          sourceUrl={node.url}
          title={node.title ?? undefined}
        />
      );
    case "code":
      return (
        <pre
          aria-label={
            node.lang ? `Scrollable ${node.lang} code` : "Scrollable code"
          }
          className="reader-document-code"
          data-language={node.lang ?? undefined}
          tabIndex={0}
        >
          <code className={node.lang ? `language-${node.lang}` : undefined}>
            {node.value}
          </code>
        </pre>
      );
    case "inlineCode":
      return <code>{node.value}</code>;
    case "blockquote":
      return (
        <blockquote>
          <ReaderChildren children={node.children} />
        </blockquote>
      );
    case "list": {
      const children = <ReaderChildren children={node.children} />;
      return node.ordered ? (
        <ol start={node.start ?? undefined}>{children}</ol>
      ) : (
        <ul>{children}</ul>
      );
    }
    case "listItem":
      return (
        <li>
          <ReaderChildren children={node.children} />
        </li>
      );
    case "table":
      return <ReaderTable node={node} />;
    case "tableRow":
    case "tableCell":
      return null;
    case "thematicBreak":
      return <hr />;
    case "break":
      return <br />;
  }
}

function StructuredReaderV1({ document }: { document: ReaderDocumentV1 }) {
  return (
    <div className="reader-document" data-reader-schema="reader.document.v1">
      <ReaderChildren children={document.children} />
    </div>
  );
}

type ReaderV2RenderableNode = ReaderV2FlowNode | ReaderV2PhrasingNode;

type FootnoteIndex = {
  definitions: ReaderV2FootnoteDefinition[];
  namespace: string;
  referenceIds: Map<string, string[]>;
  referenceNodeIds: WeakMap<ReaderV2FootnoteReference, string>;
};

const FootnoteIndexContext = createContext<FootnoteIndex>({
  definitions: [],
  namespace: "reader",
  referenceIds: new Map(),
  referenceNodeIds: new WeakMap(),
});

function utf8DomIdentifier(identifier: string) {
  let wellFormedIdentifier = "";
  for (let index = 0; index < identifier.length; index += 1) {
    const codeUnit = identifier.charCodeAt(index);
    if (codeUnit === 0x7e) {
      wellFormedIdentifier += "~007e";
      continue;
    }
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = identifier.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        wellFormedIdentifier += identifier[index] + identifier[index + 1];
        index += 1;
      } else {
        wellFormedIdentifier += `~${codeUnit.toString(16)}`;
      }
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      wellFormedIdentifier += `~${codeUnit.toString(16)}`;
      continue;
    }
    wellFormedIdentifier += identifier[index];
  }
  return Array.from(new TextEncoder().encode(wellFormedIdentifier), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function footnoteDefinitionId(index: FootnoteIndex, identifier: string) {
  return `${index.namespace}-footnote-u${utf8DomIdentifier(identifier)}`;
}

function readerAnchorId(namespace: string, anchor: string) {
  return `${namespace}-anchor-u${utf8DomIdentifier(anchor)}`;
}

function footnoteIndexFor(
  document: ReaderDocumentV2,
  namespace: string,
): FootnoteIndex {
  const definitions: ReaderV2FootnoteDefinition[] = [];
  const referenceIds = new Map<string, string[]>();
  const referenceNodeIds = new WeakMap<ReaderV2FootnoteReference, string>();

  function visitPhrasing(nodes: readonly ReaderV2PhrasingNode[]) {
    for (const node of nodes) {
      if (node.type === "footnoteReference") {
        const references = referenceIds.get(node.identifier) ?? [];
        const referenceId = `${namespace}-footnote-ref-u${utf8DomIdentifier(node.identifier)}-${references.length + 1}`;
        references.push(referenceId);
        referenceIds.set(node.identifier, references);
        referenceNodeIds.set(node, referenceId);
      } else if ("children" in node) {
        visitPhrasing(node.children);
      }
    }
  }

  function visitFlow(nodes: readonly ReaderV2FlowNode[]) {
    for (const node of nodes) {
      switch (node.type) {
        case "heading":
        case "paragraph":
          visitPhrasing(node.children);
          break;
        case "figure":
          visitPhrasing(node.caption);
          visitPhrasing(node.credit);
          break;
        case "blockquote":
        case "section":
          visitFlow(node.children);
          break;
        case "footnoteDefinition":
          definitions.push(node);
          visitFlow(node.children);
          break;
        case "list":
          for (const item of node.children) visitFlow(item.children);
          break;
        case "table": {
          const sections = [
            ...(node.head ? [node.head] : []),
            ...node.bodies,
            ...(node.foot ? [node.foot] : []),
          ];
          visitPhrasing(node.caption);
          for (const section of sections) {
            for (const row of section.children) {
              for (const cell of row.children) visitFlow(cell.children);
            }
          }
          break;
        }
        default:
          break;
      }
    }
  }

  visitFlow(document.children);
  return { definitions, namespace, referenceIds, referenceNodeIds };
}

function ReaderV2Children({
  children,
}: {
  children: readonly ReaderV2RenderableNode[];
}) {
  return children.map((node, index) => (
    <ReaderV2NodeView key={index} node={node} />
  ));
}

function ReaderV2HeadingView({
  anchor,
  depth,
  children,
}: {
  anchor?: string | null;
  children: ReaderV2PhrasingNode[];
  depth: 1 | 2 | 3 | 4 | 5 | 6;
}) {
  const index = useContext(FootnoteIndexContext);
  const content = <ReaderV2Children children={children} />;
  const anchorProps = anchor
    ? {
        "data-reader-anchor": anchor,
        id: readerAnchorId(index.namespace, anchor),
      }
    : {};
  if (depth === 1) return <h1 {...anchorProps}>{content}</h1>;
  if (depth === 2) return <h2 {...anchorProps}>{content}</h2>;
  if (depth === 3) return <h3 {...anchorProps}>{content}</h3>;
  if (depth === 4) return <h4 {...anchorProps}>{content}</h4>;
  if (depth === 5) return <h5 {...anchorProps}>{content}</h5>;
  return <h6 {...anchorProps}>{content}</h6>;
}

function ReaderV2TableCellView({ cell }: { cell: ReaderV2TableCell }) {
  const content = <ReaderV2Children children={cell.children} />;
  const props = {
    colSpan: cell.colSpan,
    rowSpan: cell.rowSpan,
    style: cell.align ? { textAlign: cell.align } : undefined,
  } as const;
  return cell.header ? (
    <th {...props} scope={cell.scope ?? undefined}>
      {content}
    </th>
  ) : (
    <td {...props}>{content}</td>
  );
}

function ReaderV2TableRows({ section }: { section: ReaderV2TableSection }) {
  return section.children.map((row: ReaderV2TableRow, rowIndex) => (
    <tr key={rowIndex}>
      {row.children.map((cell, cellIndex) => (
        <ReaderV2TableCellView cell={cell} key={cellIndex} />
      ))}
    </tr>
  ));
}

function readerV2PhrasingText(nodes: readonly ReaderV2PhrasingNode[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text":
        case "inlineCode":
          return node.value;
        case "image":
          return node.alt || node.title || "";
        case "math":
          return node.label || node.value;
        case "footnoteReference":
          return node.label;
        case "break":
          return " ";
        case "emphasis":
        case "strong":
        case "delete":
        case "insert":
        case "mark":
        case "subscript":
        case "superscript":
        case "keyboard":
        case "abbreviation":
        case "cite":
        case "quote":
        case "link":
          return readerV2PhrasingText(node.children);
      }
    })
    .join(" ");
}

function readerV2FlowText(nodes: readonly ReaderV2FlowNode[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "heading":
        case "paragraph":
          return readerV2PhrasingText(node.children);
        case "figure":
          return readerV2PhrasingText(node.caption);
        case "blockquote":
        case "section":
        case "footnoteDefinition":
          return readerV2FlowText(node.children);
        case "list":
          return node.children
            .map((item) => readerV2FlowText(item.children))
            .join(" ");
        case "code":
        case "math":
        case "table":
        case "thematicBreak":
          return "";
      }
    })
    .join(" ");
}

function ReaderV2TableView({ node }: { node: ReaderV2Table }) {
  const caption = readerV2PhrasingText(node.caption);
  const headerMeaning =
    node.head?.children[0]?.children
      .map((cell) => readerV2FlowText(cell.children))
      .join(" / ") ?? "";
  return (
    <div
      aria-label={tableRegionName(caption || headerMeaning)}
      className="reader-document-table"
      role="region"
      tabIndex={0}
    >
      <table>
        {node.caption.length > 0 ? (
          <caption>
            <ReaderV2Children children={node.caption} />
          </caption>
        ) : null}
        {node.head ? (
          <thead>
            <ReaderV2TableRows section={node.head} />
          </thead>
        ) : null}
        {node.bodies.map((section, index) => (
          <tbody key={index}>
            <ReaderV2TableRows section={section} />
          </tbody>
        ))}
        {node.foot ? (
          <tfoot>
            <ReaderV2TableRows section={node.foot} />
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}

function ReaderV2FootnoteReferenceView({
  node,
}: {
  node: ReaderV2FootnoteReference;
}) {
  const index = useContext(FootnoteIndexContext);
  const referenceId =
    index.referenceNodeIds.get(node) ??
    `${index.namespace}-footnote-ref-u${utf8DomIdentifier(node.identifier)}-1`;
  return (
    <sup className="reader-footnote-reference">
      <a
        aria-label={`Footnote ${node.label}`}
        data-reader-footnote-ref={node.identifier}
        href={`#${footnoteDefinitionId(index, node.identifier)}`}
        id={referenceId}
      >
        {node.label}
      </a>
    </sup>
  );
}

function ReaderV2NodeView({
  node,
}: {
  node: ReaderV2RenderableNode;
}): ReactNode {
  const footnoteIndex = useContext(FootnoteIndexContext);
  switch (node.type) {
    case "text":
      return node.value;
    case "heading":
      return (
        <ReaderV2HeadingView
          anchor={node.anchor}
          children={node.children}
          depth={node.depth}
        />
      );
    case "paragraph":
      return (
        <p>
          <ReaderV2Children children={node.children} />
        </p>
      );
    case "section":
      return (
        <section
          data-reader-anchor={node.anchor ?? undefined}
          data-reader-section=""
          id={
            node.anchor
              ? readerAnchorId(footnoteIndex.namespace, node.anchor)
              : undefined
          }
        >
          <ReaderV2Children children={node.children} />
        </section>
      );
    case "emphasis":
      return (
        <em>
          <ReaderV2Children children={node.children} />
        </em>
      );
    case "strong":
      return (
        <strong>
          <ReaderV2Children children={node.children} />
        </strong>
      );
    case "delete":
      return (
        <del>
          <ReaderV2Children children={node.children} />
        </del>
      );
    case "insert":
      return (
        <ins>
          <ReaderV2Children children={node.children} />
        </ins>
      );
    case "mark":
      return (
        <mark>
          <ReaderV2Children children={node.children} />
        </mark>
      );
    case "subscript":
      return (
        <sub>
          <ReaderV2Children children={node.children} />
        </sub>
      );
    case "superscript":
      return (
        <sup>
          <ReaderV2Children children={node.children} />
        </sup>
      );
    case "keyboard":
      return (
        <kbd>
          <ReaderV2Children children={node.children} />
        </kbd>
      );
    case "abbreviation":
      return (
        <abbr title={node.title ?? undefined}>
          <ReaderV2Children children={node.children} />
        </abbr>
      );
    case "cite":
      return (
        <cite>
          <ReaderV2Children children={node.children} />
        </cite>
      );
    case "quote":
      return (
        <q>
          <ReaderV2Children children={node.children} />
        </q>
      );
    case "link":
      return (
        <HostLink
          targetAnchor={node.targetAnchor}
          title={node.title ?? undefined}
          url={node.url}
        >
          <ReaderV2Children children={node.children} />
        </HostLink>
      );
    case "image":
      return (
        <HostImage
          alt={node.alt}
          sourceUrl={node.url}
          title={node.title ?? undefined}
        />
      );
    case "code":
      return (
        <RichCodeBlock
          language={node.lang}
          meta={node.meta}
          value={node.value}
        />
      );
    case "inlineCode":
      return <code>{node.value}</code>;
    case "math":
      return (
        <MathFormula
          display={node.display}
          format={node.format}
          label={node.label}
          value={node.value}
        />
      );
    case "footnoteReference":
      return <ReaderV2FootnoteReferenceView node={node} />;
    case "blockquote":
      return (
        <blockquote>
          <ReaderV2Children children={node.children} />
        </blockquote>
      );
    case "list": {
      const children = node.children.map((item, index) => (
        <li key={index}>
          <ReaderV2Children children={item.children} />
        </li>
      ));
      return node.ordered ? (
        <ol start={node.start ?? undefined}>{children}</ol>
      ) : (
        <ul>{children}</ul>
      );
    }
    case "figure":
      return (
        <figure className="reader-figure">
          <div className="reader-figure-media">
            {node.media.map((image, index) => (
              <HostImage
                alt={image.alt}
                key={index}
                sourceUrl={image.url}
                title={image.title ?? undefined}
              />
            ))}
          </div>
          {node.caption.length > 0 || node.credit.length > 0 ? (
            <figcaption>
              {node.caption.length > 0 ? (
                <span className="reader-figure-caption">
                  <ReaderV2Children children={node.caption} />
                </span>
              ) : null}
              {node.credit.length > 0 ? (
                <span className="reader-figure-credit">
                  <ReaderV2Children children={node.credit} />
                </span>
              ) : null}
            </figcaption>
          ) : null}
        </figure>
      );
    case "table":
      return <ReaderV2TableView node={node} />;
    case "footnoteDefinition":
      return null;
    case "thematicBreak":
      return <hr />;
    case "break":
      return <br />;
  }
}

function ReaderV2Footnotes() {
  const index = useContext(FootnoteIndexContext);
  if (index.definitions.length === 0) return null;
  return (
    <section aria-label="Footnotes" className="reader-footnotes">
      <h2 className="reader-footnotes-heading">Notes</h2>
      <ol>
        {index.definitions.map((definition) => {
          const references =
            index.referenceIds.get(definition.identifier) ?? [];
          return (
            <li
              data-reader-footnote-definition={definition.identifier}
              id={footnoteDefinitionId(index, definition.identifier)}
              key={definition.identifier}
            >
              <ReaderV2Children children={definition.children} />
              {references.length > 0 ? (
                <span className="reader-footnote-backlinks">
                  {references.map((referenceId, index) => (
                    <a
                      aria-label={`Back to footnote reference ${index + 1}`}
                      data-reader-footnote-backref={definition.identifier}
                      href={`#${referenceId}`}
                      key={referenceId}
                    >
                      ↩{references.length > 1 ? index + 1 : ""}
                    </a>
                  ))}
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function StructuredReaderV2({ document }: { document: ReaderDocumentV2 }) {
  const surfaceId = useId();
  const namespace = `reader-${utf8DomIdentifier(surfaceId)}`;
  const footnoteIndex = useMemo(
    () => footnoteIndexFor(document, namespace),
    [document, namespace],
  );
  return (
    <FootnoteIndexContext.Provider value={footnoteIndex}>
      <div
        className="reader-document reader-document-v2"
        data-reader-loss-count={document.losses.length}
        data-reader-schema="reader.document.v2"
      >
        <ReaderV2Children children={document.children} />
        <ReaderV2Footnotes />
      </div>
    </FootnoteIndexContext.Provider>
  );
}

export function ReaderDocumentSurface({
  fallback,
  fallbackLabel = "Reader fallback",
  imageSourceFor,
  onOpenLink,
  payload,
  resolveImageSource,
  resolveRemoteImageSource,
  schema,
  showFallbackNotice = true,
}: ReaderDocumentSurfaceProps) {
  const resolution = resolveReaderDocument(schema, payload);
  const hostPolicy = useMemo<ReaderHostPolicy>(
    () => ({
      imageBudget: {
        acceptedSources: new Map(),
        requestedUrls: new Set(),
        retainedCharacters: 0,
      },
      imageSourceFor,
      onOpenLink,
      resolveImageSource,
      resolveRemoteImageSource,
    }),
    [
      imageSourceFor,
      onOpenLink,
      payload,
      resolveImageSource,
      resolveRemoteImageSource,
      schema,
    ],
  );

  if (resolution.status === "ready") {
    return (
      <ReaderHostPolicyContext.Provider value={hostPolicy}>
        {resolution.schema === "reader.document.v2" ? (
          <StructuredReaderV2 document={resolution.document} />
        ) : (
          <StructuredReaderV1 document={resolution.document} />
        )}
      </ReaderHostPolicyContext.Provider>
    );
  }

  return (
    <ReaderHostPolicyContext.Provider value={hostPolicy}>
      <section
        aria-label={fallbackLabel}
        data-reader-fallback={resolution.reason}
      >
        {showFallbackNotice ? (
          <p role="status">
            Structured view unavailable. Showing the saved{" "}
            {fallback.format === "gfm" ? "GFM" : "plain-text"} fallback.
          </p>
        ) : null}
        {fallback.format === "gfm" ? (
          <div className="reader-document-fallback">
            <ReactMarkdown
              components={{
                a: ({ children, href, node: _node, title, ...props }) =>
                  href?.startsWith("#") ? (
                    <a {...props} href={href} title={title}>
                      {children}
                    </a>
                  ) : href ? (
                    <HostLink title={title} url={href}>
                      {children}
                    </HostLink>
                  ) : (
                    <>{children}</>
                  ),
                img: ({ alt, src, title }) => (
                  <HostImage
                    alt={alt ?? ""}
                    sourceUrl={src ?? ""}
                    title={title}
                  />
                ),
              }}
              remarkPlugins={[remarkGfm]}
              skipHtml
            >
              {fallback.content}
            </ReactMarkdown>
          </div>
        ) : (
          <p style={{ whiteSpace: "pre-wrap" }}>{fallback.content}</p>
        )}
      </section>
    </ReaderHostPolicyContext.Provider>
  );
}
