const parseViewport = (str) =>
  str
    ?.split(/[,;\s]/)
    ?.filter((x) => x)
    ?.map((x) => x.split("=").map((x) => x.trim()));

const getViewport = (doc, viewport) => {
  if (doc.documentElement.localName === "svg") {
    const [, , width, height] =
      doc.documentElement.getAttribute("viewBox")?.split(/\s/) ?? [];
    return { width, height };
  }
  const meta = parseViewport(
    doc.querySelector('meta[name="viewport"]')?.getAttribute("content"),
  );
  if (meta) return Object.fromEntries(meta);
  if (typeof viewport === "string") return parseViewport(viewport);
  if (viewport?.width && viewport.height) return viewport;
  const img = doc.querySelector("img");
  if (img) return { width: img.naturalWidth, height: img.naturalHeight };
  console.warn(new Error("Missing viewport properties"));
  return { width: 1000, height: 2000 };
};

export class FixedLayout extends HTMLElement {
  static observedAttributes = ["zoom"];
  #root = this.attachShadow({ mode: "closed" });
  #observer = new ResizeObserver(() => this.#render());
  #spreads;
  #index = -1;
  defaultViewport;
  spread;
  #portrait = false;
  #left;
  #right;
  #center;
  #side;
  #zoom;
  #wrapper;
  #transform = { x: 0, y: 0, scale: 1 };
  #zoomState = {
    minScale: 0.1,
    maxScale: 10,
    zoomStep: 0.1,
  };
  #dragState = {
    isDragging: false,
    startX: 0,
    startY: 0,
    startTX: 0,
    startTY: 0,
  };
  dragOffset = { x: 0, y: 0 };
  #magnifier = {
    enabled: false,
    size: 150,
    magnification: 2,
    element: null,
  };

  constructor() {
    super();

    const sheet = new CSSStyleSheet();
    this.#root.adoptedStyleSheets = [sheet];
    sheet.replaceSync(`:host {
            width: 100%;
            height: 100%;
            display: block;
            overflow: hidden;
            position: relative;
        }`);

    this.#wrapper = document.createElement("div");
    this.#wrapper.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            display: flex;
            transform-origin: 0 0;
        `;
    this.#root.appendChild(this.#wrapper);

    this.#observer.observe(this);
  }

  attributeChangedCallback(name, _, value) {
    switch (name) {
      case "zoom": {
        if (value == null) {
          this.#zoom = undefined;
          this.#render();
          return;
        }
        const newZoom =
          value !== "fit-width" && value !== "fit-page"
            ? parseFloat(value)
            : value;

        if (typeof newZoom === "number" && !isNaN(newZoom)) {
          if (this.#transform.scale === newZoom) return;
          const rect = this.getBoundingClientRect();
          const cx = rect.width / 2;
          const cy = rect.height / 2;
          this.#zoomByRatio(cx, cy, newZoom / this.#transform.scale);
        } else {
          this.#zoom = newZoom;
          this.#render();
        }
        break;
      }
    }
  }

  get zoom() {
    return this.#zoom;
  }

  toggleMagnifier() {
    this.#magnifier.enabled = !this.#magnifier.enabled;

    if (this.#magnifier.enabled) {
      this.#createMagnifier();
      this.addEventListener("mousemove", this.#handleMagnifierMove.bind(this));
      this.style.cursor = "crosshair";
    } else {
      this.#destroyMagnifier();
      this.removeEventListener(
        "mousemove",
        this.#handleMagnifierMove.bind(this),
      );
      this.style.cursor = "";
    }
  }

  #createMagnifier() {
    if (this.#magnifier.element) return;

    const magnifier = document.createElement("div");
    magnifier.className = "magnifier";
    magnifier.style.cssText = `
            position: absolute;
            width: ${this.#magnifier.size}px;
            height: ${this.#magnifier.size}px;
            border-radius: 50%;
            border: 2px solid rgba(255, 255, 255, 0.8);
            box-shadow: 0 0 10px rgba(0, 0, 0, 0.5);
            pointer-events: none;
            z-index: 1000;
            display: none;
            overflow: hidden;
            background: white;
        `;

    const lens = document.createElement("div");
    lens.className = "magnifier-lens";
    lens.style.cssText = `
            width: 100%;
            height: 100%;
            border-radius: 50%;
            overflow: hidden;
        `;

    magnifier.appendChild(lens);
    this.#root.appendChild(magnifier);
    this.#magnifier.element = magnifier;
  }

  #destroyMagnifier() {
    if (this.#magnifier.element) {
      this.#magnifier.element.remove();
      this.#magnifier.element = null;
    }
  }

  #handleMagnifierMove(event) {
    if (!this.#magnifier.enabled) return;

    const rect = this.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    const magnifier = this.#magnifier.element;
    magnifier.style.display = "block";
    magnifier.style.left = `${x - this.#magnifier.size / 2}px`;
    magnifier.style.top = `${y - this.#magnifier.size / 2}px`;

    const lens = magnifier.querySelector(".magnifier-lens");
    const frame = this.#center || this.#left || this.#right;
    if (frame?.iframe) {
      const iframe = frame.iframe;
      lens.innerHTML = "";
      lens.appendChild(iframe.cloneNode(true));
      const scale = this.#transform.scale || 1;
      lens.style.transform = `scale(${this.#magnifier.magnification})`;

      const iframeRect = iframe.getBoundingClientRect();
      const relX = (x - iframeRect.left) / scale;
      const relY = (y - iframeRect.top) / scale;

      lens.style.transformOrigin = `${-relX + this.#magnifier.size / 2}px ${-relY + this.#magnifier.size / 2}px`;
    }
  }

  #applyTransform() {
    this.#wrapper.style.transform = `translate(${this.#transform.x}px, ${this.#transform.y}px)`;
  }

  #updateFrameScales(scale) {
    const left = this.#left ?? {};
    const right = this.#center ?? this.#right ?? {};
    const { width: hostWidth, height: hostHeight } =
      this.getBoundingClientRect();
    const portrait =
      this.spread !== "both" &&
      this.spread !== "portrait" &&
      hostHeight > hostWidth;
    const target = this.#side === "left" ? left : right;
    const blankWidth = left.width ?? right.width ?? 0;
    const blankHeight = left.height ?? right.height ?? 0;

    const transform = (frame) => {
      let { element, iframe, width, height, blank, onZoom } = frame;
      if (!iframe) return;
      if (onZoom) onZoom({ doc: frame.iframe.contentDocument, scale });
      const iframeScale = onZoom ? scale : 1;
      Object.assign(iframe.style, {
        width: `${width * iframeScale}px`,
        height: `${height * iframeScale}px`,
        transform: onZoom ? "none" : `scale(${scale})`,
        transformOrigin: "top left",
        display: blank ? "none" : "block",
      });
      Object.assign(element.style, {
        width: `${(width ?? blankWidth) * scale}px`,
        height: `${(height ?? blankHeight) * scale}px`,
        overflow: "hidden",
        display: "block",
        flexShrink: "0",
      });
      if (portrait && frame !== target) {
        element.style.display = "none";
      }
    };
    if (this.#center) {
      transform(this.#center);
    } else {
      transform(left);
      transform(right);
    }
  }

  #getContentSize() {
    const left = this.#left ?? {};
    const right = this.#center ?? this.#right ?? {};
    const { width: hostWidth, height: hostHeight } =
      this.getBoundingClientRect();
    const portrait =
      this.spread !== "both" &&
      this.spread !== "portrait" &&
      hostHeight > hostWidth;
    const target = this.#side === "left" ? left : right;
    const blankWidth = left.width ?? right.width ?? 0;
    const blankHeight = left.height ?? right.height ?? 0;
    const scale = this.#transform.scale;

    let contentWidth;
    let contentHeight;

    if (this.#center || portrait) {
      const tw = (target.width ?? blankWidth) * scale;
      const th = (target.height ?? blankHeight) * scale;
      contentWidth = tw;
      contentHeight = th;
    } else {
      const lw = (left.width ?? blankWidth) * scale;
      const rw = (right.width ?? blankWidth) * scale;
      const lh = (left.height ?? blankHeight) * scale;
      const rh = (right.height ?? blankHeight) * scale;
      contentWidth = lw + rw;
      contentHeight = Math.max(lh, rh);
    }
    return { contentWidth, contentHeight };
  }

  #zoomByRatio(cx, cy, ratio) {
    const oldScale = this.#transform.scale;
    const newScale = Math.min(
      this.#zoomState.maxScale,
      Math.max(this.#zoomState.minScale, oldScale * ratio),
    );
    const actualRatio = newScale / oldScale;

    this.#transform.x = cx - actualRatio * (cx - this.#transform.x);
    this.#transform.y = cy - actualRatio * (cy - this.#transform.y);
    this.#transform.scale = newScale;

    this.#zoom = newScale;
    this.#updateFrameScales(newScale);
    this.#applyTransform();

    this.setAttribute("zoom", newScale);
  }

  #handleWheel(event) {
    if (this.hasAttribute("panel-mode")) return;
    if (event.ctrlKey || event.metaKey) return;
    event.preventDefault();

    const rect = this.getBoundingClientRect();
    const cx = event.clientX - rect.left;
    const cy = event.clientY - rect.top;

    const ratio =
      event.deltaY > 0
        ? 1 - this.#zoomState.zoomStep
        : 1 + this.#zoomState.zoomStep;

    this.#zoomByRatio(cx, cy, ratio);
  }

  #handleMouseDown(event) {
    if (event.button !== 0) return;

    this.#dragState.startX = event.clientX;
    this.#dragState.startY = event.clientY;
    this.#dragState.startTX = this.#transform.x;
    this.#dragState.startTY = this.#transform.y;
    this.#dragState.isDragging = true;
    this.style.cursor = "grabbing";
  }

  #handleMouseMove(event) {
    if (!this.#dragState.isDragging) return;

    const dx = event.clientX - this.#dragState.startX;
    const dy = event.clientY - this.#dragState.startY;

    this.#transform.x = this.#dragState.startTX + dx;
    this.#transform.y = this.#dragState.startTY + dy;
    this.#applyTransform();
  }

  #handleMouseUp(event) {
    if (!this.#dragState.isDragging) return;
    this.#dragState.isDragging = false;
    this.style.cursor = "";

    // sync #side with the frame the user actually panned to
    if (!this.#center && !this.#left?.blank && !this.#right?.blank) {
      const leftWidth = (this.#left.width ?? 0) * this.#transform.scale;
      const viewportCenterInWrapper =
        this.getBoundingClientRect().width / 2 - this.#transform.x;
      this.#side = viewportCenterInWrapper < leftWidth ? "left" : "right";
    }
  }

  async #createFrame({ index, src: srcOption }, frameId) {
    const srcOptionIsString = typeof srcOption === "string";
    const src = srcOptionIsString ? srcOption : srcOption?.src;
    const onZoom = srcOptionIsString ? null : srcOption?.onZoom;
    const element = document.createElement("div");
    element.setAttribute("dir", "ltr");
    const iframe = document.createElement("iframe");
    element.append(iframe);
    Object.assign(iframe.style, {
      border: "0",
      display: "none",
      overflow: "hidden",
    });
    iframe.setAttribute("sandbox", "allow-same-origin allow-scripts");
    iframe.setAttribute("scrolling", "no");
    iframe.setAttribute("part", "filter");
    this.#wrapper.append(element);
    if (!src) return { blank: true, element, iframe, frameId };
    return new Promise((resolve) => {
      iframe.addEventListener(
        "load",
        () => {
          const doc = iframe.contentDocument;
          this.dispatchEvent(
            new CustomEvent("load", { detail: { doc, index } }),
          );
          const { width, height } = getViewport(doc, this.defaultViewport);

          this.#attachEventListenersToIframe(doc, frameId, { element, iframe });

          resolve({
            element,
            iframe,
            width: parseFloat(width),
            height: parseFloat(height),
            onZoom,
            frameId,
          });
        },
        { once: true },
      );
      iframe.src = src;
    });
  }

  #attachEventListenersToIframe(doc, frameId, frame) {
    const convertCoords = (e) => {
      const iframeRect = frame.iframe.getBoundingClientRect();
      const flRect = this.getBoundingClientRect();
      const scaleX = iframeRect.width / (doc.documentElement.clientWidth || 1);
      const scaleY =
        iframeRect.height / (doc.documentElement.clientHeight || 1);
      return {
        clientX: iframeRect.left - flRect.left + e.clientX * scaleX,
        clientY: iframeRect.top - flRect.top + e.clientY * scaleY,
      };
    };
    if (!doc) return;

    const images = doc.querySelectorAll("img");
    images.forEach((img) => {
      img.setAttribute("draggable", "false");
      img.style.userSelect = "none";
      img.style.webkitUserDrag = "none";
      img.style.WebkitUserDrag = "none";
    });

    doc.addEventListener(
      "wheel",
      (event) => {
        const { clientX, clientY } = convertCoords(event);
        const fixedLayoutEvent = new WheelEvent("wheel", {
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          deltaZ: event.deltaZ,
          deltaMode: event.deltaMode,
          clientX,
          clientY,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          bubbles: true,
          cancelable: true,
        });
        fixedLayoutEvent.sourceIframe = frameId;
        fixedLayoutEvent.sourceFrame = frame;
        this.#handleWheel(fixedLayoutEvent);
        event.preventDefault();
        event.stopPropagation();
      },
      { passive: false },
    );

    doc.addEventListener("mousedown", (event) => {
      const { clientX, clientY } = convertCoords(event);
      const mouseEvent = new MouseEvent("mousedown", {
        button: event.button,
        clientX,
        clientY,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        bubbles: true,
        cancelable: true,
      });
      mouseEvent.sourceIframe = frameId;
      mouseEvent.sourceFrame = frame;
      this.#handleMouseDown(mouseEvent);
      event.preventDefault();
    });

    doc.addEventListener("mousemove", (event) => {
      const { clientX, clientY } = convertCoords(event);
      const mouseEvent = new MouseEvent("mousemove", {
        button: event.button,
        clientX,
        clientY,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        bubbles: true,
        cancelable: true,
      });
      mouseEvent.sourceIframe = frameId;
      mouseEvent.sourceFrame = frame;
      this.#handleMouseMove(mouseEvent);
      event.preventDefault();
    });

    doc.addEventListener("mouseup", (event) => {
      const { clientX, clientY } = convertCoords(event);
      const mouseEvent = new MouseEvent("mouseup", {
        button: event.button,
        clientX,
        clientY,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        bubbles: true,
        cancelable: true,
      });
      mouseEvent.sourceIframe = frameId;
      mouseEvent.sourceFrame = frame;
      this.#handleMouseUp(mouseEvent);
      event.preventDefault();
    });
  }

  #render(side = this.#side) {
    console.log("[FXL] render:", {
      side,
      zoom: this.#zoom,
      transformScale: this.#transform.scale,
      isNumericZoom: typeof this.#zoom === "number" && !isNaN(this.#zoom),
      hasDualFrames: !this.#center && !this.#left?.blank && !this.#right?.blank,
    });
    if (!side) return;
    const left = this.#left ?? {};
    const right = this.#center ?? this.#right ?? {};
    const target = side === "left" ? left : right;
    const { width, height } = this.getBoundingClientRect();
    const portrait =
      this.spread !== "both" && this.spread !== "portrait" && height > width;
    this.#portrait = portrait;
    const blankWidth = left.width ?? right.width ?? 0;
    const blankHeight = left.height ?? right.height ?? 0;

    const scale =
      typeof this.#zoom === "number" && !isNaN(this.#zoom)
        ? this.#zoom
        : (this.#zoom === "fit-width"
            ? portrait || this.#center
              ? width / (target.width ?? blankWidth)
              : width /
                ((left.width ?? blankWidth) + (right.width ?? blankWidth))
            : portrait || this.#center
              ? Math.min(
                  width / (target.width ?? blankWidth),
                  height / (target.height ?? blankHeight),
                )
              : Math.min(
                  width /
                    ((left.width ?? blankWidth) + (right.width ?? blankWidth)),
                  height /
                    Math.max(
                      left.height ?? blankHeight,
                      right.height ?? blankHeight,
                    ),
                )) || 1;

    this.#transform.scale = scale;

    this.#updateFrameScales(scale);

    const { contentWidth, contentHeight } = this.#getContentSize();
    this.#transform.y = (height - contentHeight) / 2;

    const isNumericZoom = typeof this.#zoom === "number" && !isNaN(this.#zoom);
    const hasDualFrames =
      !this.#center && !this.#left?.blank && !this.#right?.blank;

    if (isNumericZoom && hasDualFrames) {
      const leftWidth = (this.#left.width ?? 0) * scale;
      const rightWidth = (this.#right.width ?? 0) * scale;
      if (side === "right") {
        this.#transform.x = (width - rightWidth) / 2 - leftWidth;
      } else {
        this.#transform.x = (width - leftWidth) / 2;
      }
    } else {
      this.#transform.x = (width - contentWidth) / 2;
    }

    this.#applyTransform();
  }

  async #showSpread({ left, right, center, side }) {
    this.#wrapper.replaceChildren();
    this.#left = null;
    this.#right = null;
    this.#center = null;
    if (center) {
      this.#center = await this.#createFrame(center, "center");
      this.#side = "center";
      this.#render();
    } else {
      this.#left = await this.#createFrame(left, "left");
      this.#right = await this.#createFrame(right, "right");
      this.#side = this.#left.blank
        ? "right"
        : this.#right.blank
          ? "left"
          : side;
      this.#render();
    }
  }

  #goLeft() {
    if (this.#center || this.#left?.blank) return;
    if (this.#portrait && this.#left?.element?.style?.display === "none") {
      this.#side = "left";
      this.#render();
      this.#reportLocation("page");
      return true;
    }

    // zoomed-in dual-pane - pan to left frame
    if (typeof this.#zoom === "number" && !isNaN(this.#zoom) && !this.#right?.blank) {
      if (this.#side === "right") {
        this.#side = "left";
        this.#render();
        return true;
      }
    }
  }

  #goRight() {
    if (this.#center || this.#right?.blank) return;
    if (this.#portrait && this.#right?.element?.style?.display === "none") {
      this.#side = "right";
      this.#render();
      this.#reportLocation("page");
      return true;
    }

    // zoomed-in dual-pane - pan to right frame
    if (typeof this.#zoom === "number" && !isNaN(this.#zoom) && !this.#left?.blank) {
      if (this.#side === "left") {
        this.#side = "right";
        this.#render();
        return true;
      }
    }
  }

  open(book) {
    this.book = book;
    const { rendition } = book;
    this.spread = rendition?.spread;
    this.defaultViewport = rendition?.viewport;

    const rtl = book.dir === "rtl";
    const ltr = !rtl;
    this.rtl = rtl;

    if (rendition?.spread === "none")
      this.#spreads = book.sections.map((section) => ({ center: section }));
    else
      this.#spreads = book.sections.reduce(
        (arr, section, i) => {
          const last = arr[arr.length - 1];
          const { pageSpread } = section;
          const newSpread = () => {
            const spread = {};
            arr.push(spread);
            return spread;
          };
          if (pageSpread === "center") {
            const spread = last.left || last.right ? newSpread() : last;
            spread.center = section;
          } else if (pageSpread === "left") {
            const spread =
              last.center || last.left || (ltr && i) ? newSpread() : last;
            spread.left = section;
          } else if (pageSpread === "right") {
            const spread =
              last.center || last.right || (rtl && i) ? newSpread() : last;
            spread.right = section;
          } else if (ltr) {
            if (last.center || last.right) newSpread().left = section;
            else if (last.left || !i) last.right = section;
            else last.left = section;
          } else {
            if (last.center || last.left) newSpread().right = section;
            else if (last.right || !i) last.left = section;
            else last.right = section;
          }
          return arr;
        },
        [{}],
      );
  }

  get index() {
    const spread = this.#spreads[this.#index];
    const section =
      spread?.center ??
      (this.#side === "left"
        ? (spread.left ?? spread.right)
        : (spread.right ?? spread.left));
    return this.book.sections.indexOf(section);
  }

  #reportLocation(reason) {
    this.dispatchEvent(
      new CustomEvent("relocate", {
        detail: {
          reason,
          range: null,
          index: this.index,
          fraction: 0,
          size: 1,
        },
      }),
    );
  }

  getSpreadOf(section) {
    const spreads = this.#spreads;
    for (let index = 0; index < spreads.length; index++) {
      const { left, right, center } = spreads[index];
      if (left === section) return { index, side: "left" };
      if (right === section) return { index, side: "right" };
      if (center === section) return { index, side: "center" };
    }
  }

  async goToSpread(index, side, reason) {
    if (index < 0 || index > this.#spreads.length - 1) return;
    if (index === this.#index) {
      this.#render(side);
      return;
    }
    this.#index = index;
    const spread = this.#spreads[index];
    if (spread.center) {
      const index = this.book.sections.indexOf(spread.center);
      const src = await spread.center?.load?.();
      await this.#showSpread({ center: { index, src } });
    } else {
      const indexL = this.book.sections.indexOf(spread.left);
      const indexR = this.book.sections.indexOf(spread.right);
      const srcL = await spread.left?.load?.();
      const srcR = await spread.right?.load?.();
      const left = { index: indexL, src: srcL };
      const right = { index: indexR, src: srcR };
      await this.#showSpread({ left, right, side });
    }
    this.#reportLocation(reason);
  }

  async select(target) {
    await this.goTo(target);
  }

  async goTo(target) {
    const { book } = this;
    const resolved = await target;
    const section = book.sections[resolved.index];
    if (!section) return;
    const { index, side } = this.getSpreadOf(section);
    await this.goToSpread(index, side);
  }

  async next() {
    const s = this.rtl ? this.#goLeft() : this.#goRight();
    if (!s)
      return this.goToSpread(
        this.#index + 1,
        this.rtl ? "right" : "left",
        "page",
      );
  }

  async prev() {
    const s = this.rtl ? this.#goRight() : this.#goLeft();
    if (!s)
      return this.goToSpread(
        this.#index - 1,
        this.rtl ? "left" : "right",
        "page",
      );
  }

  getContents() {
    return Array.from(this.#root.querySelectorAll("iframe"), (frame) => ({
      doc: frame.contentDocument,
    }));
  }

  destroy() {
    this.#observer.unobserve(this);
  }
}

customElements.define("foliate-fxl", FixedLayout);
