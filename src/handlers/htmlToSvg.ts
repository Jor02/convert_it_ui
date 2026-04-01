import { elementToSVG, inlineResources } from "dom-to-svg";
import CommonFormats, { Category } from "src/CommonFormats.ts";
import { NumberOption, TextOption, type FileData, type FileFormat, type FormatHandler } from "../FormatHandler.ts";
import type { ConvertContext } from "../ui/ProgressStore.js";

function nextPaint(): Promise<void> {
  return new Promise(resolve => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

async function waitForRenderableAssets(root: ParentNode): Promise<void> {
  const pendingImages = Array.from(root.querySelectorAll("img"))
    .filter(image => !image.complete)
    .map(image => new Promise<void>(resolve => {
      image.addEventListener("load", () => resolve(), { once: true });
      image.addEventListener("error", () => resolve(), { once: true });
    }));

  const pendingVideos = Array.from(root.querySelectorAll("video"))
    .filter(video => video.readyState < 2)
    .map(video => new Promise<void>(resolve => {
      video.addEventListener("loadeddata", () => resolve(), { once: true });
      video.addEventListener("error", () => resolve(), { once: true });
    }));

  await Promise.all([...pendingImages, ...pendingVideos]);
  await nextPaint();
}

type HtmlToSvgOptions = {
  width?: number;
  height?: number;
  backgroundColor?: string;
};

function measureRenderedElement(
  element: Element,
  options: HtmlToSvgOptions,
): { width: number; height: number } {
  const rect = element.getBoundingClientRect();
  const widthCandidate = element instanceof HTMLElement || element instanceof SVGElement
    ? Math.max(rect.width, element.scrollWidth || 0, element.clientWidth || 0)
    : rect.width;
  const heightCandidate = element instanceof HTMLElement || element instanceof SVGElement
    ? Math.max(rect.height, element.scrollHeight || 0, element.clientHeight || 0)
    : rect.height;

  return {
    width: Math.max(1, Math.ceil(options.width ?? widthCandidate)),
    height: Math.max(1, Math.ceil(options.height ?? heightCandidate)),
  };
}

async function renderRootToSvgString(
  root: HTMLElement,
  options: HtmlToSvgOptions,
): Promise<string> {
  await waitForRenderableAssets(root);

  // If a specific width is requested, apply it before measuring to force line wrapping
  if (options.width) {
    root.style.width = `${options.width}px`;
    root.style.overflowWrap = "break-word";
    await nextPaint();
  }

  const { width, height } = measureRenderedElement(root, options);
  const existingStyle = root.getAttribute("style") || "";
  const bg = options.backgroundColor ? `background-color:${options.backgroundColor};` : "";
  root.setAttribute(
    "style",
    `${existingStyle}${bg}width:${width}px;height:${height}px;box-sizing:border-box;`,
  );

  await nextPaint();

  const bounds = root.getBoundingClientRect();
  const svgDocument = elementToSVG(root, { captureArea: bounds });
  await inlineResources(svgDocument.documentElement);
  return new XMLSerializer().serializeToString(svgDocument);
}

export async function htmlContentToSvgString(
  htmlContent: string,
  options: HtmlToSvgOptions = {},
): Promise<string> {
  const parsed = new DOMParser().parseFromString(htmlContent, "text/html");
  const host = document.createElement("div");
  host.style.all = "initial";
  host.style.position = "fixed";
  host.style.left = "-20000px";
  host.style.top = "0";
  host.style.pointerEvents = "none";
  host.style.background = "transparent";
  document.body.appendChild(host);

  try {
    const shadow = host.attachShadow({ mode: "closed" });

    for (const styleElement of Array.from(parsed.querySelectorAll("style"))) {
      shadow.appendChild(styleElement.cloneNode(true));
    }

    const root = document.createElement("div");
    const bodyStyle = parsed.body.getAttribute("style");
    if (bodyStyle) root.setAttribute("style", bodyStyle);

    const sourceNodes = parsed.body.childNodes.length > 0
      ? Array.from(parsed.body.childNodes)
      : Array.from(parsed.documentElement.childNodes);
    for (const childNode of sourceNodes) {
      root.appendChild(childNode.cloneNode(true));
    }

    shadow.appendChild(root);

    // Look for a rendering hint from the document (like from an EPUB handler)
    if (!options.width) {
      const hint = parsed.querySelector('meta[name="conversion-suggested-width"]');
      if (hint) {
        const suggestedWidth = Math.max(0, Number.parseInt(hint.getAttribute("content") || "0", 10));
        if (suggestedWidth) {
          options.width = suggestedWidth;
        }
      }
    }

    return await renderRootToSvgString(root, options);
  } finally {
    host.remove();
  }
}

class HtmlToSvgHandler implements FormatHandler {

  public name: string = "dom-to-svg";

  public supportedFormats: FileFormat[] = [
    CommonFormats.HTML.supported("html", true, false),
    CommonFormats.SVG.supported("svg", false, true, false, {
      category: [Category.IMAGE, Category.VECTOR],
    }),
  ];

  private readonly options: HtmlToSvgOptions = {
    width: 0,
    height: 0,
    backgroundColor: "",
  };

  public ready: boolean = true;

  async init() {
    this.ready = true;
  }

  public getOptions() {
    return [
      new NumberOption(
        "svg-width",
        "Width",
        () => this.options.width ?? 0,
        (value) => { this.options.width = value; },
        {
          min: 0,
          defaultValue: 0,
          description: "Target width in pixels (0 for auto). Forces line wrapping if set.",
          unit: "px",
        },
      ),
      new NumberOption(
        "svg-height",
        "Height",
        () => this.options.height ?? 0,
        (value) => { this.options.height = value; },
        {
          min: 0,
          defaultValue: 0,
          description: "Target height in pixels (0 for auto).",
          unit: "px",
        },
      ),
      new TextOption(
        "svg-bg",
        "Background color",
        () => this.options.backgroundColor ?? "",
        (value) => { this.options.backgroundColor = value; },
        {
          defaultValue: "",
          placeholder: "e.g. #ffffff or transparent",
          description: "Custom background color for the resulting SVG.",
        },
      ),
    ];
  }

  async doConvert(
    inputFiles: FileData[],
    inputFormat: FileFormat,
    outputFormat: FileFormat,
    _args?: string[],
    ctx?: ConvertContext,
  ): Promise<FileData[]> {
    if (inputFormat.internal !== "html") throw new Error("Invalid input format.");
    if (outputFormat.internal !== "svg") throw new Error("Invalid output format.");

    const outputFiles: FileData[] = [];
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    // Prepare conversion options (convert 0 to undefined for the internal API)
    const options: HtmlToSvgOptions = {
      width: this.options.width || undefined,
      height: this.options.height || undefined,
      backgroundColor: this.options.backgroundColor || undefined,
    };

    for (let i = 0; i < inputFiles.length; i++) {
      ctx?.throwIfAborted();
      ctx?.progress(`Rendering ${inputFiles[i].name} to SVG...`, i / inputFiles.length);
      ctx?.log(`Rendering to SVG (${i + 1}/${inputFiles.length})...`);

      const { name, bytes } = inputFiles[i];
      const htmlStr = decoder.decode(bytes);
      const svgStr = await htmlContentToSvgString(htmlStr, options);
      const newName = (name.endsWith(".html") ? name.slice(0, -5) : name) + ".svg";
      outputFiles.push({ name: newName, bytes: encoder.encode(svgStr) });
    }

    ctx?.progress("Conversion complete!", 1);
    return outputFiles;
  }
}

export default HtmlToSvgHandler;
