import { useLayoutEffect, useRef } from "react";
import { Thumbnail } from "react-pdf";

export const THUMBNAIL_WIDTH = 124;

export function PdfNavigationThumbnail({
  current,
  onActivate,
  onElement,
  page,
  visible,
}: Readonly<{
  current: boolean;
  onActivate: (page: number) => void;
  onElement: (element: HTMLDivElement | null) => void;
  page: number;
  visible: boolean;
}>) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const accessibleLabel = `Go to page ${page}`;

  // react-pdf renders the thumbnail as a bare anchor; give it a name and the
  // current-page state so the sidebar reads as a page list.
  useLayoutEffect(() => {
    const link = wrapperRef.current?.querySelector<HTMLAnchorElement>(
      "a.react-pdf__Thumbnail",
    );
    if (!link) return;
    link.setAttribute("aria-label", accessibleLabel);
    if (current) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }, [accessibleLabel, current, visible]);

  return (
    <div
      className={`pdf-canvas-viewer__thumbnail${current ? " is-current" : ""}`}
      data-pdf-thumbnail-page={page}
      ref={(element) => {
        wrapperRef.current = element;
        onElement(element);
      }}
    >
      {visible ? (
        <Thumbnail
          onItemClick={() => onActivate(page)}
          pageNumber={page}
          width={THUMBNAIL_WIDTH}
        />
      ) : (
        <button
          aria-label={accessibleLabel}
          className="pdf-canvas-viewer__thumbnail-placeholder"
          onClick={() => onActivate(page)}
          type="button"
        />
      )}
      <span className="pdf-canvas-viewer__thumbnail-meta">
        <span>{page}</span>
      </span>
    </div>
  );
}
