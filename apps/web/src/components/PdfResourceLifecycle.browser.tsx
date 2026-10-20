// FILE: PdfResourceLifecycle.browser.tsx
// Purpose: Browser regressions for A -> B -> A PDF/image resources and PDF page drafts.
// Layer: Focused component lifecycle tests

import "../index.css";

import { useState } from "react";
import { page as browserPage } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { PDFDocumentProxy } from "~/lib/pdf/pdfEngine";
import { usePdfDocument } from "~/lib/pdf/usePdfDocument";
import { LocalImagePreview } from "./LocalImagePreview";
import { PdfFilePreview } from "./PdfFilePreview";
import { PdfViewerToolbar } from "./pdf/PdfViewerToolbar";

const { loadPdfDocumentMock, renderPageTextLayerMock } = vi.hoisted(() => ({
  loadPdfDocumentMock: vi.fn(),
  renderPageTextLayerMock: vi.fn(),
}));

vi.mock("~/lib/pdf/pdfEngine", () => ({
  loadPdfDocument: loadPdfDocumentMock,
  renderPageTextLayer: renderPageTextLayerMock,
}));

vi.mock("./chat/OpenInPicker", () => ({
  OpenInPicker: ({ openInTarget }: { openInTarget: string | null }) => (
    <span data-testid="pdf-open-target">{openInTarget ?? "disabled"}</span>
  ),
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function responseForDocument(id: number): Response {
  return new Response(new Uint8Array([id]), { status: 200 });
}

function createPdfDocument(label: string): {
  document: PDFDocumentProxy;
  destroy: ReturnType<typeof vi.fn>;
} {
  const destroy = vi.fn(() => Promise.resolve());
  const document = {
    numPages: 1,
    destroy,
    getPage: vi.fn(() =>
      Promise.resolve({
        getViewport: () => ({ width: 612, height: 792 }),
        getAnnotations: async () => [],
        render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
      }),
    ),
  } as unknown as PDFDocumentProxy;
  documentLabels.set(document, label);
  return { document, destroy };
}

const documentLabels = new WeakMap<PDFDocumentProxy, string>();
let fetchRequests: Map<string, Deferred<Response>[]>;

beforeEach(() => {
  fetchRequests = new Map();
  loadPdfDocumentMock.mockReset();
  renderPageTextLayerMock.mockReset();
  renderPageTextLayerMock.mockResolvedValue({ promise: Promise.resolve(), cancel: vi.fn() });
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const request = deferred<Response>();
      const requests = fetchRequests.get(url) ?? [];
      requests.push(request);
      fetchRequests.set(url, requests);
      return request.promise;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("local preview resource generations", () => {
  it("does not revive a destroyed PDF document after A -> B -> A", async () => {
    const firstA = createPdfDocument("first-a");
    const secondA = createPdfDocument("second-a");
    loadPdfDocumentMock
      .mockResolvedValueOnce(firstA.document)
      .mockResolvedValueOnce(secondA.document);

    function PdfHarness() {
      const [url, setUrl] = useState("/a.pdf");
      const pdf = usePdfDocument(url);
      const label = pdf.document ? documentLabels.get(pdf.document) : "none";
      return (
        <>
          <button type="button" onClick={() => setUrl("/b.pdf")}>
            Show B
          </button>
          <button type="button" onClick={() => setUrl("/a.pdf")}>
            Show A
          </button>
          <output data-testid="pdf-state">{`${pdf.status}:${label}`}</output>
        </>
      );
    }

    await render(<PdfHarness />);
    await vi.waitFor(() => expect(fetchRequests.get("/a.pdf")).toHaveLength(1));
    fetchRequests.get("/a.pdf")?.[0]?.resolve(responseForDocument(1));
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="pdf-state"]')?.textContent).toBe(
        "ready:first-a",
      ),
    );

    await browserPage.getByRole("button", { name: "Show B" }).click();
    await vi.waitFor(() => expect(fetchRequests.get("/b.pdf")).toHaveLength(1));
    await vi.waitFor(() => expect(firstA.destroy).toHaveBeenCalledOnce());
    await browserPage.getByRole("button", { name: "Show A" }).click();
    await vi.waitFor(() => expect(fetchRequests.get("/a.pdf")).toHaveLength(2));

    expect(document.querySelector('[data-testid="pdf-state"]')?.textContent).toBe("loading:none");
    fetchRequests.get("/a.pdf")?.[1]?.resolve(responseForDocument(2));
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="pdf-state"]')?.textContent).toBe(
        "ready:second-a",
      ),
    );
    expect(firstA.destroy).toHaveBeenCalledOnce();
  });

  it("offers a PDF reload after a read failure and requests a fresh resource", async () => {
    function PdfReloadHarness() {
      const [revision, setRevision] = useState(0);
      return (
        <PdfFilePreview
          filePath="document.pdf"
          cwd="/repo"
          openInTarget={null}
          cacheKey={revision}
          onReload={() => setRevision((value) => value + 1)}
        />
      );
    }
    await render(<PdfReloadHarness />);
    await vi.waitFor(() => expect(fetchRequests.size).toBe(1));
    const initialUrl = [...fetchRequests.keys()][0]!;
    fetchRequests.get(initialUrl)?.[0]?.resolve(new Response(null, { status: 404 }));
    await browserPage.getByRole("button", { name: "Reload file from disk" }).click();
    await vi.waitFor(() => expect(fetchRequests.size).toBe(2));
    const urls = [...fetchRequests.keys()].map((url) => new URL(url, window.location.href));
    expect(urls.map((url) => url.searchParams.get("v"))).toEqual(["0", "1"]);
    expect(urls.map((url) => url.searchParams.get("path"))).toEqual([
      "document.pdf",
      "document.pdf",
    ]);
  });

  it("renders an immutable PDF URL with native controls and no live path actions", async () => {
    const sourceUrl =
      "data:application/pdf;base64,JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAxMDAgMTAwXSAvUmVzb3VyY2VzIDw8ID4+IC9Db250ZW50cyA0IDAgUiA+PgplbmRvYmoKNCAwIG9iago8PCAvTGVuZ3RoIDAgPj4Kc3RyZWFtCgplbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA1CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAxMTUgMDAwMDAgbiAKMDAwMDAwMDIxOSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDUgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjI2OAolJUVPRgo=";
    const pinnedDocument = createPdfDocument("published");
    const onReload = vi.fn();
    loadPdfDocumentMock.mockResolvedValueOnce(pinnedDocument.document);

    await render(
      <PdfFilePreview
        filePath="plan.pdf"
        cwd="/server-cwd"
        immutableSourceUrl={sourceUrl}
        openInTarget="/server-cwd/plan.pdf"
        onReload={onReload}
      />,
    );

    await vi.waitFor(() => expect(fetchRequests.get(sourceUrl)).toHaveLength(1));
    expect([...fetchRequests.keys()]).toEqual([sourceUrl]);
    fetchRequests.get(sourceUrl)?.[0]?.resolve(responseForDocument(3));

    await expect.element(browserPage.getByRole("textbox", { name: "Current page" })).toBeVisible();
    await expect.element(browserPage.getByRole("button", { name: "Zoom in" })).toBeVisible();
    expect(document.querySelector('[data-testid="pdf-open-target"]')?.textContent).toBe("disabled");
    expect(browserPage.getByRole("button", { name: "Reload file from disk" }).length).toBe(0);
    expect(onReload).not.toHaveBeenCalled();
  });

  it("renders a fresh image after an errored A -> B -> A transition", async () => {
    function ImageHarness() {
      const [src, setSrc] = useState("a.png");
      return (
        <>
          <button type="button" onClick={() => setSrc("b.png")}>
            Show B image
          </button>
          <button type="button" onClick={() => setSrc("a.png")}>
            Show A image
          </button>
          <LocalImagePreview src={src} cwd="/workspace" alt={src} />
        </>
      );
    }

    await render(<ImageHarness />);
    document
      .querySelector<HTMLImageElement>(".local-image-preview__img")
      ?.dispatchEvent(new Event("error"));
    await vi.waitFor(() => expect(document.body.textContent).toContain("Couldn’t open this image"));

    await browserPage.getByRole("button", { name: "Show B image" }).click();
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLImageElement>(".local-image-preview__img")?.alt).toBe(
        "b.png",
      ),
    );
    await browserPage.getByRole("button", { name: "Show A image" }).click();

    await vi.waitFor(() =>
      expect(document.querySelector<HTMLImageElement>(".local-image-preview__img")?.alt).toBe(
        "a.png",
      ),
    );
    expect(document.body.textContent).not.toContain("Couldn’t open this image");
  });

  it("reports PDF document load failures to its preview owner", async () => {
    const onPreviewError = vi.fn();

    await render(
      <PdfFilePreview
        filePath="missing.pdf"
        cwd="/workspace"
        openInTarget={null}
        onPreviewError={onPreviewError}
      />,
    );
    await vi.waitFor(() => expect([...fetchRequests.values()].flat()).toHaveLength(1));
    [...fetchRequests.values()][0]?.[0]?.resolve(new Response(null, { status: 404 }));

    await vi.waitFor(() => expect(onPreviewError).toHaveBeenCalledOnce());
  });
});

