const parseViewport = (str) =>
  str
    ?.split(/[,;\s]/) // NOTE: technically, only the comma is valid
    ?.filter((x) => x)
    ?.map((x) => x.split("=").map((x) => x.trim()));

const getViewport = (doc, viewport) => {
  // use `viewBox` for SVG
  if (doc.documentElement.localName === "svg") {
    const [, , width, height] =
      doc.documentElement.getAttribute("viewBox")?.split(/\s/) ?? [];
    return { width, height };
  }

  // get `viewport` `meta` element
  const meta = parseViewport(
    doc.querySelector('meta[name="viewport"]')?.getAttribute("content"),
  );
  if (meta) return Object.fromEntries(meta);

  // fallback to book's viewport
  if (typeof viewport === "string") return parseViewport(viewport);
  if (viewport?.width && viewport.height) return viewport;

  // if no viewport (possibly with image directly in spine), get image size
  const img = doc.querySelector("img");
  if (img) return { width: img.naturalWidth, height: img.naturalHeight };

  // just show *something*, i guess...
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
  #zoomState = {
    minScale: 0.1,
    maxScale: 10,
    zoomStep: 0.1,
  };
  #dragState = {
    isDragging: false,
    isPotentialDrag: false,
    dragTimeout: null,
    pressDelay: 200, // milliseconds
    startX: 0,
    startY: 0,
    scrollLeft: 0,
    scrollTop: 0,
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
            display: flex;
            justify-content: center;
            align-items: center;
            overflow: auto;
        }`);

    this.#observer.observe(this);
    // DEBUG: Log initialization
    console.log("[FixedLayout Debug] ✓ FixedLayout initialized", {
      hasZoomState: !!this.#zoomState,
      hasDragState: !!this.#dragState,
      hasMagnifier: !!this.#magnifier,
      zoomState: this.#zoomState,
      dragState: this.#dragState,
    });
    // NOTE: Event listeners will be attached to wrapper elements in #showSpread
    console.log(
      "[FixedLayout Debug] Event listeners will be attached to frame wrappers",
    );
    // NOTE: Event listeners will be attached to iframe documents in #createFrame
    console.log(
      "[FixedLayout Debug] Event listeners will be attached to iframe documents",
    );
  }
  attributeChangedCallback(name, _, value) {
    switch (name) {
      case "zoom":
        this.#zoom =
          value !== "fit-width" && value !== "fit-page"
            ? parseFloat(value)
            : value;
        this.#render();
        break;
    }
  }
  toggleMagnifier() {
    console.log("[FixedLayout Debug] 🔍 Toggle magnifier:", {
      current: this.#magnifier.enabled,
      willBe: !this.#magnifier.enabled,
    });

    this.#magnifier.enabled = !this.#magnifier.enabled;

    if (this.#magnifier.enabled) {
      this.#createMagnifier();
      this.addEventListener("mousemove", this.#handleMagnifierMove.bind(this));
      this.style.cursor = "crosshair";
      console.log("[FixedLayout Debug] ✅ Magnifier enabled");
    } else {
      this.#destroyMagnifier();
      this.removeEventListener(
        "mousemove",
        this.#handleMagnifierMove.bind(this),
      );
      this.style.cursor = "";
      console.log("[FixedLayout Debug] ❌ Magnifier disabled");
    }
  }

  #createMagnifier() {
    if (this.#magnifier.element) {
      console.log("[FixedLayout Debug] ⏸️ Magnifier already exists");
      return;
    }
    console.log("[FixedLayout Debug] 🔧 Creating magnifier element");

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
    console.log("[FixedLayout Debug] ✅ Magnifier element created");
  }

  #destroyMagnifier() {
    if (this.#magnifier.element) {
      this.#magnifier.element.remove();
      this.#magnifier.element = null;
      console.log("[FixedLayout Debug] ✅ Magnifier destroyed");
    }
  }

  #handleMagnifierMove(event) {
    if (!this.#magnifier.enabled) return;

    const rect = this.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    // Position magnifier
    const magnifier = this.#magnifier.element;
    magnifier.style.display = "block";
    magnifier.style.left = `${x - this.#magnifier.size / 2}px`;
    magnifier.style.top = `${y - this.#magnifier.size / 2}px`;

    // Update lens (clone and zoom iframe content)
    const lens = magnifier.querySelector(".magnifier-lens");
    const frame = this.#center || this.#left || this.#right;
    if (frame?.iframe) {
      const iframe = frame.iframe;
      lens.innerHTML = "";
      lens.appendChild(iframe.cloneNode(true));
      lens.style.transform = `scale(${this.#magnifier.magnification})`;

      const iframeRect = iframe.getBoundingClientRect();
      const relX = (x - iframeRect.left) / (this.#zoom || 1);
      const relY = (y - iframeRect.top) / (this.#zoom || 1);

      lens.style.transformOrigin = `${-relX + this.#magnifier.size / 2}px ${-relY + this.#magnifier.size / 2}px`;
    }
  }
  #handleWheel(event) {
    console.log("[FixedLayout Debug] 🖱️ Wheel event:", {
      deltaY: event.deltaY,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      panelMode: this.hasAttribute("panel-mode"),
      currentZoom: this.#zoom,
    });
    // Don't interfere with panel mode
    if (this.hasAttribute("panel-mode")) {
      console.log("[FixedLayout Debug] ⏸️ Ignoring wheel - panel mode active");
      return;
    }

    // Allow browser zoom with Ctrl/Cmd
    if (event.ctrlKey || event.metaKey) {
      console.log(
        "[FixedLayout Debug] ⏸️ Ignoring wheel - browser zoom shortcut",
      );
      return;
    }
    event.preventDefault();

    const delta = event.deltaY;
    const rect = this.getBoundingClientRect();

    // Current zoom level (default to fit-page if not set)
    const oldScale =
      this.#zoom === "fit-page" || this.#zoom === "fit-width"
        ? 1
        : this.#zoom || 1;

    // Calculate new scale
    const zoomFactor =
      delta > 0 ? 1 - this.#zoomState.zoomStep : 1 + this.#zoomState.zoomStep;
    const newScale = Math.min(
      this.#zoomState.maxScale,
      Math.max(this.#zoomState.minScale, oldScale * zoomFactor),
    );

    // Zoom toward cursor position
    const cursorX = event.clientX - rect.left;
    const cursorY = event.clientY - rect.top;

    const scaleChange = newScale / oldScale;
    const newScrollX =
      (this.scrollLeft + this.dragOffset.x + cursorX) * scaleChange -
      cursorX -
      this.dragOffset.x;
    const newScrollY =
      (this.scrollTop + this.dragOffset.y + cursorY) * scaleChange -
      cursorY -
      this.dragOffset.y;
    // Apply zoom
    console.log("[FixedLayout Debug] 🔍 Applying zoom:", {
      oldScale,
      newScale,
      cursorX,
      cursorY,
      dragOffsetX: this.dragOffset.x,
      dragOffsetY: this.dragOffset.y,
      newScrollX,
      newScrollY,
    });
    // Apply zoom
    this.setAttribute("zoom", newScale);
    this.scrollTo(newScrollX, newScrollY);
  }

  #handleMouseDown(event) {
    console.log("[FixedLayout Debug] 🖱️ Mouse down:", {
      button: event.button,
      clientX: event.clientX,
      clientY: event.clientY,
    });
    // Only left mouse button
    if (event.button !== 0) {
      console.log("[FixedLayout Debug] ⏸️ Ignoring - not left button");
      return;
    }

    // Store initial state
    this.#dragState.startX = event.clientX;
    this.#dragState.startY = event.clientY;
    this.#dragState.scrollLeft = this.scrollLeft;
    this.#dragState.scrollTop = this.scrollTop;
    this.#dragState.isPotentialDrag = true;
    console.log(
      "[FixedLayout Debug] ⏱️ Potential drag started, timeout set for",
      this.#dragState.pressDelay,
      "ms",
    );

    // Start timer to detect long press
    this.#dragState.dragTimeout = setTimeout(() => {
      // If we haven't moved much and haven't released yet, it's a drag
      if (this.#dragState.isPotentialDrag) {
        console.log("[FixedLayout Debug] ✋ DRAG MODE ACTIVATED (timeout)");
        this.#dragState.isDragging = true;
        this.dragOffset.x = 0;
        this.dragOffset.y = 0;
        this.style.cursor = "grabbing";

        // Prevent text selection while dragging
        event.preventDefault();
      }
    }, this.#dragState.pressDelay);
  }

  #handleMouseMove(event) {
    // Check if this is the start of a drag (moved during potential drag)
    if (this.#dragState.isPotentialDrag) {
      const dx = event.clientX - this.#dragState.startX;
      const dy = event.clientY - this.#dragState.startY;
      const moved = Math.sqrt(dx * dx + dy * dy);

      console.log("[FixedLayout Debug] 📐 Measuring movement:", {
        dx,
        dy,
        moved: moved.toFixed(2),
        threshold: 3,
      });

      // If moved more than 3 pixels, start dragging immediately
      if (moved > 3) {
        console.log(
          "[FixedLayout Debug] ✋ DRAG MODE ACTIVATED (movement > 3px)",
        );
        clearTimeout(this.#dragState.dragTimeout);
        this.#dragState.isPotentialDrag = false;
        this.#dragState.isDragging = true;
        this.dragOffset.x = 0;
        this.dragOffset.y = 0;
        this.style.cursor = "grabbing";
      }
    }

    // Handle actual drag
    if (this.#dragState.isDragging) {
      event.preventDefault();

      const dx = event.clientX - this.#dragState.startX;
      const dy = event.clientY - this.#dragState.startY;

      console.log("[FixedLayout Debug] 🎯 Dragging:", {
        dx,
        dy,
        from: `(${this.dragOffset.x}, ${this.dragOffset.y})`,
        to: `(${this.dragOffset.x - dx}, ${this.dragOffset.y - dy})`,
      });

      // Update drag offset instead of scrolling
      this.dragOffset.x += dx;
      this.dragOffset.y += dy;

      // Re-render with new drag offset
      const newScrollX = this.#dragState.scrollLeft - this.dragOffset.x;
      const newScrollY = this.#dragState.scrollTop - this.dragOffset.y;
      this.scrollLeft = newScrollX;
      this.scrollTop = newScrollY;
    }
  }

  #handleMouseUp(event) {
    console.log("[FixedLayout Debug] 🖱️ Mouse up:", {
      wasDragging: this.#dragState.isDragging,
      wasPotentialDrag: this.#dragState.isPotentialDrag,
      hasTimeout: !!this.#dragState.dragTimeout,
    });
    // Clear any pending drag timeout
    if (this.#dragState.dragTimeout) {
      console.log("[FixedLayout Debug] ⏱️ Clearing drag timeout");
      clearTimeout(this.#dragState.dragTimeout);
      this.#dragState.dragTimeout = null;
    }
    // Reset drag state
    const wasDragging = this.#dragState.isDragging;
    this.#dragState.isDragging = false;
    this.#dragState.isPotentialDrag = false;
    this.style.cursor = "";
    this.dragOffset.x = 0;
    this.dragOffset.y = 0;
    // NEW: Reset drag offset when drag completes
    if (wasDragging) {
      console.log("[FixedLayout Debug] ✅ Drag completed");
      this.dragOffset.x = 0;
      this.dragOffset.y = 0;
      this.#render(); // Apply the reset
    }
  }

  async #createFrame({ index, src: srcOption }) {
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
    // `allow-scripts` is needed for events because of WebKit bug
    // https://bugs.webkit.org/show_bug.cgi?id=218086
    iframe.setAttribute("sandbox", "allow-same-origin allow-scripts");
    iframe.setAttribute("scrolling", "no");
    iframe.setAttribute("part", "filter");
    this.#root.append(element);
    if (!src) return { blank: true, element, iframe };
    return new Promise((resolve) => {
      iframe.addEventListener(
        "load",
        () => {
          const doc = iframe.contentDocument;
          this.dispatchEvent(
            new CustomEvent("load", { detail: { doc, index } }),
          );
          const { width, height } = getViewport(doc, this.defaultViewport);

          // NEW: Attach event listeners INSIDE the iframe document
          this.#attachEventListenersToIframe(doc);

          resolve({
            element,
            iframe,
            width: parseFloat(width),
            height: parseFloat(height),
            onZoom,
          });
        },
        { once: true },
      );
      iframe.src = src;
    });
  }
  #attachEventListenersToIframe(doc) {
    if (!doc) {
      console.log("[FixedLayout Debug] ⏸️ No document to attach listeners");
      return;
    }

    console.log(
      "[FixedLayout Debug] 🔧 Attaching event listeners to iframe document",
    );

    // Attach wheel event listener for zoom to the iframe's document
    doc.addEventListener(
      "wheel",
      (event) => {
        // Re-target to FixedLayout element so handler can access scroll position
        const fixedLayoutEvent = new WheelEvent("wheel", {
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          deltaZ: event.deltaZ,
          deltaMode: event.deltaMode,
          clientX: event.clientX,
          clientY: event.clientY,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          bubbles: true,
          cancelable: true,
        });

        // Call our handler with the event
        this.#handleWheel(fixedLayoutEvent);

        // Prevent default in iframe
        event.preventDefault();
        event.stopPropagation();
      },
      { passive: false },
    );

    console.log(
      "[FixedLayout Debug] ✓ Wheel listener attached to iframe document",
    );

    // Attach mouse drag support for pan to the iframe's document
    doc.addEventListener("mousedown", (event) => {
      console.log("[FixedLayout Debug] 🖱️ Mouse down inside iframe:", {
        button: event.button,
        clientX: event.clientX,
        clientY: event.clientY,
        target: event.target.tagName,
      });

      // Re-target to FixedLayout element
      const mouseEvent = new MouseEvent("mousedown", {
        button: event.button,
        clientX: event.clientX,
        clientY: event.clientY,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        bubbles: true,
        cancelable: true,
      });

      this.#handleMouseDown(mouseEvent);
    });

    doc.addEventListener("mousemove", (event) => {
      const mouseEvent = new MouseEvent("mousemove", {
        button: event.button,
        clientX: event.clientX,
        clientY: event.clientY,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        bubbles: true,
        cancelable: true,
      });

      this.#handleMouseMove(mouseEvent);
    });

    doc.addEventListener("mouseup", (event) => {
      const mouseEvent = new MouseEvent("mouseup", {
        button: event.button,
        clientX: event.clientX,
        clientY: event.clientY,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        bubbles: true,
        cancelable: true,
      });

      this.#handleMouseUp(mouseEvent);
    });

    console.log(
      "[FixedLayout Debug] ✓ Mouse drag listeners attached to iframe document",
    );
  }
  #render(side = this.#side) {
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
        marginBlock: "auto",
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
  async #showSpread({ left, right, center, side }) {
    this.#root.replaceChildren();
    console.log("[FixedLayout Debug] 🧹 Old frame wrappers removed");
    this.#left = null;
    this.#right = null;
    this.#center = null;
    if (center) {
      this.#center = await this.#createFrame(center);
      this.#side = "center";
      this.#render();
    } else {
      this.#left = await this.#createFrame(left);
      this.#right = await this.#createFrame(right);
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
  }
  #goRight() {
    if (this.#center || this.#right?.blank) return;
    if (this.#portrait && this.#right?.element?.style?.display === "none") {
      this.#side = "right";
      this.#render();
      this.#reportLocation("page");
      return true;
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
    // TODO
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
      // TODO: index, overlayer
    }));
  }
  destroy() {
    this.#observer.unobserve(this);
  }
}

customElements.define("foliate-fxl", FixedLayout);