describe("PDF page draft", () => {
  it("does not revive an old draft when currentPage returns to its base", async () => {
    function ToolbarHarness() {
      const [currentPage, setCurrentPage] = useState(1);
      return (
        <>
          <button type="button" onClick={() => setCurrentPage(2)}>
            Navigate to 2
          </button>
          <button type="button" onClick={() => setCurrentPage(1)}>
            Navigate to 1
          </button>
          <PdfViewerToolbar
            fileName="document.pdf"
            currentPage={currentPage}
            numPages={9}
            onJumpToPage={setCurrentPage}
            zoomMode={{ type: "custom", scale: 1 }}
            scale={1}
            onZoomIn={vi.fn()}
            onZoomOut={vi.fn()}
            onSetScale={vi.fn()}
            onFitWidth={vi.fn()}
            onFitPage={vi.fn()}
            openInTarget={null}
          />
        </>
      );
    }

    await render(<ToolbarHarness />);
    await browserPage.getByRole("textbox", { name: "Current page" }).fill("9");
    await browserPage.getByRole("button", { name: "Navigate to 2" }).click();
    await browserPage.getByRole("button", { name: "Navigate to 1" }).click();

    await vi.waitFor(() =>
      expect(
        document.querySelector<HTMLInputElement>('input[aria-label="Current page"]')?.value,
      ).toBe("1"),
    );
  });
});
