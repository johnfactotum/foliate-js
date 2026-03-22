import 'construct-style-sheets-polyfill'

const parseViewport = str => str
    ?.split(/[,;\s]/) // NOTE: technically, only the comma is valid
    ?.filter(x => x)
    ?.map(x => x.split('=').map(x => x.trim()))

const getViewport = (doc, viewport) => {
    // use `viewBox` for SVG
    if (doc.documentElement.localName === 'svg') {
        const [, , width, height] = doc.documentElement
            .getAttribute('viewBox')?.split(/\s/) ?? []
        return { width, height }
    }

    // get `viewport` `meta` element
    const meta = parseViewport(doc.querySelector('meta[name="viewport"]')
        ?.getAttribute('content'))
    if (meta) return Object.fromEntries(meta)

    // fallback to book's viewport
    if (typeof viewport === 'string') return parseViewport(viewport)
    if (viewport?.width && viewport.height) return viewport

    // if no viewport (possibly with image directly in spine), get image size
    const img = doc.querySelector('img')
    if (img) return { width: img.naturalWidth, height: img.naturalHeight }

    // just show *something*, i guess...
    console.warn(new Error('Missing viewport properties'))
    return { width: 1000, height: 2000 }
}

export class FixedLayout extends HTMLElement {
    static observedAttributes = ['zoom', 'scale-factor', 'spread', 'flow']
    #root = this.attachShadow({ mode: 'open' })
    #observer = new ResizeObserver(() => this.#render())
    #spreads
    #index = -1
    defaultViewport
    spread
    #portrait = false
    #left
    #right
    #center
    #side
    #zoom
    #scaleFactor = 1.0
    #totalScaleFactor = 1.0
    #scrollLocked = false
    #isOverflowX = false
    #isOverflowY = false
    #preloadCache = new Map()
    #prerenderedSpreads = new Map()
    #spreadAccessTime = new Map()
    #maxConcurrentPreloads = 1
    #numPrerenderedSpreads = 1
    #maxCachedSpreads = 2
    #overlayers = new Map()
    #preloadQueue = []
    #activePreloads = 0
    // Scroll mode fields
    #scrollMode = false
    #scrollPages = []
    #scrollObserver = null
    #scrollContainer = null
    #scrollLoadGen = new Map()
    #scrollMaxLoaded = 8
    #scrollIdleTimer = null
    #scrollCurrentIndex = -1
    constructor() {
        super()

        const sheet = new CSSStyleSheet()
        this.#root.adoptedStyleSheets = [sheet]
        sheet.replaceSync(`:host {
            width: 100%;
            height: 100%;
            display: flex;
            justify-content: flex-start;
            align-items: center;
            overflow: auto;
        }
        @supports (justify-content: safe center) {
          :host {
            justify-content: safe center;
          }
        }
        :host([flow="scrolled"]) {
            display: block;
            overflow-y: auto;
            overflow-x: hidden;
        }
        :host([flow="scrolled"]) .scroll-container {
            display: flex;
            flex-direction: column;
            align-items: center;
            min-height: 100%;
            background-color: var(--scroll-bg-color);
            background-opacity: var(--scroll-bg-opacity);
        }
        :host([flow="scrolled"]) .scroll-page {
            position: relative;
            flex-shrink: 0;
            overflow: hidden;
            margin: 4px 0;
        }
        :host([flow="scrolled"]) .scroll-page iframe {
            pointer-events: none;
        }`)

        this.#observer.observe(this)
    }
    attributeChangedCallback(name, _, value) {
        switch (name) {
            case 'zoom':
                this.#zoom = value !== 'fit-width' && value !== 'fit-page'
                    ? parseFloat(value) : value
                this.#render()
                break
            case 'scale-factor':
                this.#scaleFactor = parseFloat(value) / 100
                this.#render()
                break
            case 'spread':
                this.#respread(value)
                break
            case 'flow':
                if (value === 'scrolled' && !this.#scrollMode) {
                    // Capture index from paginated mode BEFORE setting scroll flag
                    const savedIndex = this.index
                    this.#scrollMode = true
                    if (this.book) this.#initScrollMode(savedIndex)
                } else if (value !== 'scrolled' && this.#scrollMode) {
                    this.#destroyScrollMode()
                    this.#scrollMode = false
                    this.#render()
                }
                break
        }
    }
    async #createFrame({ index, src: srcOption, detached = false }) {
        const srcOptionIsString = typeof srcOption === 'string'
        const src = srcOptionIsString ? srcOption : srcOption?.src
        const data = srcOptionIsString ? null : srcOption?.data
        const onZoom = srcOptionIsString ? null : srcOption?.onZoom
        const element = document.createElement('div')
        element.setAttribute('dir', 'ltr')
        element.style.position = 'relative'
        const iframe = document.createElement('iframe')
        element.append(iframe)
        Object.assign(iframe.style, {
            border: '0',
            display: 'none',
            overflow: 'hidden',
        })
        // `allow-scripts` is needed for events because of WebKit bug
        // https://bugs.webkit.org/show_bug.cgi?id=218086
        iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts')
        iframe.setAttribute('scrolling', 'no')
        iframe.setAttribute('part', 'filter')
        this.#root.append(element)

        if (detached) {
            Object.assign(element.style, {
                position: 'absolute',
                visibility: 'hidden',
                pointerEvents: 'none',
            })
        }

        if (!src) return { blank: true, element, iframe }
        return new Promise(resolve => {
            iframe.addEventListener('load', () => {
                const doc = iframe.contentDocument
                iframe.dataset.sectionIndex = index
                this.dispatchEvent(new CustomEvent('load', { detail: { doc, index } }))
                const { width, height } = getViewport(doc, this.defaultViewport)
                resolve({
                    element, iframe,
                    width: parseFloat(width),
                    height: parseFloat(height),
                    onZoom,
                    detached,
                })
            }, { once: true })
            if (data) {
                iframe.srcdoc = data
            } else {
                iframe.src = src
            }
        })
    }
    #render(side = this.#side) {
        if (this.#scrollMode) {
            this.#renderScrollMode()
            return []
        }
        if (!side) return []
        const left = this.#left ?? {}
        const right = this.#center ?? this.#right ?? {}
        const target = side === 'left' ? left : right
        const { width, height } = this.getBoundingClientRect()
        // for unfolded devices with slightly taller height than width also use landscape layout
        const portrait = this.spread !== 'both' && this.spread !== 'portrait'
            && height > width * 1.2
        this.#portrait = portrait
        const blankWidth = left.width ?? right.width ?? 0
        const blankHeight = left.height ?? right.height ?? 0

        let scale = typeof this.#zoom === 'number' && !isNaN(this.#zoom)
            ? this.#zoom
            : (this.#zoom === 'fit-width'
                ? (portrait || this.#center
                    ? width / (target.width ?? blankWidth)
                    : width / ((left.width ?? blankWidth) + (right.width ?? blankWidth)))
                : (portrait || this.#center
                    ? Math.min(
                        width / (target.width ?? blankWidth),
                        height / (target.height ?? blankHeight))
                    : Math.min(
                        width / ((left.width ?? blankWidth) + (right.width ?? blankWidth)),
                        height / Math.max(
                            left.height ?? blankHeight,
                            right.height ?? blankHeight)))
            ) || 1

        scale *= this.#scaleFactor
        this.#totalScaleFactor = scale

        const renderPromises = []
        const transform = ({frame, styles}) => {
            let { element, iframe, width, height, blank, onZoom } = frame
            if (!iframe) return
            if (onZoom) {
                const p = onZoom({ doc: frame.iframe.contentDocument, scale })
                if (p?.then) renderPromises.push(p)
            }
            const iframeScale = onZoom ? scale : 1
            const zoomedOut = this.#scaleFactor < 1.0
            Object.assign(iframe.style, {
                width: `${width * iframeScale}px`,
                height: `${height * iframeScale}px`,
                transform: onZoom ? 'none' : `scale(${scale})`,
                transformOrigin: 'top left',
                display: blank ? 'none' : 'block',
            })
            Object.assign(element.style, {
                width: `${(width ?? blankWidth) * scale}px`,
                height: `${(height ?? blankHeight) * scale}px`,
                flexShrink: '0',
                display: zoomedOut ? 'flex' : 'block',
                marginBlock: zoomedOut ? undefined : 'auto',
                alignItems: zoomedOut ? 'center' : undefined,
                justifyContent: zoomedOut ? 'center' : undefined,
                ...styles,
            })
            if (portrait && frame !== target) {
                element.style.display = 'none'
            }

            // position and redraw overlayer to match the scaled iframe
            const sectionIndex = iframe.dataset.sectionIndex != null
                ? parseInt(iframe.dataset.sectionIndex) : undefined
            if (sectionIndex != null) {
                const overlayer = this.#overlayers.get(sectionIndex)
                if (overlayer) {
                    Object.assign(overlayer.element.style, {
                        position: 'absolute',
                        top: '0',
                        left: '0',
                        width: `${(width ?? blankWidth) * scale}px`,
                        height: `${(height ?? blankHeight) * scale}px`,
                    })
                    overlayer.redraw()
                }
            }

            const container= element.parentNode?.host
            if (!container) return
            const containerWidth = container.clientWidth
            const containerHeight = container.clientHeight
            container.scrollLeft = (element.clientWidth - containerWidth) / 2

            return {
                width: element.clientWidth,
                height: element.clientHeight,
                containerWidth,
                containerHeight,
            }
        }
        if (this.#center) {
            const dimensions = transform({frame: this.#center, styles: { marginInline: 'auto' }})
            if (!dimensions) return renderPromises
            const {width, height, containerWidth, containerHeight} = dimensions
            this.#isOverflowX = width > containerWidth
            this.#isOverflowY = height > containerHeight
        } else {
            const leftDimensions = transform({frame: left, styles: { marginInlineStart: 'auto' }})
            const rightDimensions = transform({frame: right, styles: { marginInlineEnd: 'auto' }})
            if (!leftDimensions || !rightDimensions) return renderPromises
            const {width: leftWidth, height: leftHeight, containerWidth, containerHeight} = leftDimensions
            const {width: rightWidth, height: rightHeight} = rightDimensions
            this.#isOverflowX = leftWidth + rightWidth > containerWidth
            this.#isOverflowY = Math.max(leftHeight, rightHeight) > containerHeight
        }
        return renderPromises
    }
    async #showSpread({ left, right, center, side, spreadIndex }) {
        this.#left = null
        this.#right = null
        this.#center = null

        const cacheKey = spreadIndex !== undefined ? `spread-${spreadIndex}` : null
        const prerendered = cacheKey ? this.#prerenderedSpreads.get(cacheKey) : null

        if (prerendered) {
            this.#spreadAccessTime.set(cacheKey, Date.now())
            if (prerendered.center) {
                this.#center = prerendered.center
            } else {
                this.#left = prerendered.left
                this.#right = prerendered.right
            }
        } else {
            if (center) {
                this.#center = await this.#createFrame(center)
                if (cacheKey) {
                    this.#prerenderedSpreads.set(cacheKey, { center: this.#center })
                    this.#spreadAccessTime.set(cacheKey, Date.now())
                }
            } else {
                this.#left = await this.#createFrame(left)
                this.#right = await this.#createFrame(right)
                if (cacheKey) {
                    this.#prerenderedSpreads.set(cacheKey, { left: this.#left, right: this.#right })
                    this.#spreadAccessTime.set(cacheKey, Date.now())
                }
            }
        }

        this.#side = center ? 'center' : this.#left?.blank ? 'right'
            : this.#right?.blank ? 'left' : side
        const visibleFrames = center
            ? [this.#center?.element]
            : [this.#left?.element, this.#right?.element]

        Array.from(this.#root.children).forEach(child => {
            const isVisible = visibleFrames.includes(child)
            Object.assign(child.style, {
                position: isVisible ? 'relative' : 'absolute',
                visibility: isVisible ? 'visible' : 'hidden',
                pointerEvents: isVisible ? 'auto' : 'none',
            })
        })

        // Render layout and await any async onZoom callbacks (e.g. PDF text
        // layer rendering) so the document is fully populated before overlayers
        // try to resolve CFIs against it.
        const renderPromises = this.#render()
        if (renderPromises.length) await Promise.all(renderPromises)

        const showingFrames = center
            ? [this.#center]
            : [this.#left, this.#right]
        for (const frame of showingFrames) {
            if (!frame?.iframe) continue
            const index = frame.iframe.dataset.sectionIndex != null
                ? parseInt(frame.iframe.dataset.sectionIndex) : undefined
            if (index != null && !this.#overlayers.has(index)) {
                const doc = frame.iframe.contentDocument
                if (doc) {
                    this.dispatchEvent(new CustomEvent('create-overlayer', {
                        detail: {
                            doc, index,
                            attach: overlayer => {
                                this.#overlayers.set(index, overlayer)
                                frame.element.append(overlayer.element)
                            },
                        },
                    }))
                }
            }
        }
    }
    #initScrollMode(targetIndex = 0) {
        const currentIndex = targetIndex

        // Hide all paginated content
        for (const child of Array.from(this.#root.children)) {
            child.style.display = 'none'
        }

        this.#scrollContainer = document.createElement('div')
        this.#scrollContainer.className = 'scroll-container'
        this.#root.append(this.#scrollContainer)

        const sections = this.book.sections
        const viewport = this.defaultViewport
        const vw = viewport?.width ?? 1000
        const vh = viewport?.height ?? 1400
        this.#scrollPages = sections.map((section, i) => {
            const el = document.createElement('div')
            el.className = 'scroll-page'
            el.dataset.index = i
            this.#scrollContainer.append(el)
            return { el, index: i, section, state: 'idle', frame: null, vpWidth: vw, vpHeight: vh }
        })

        this.#renderScrollMode()

        // Scroll to target position BEFORE setting up the observer
        // so only pages near the target are observed as intersecting
        if (currentIndex >= 0 && currentIndex < this.#scrollPages.length) {
            this.#scrollPages[currentIndex].el.scrollIntoView()
            this.#scrollCurrentIndex = currentIndex
        }

        this.addEventListener('scroll', this.#handleScrollEvent)

        // Set up IntersectionObserver after scroll position is established.
        // rootMargin '50%' loads ~1 page buffer above/below the viewport.
        this.#scrollObserver = new IntersectionObserver(entries => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue
                const index = parseInt(entry.target.dataset.index)
                const pageData = this.#scrollPages[index]
                if (pageData && pageData.state === 'idle') {
                    this.#loadScrollPage(pageData)
                }
            }
            this.#evictScrollPages()
        }, { root: this, rootMargin: '50% 0px' })

        for (const page of this.#scrollPages) {
            this.#scrollObserver.observe(page.el)
        }
    }
    #handleScrollEvent = () => {
        // Disable iframe interaction during scroll for native smooth scrolling
        this.#setScrollIframeInteraction(false)
        if (this.#scrollIdleTimer) clearTimeout(this.#scrollIdleTimer)
        this.#scrollIdleTimer = setTimeout(() => {
            this.#setScrollIframeInteraction(true)
            // Report location only after scroll settles to avoid
            // expensive React re-renders on every frame
            this.#reportScrollLocation()
        }, 150)
    }
    #setScrollIframeInteraction(enabled) {
        const value = enabled ? 'auto' : ''
        for (const page of this.#scrollPages) {
            if (page.frame?.iframe) {
                page.frame.iframe.style.pointerEvents = value
            }
        }
    }
    #destroyScrollMode() {
        // Use the cached scroll index because by the time attributeChangedCallback
        // fires, the CSS has already switched from block/scroll to flex layout,
        // making #getScrollIndex() return incorrect positions
        const currentIndex = this.#scrollCurrentIndex >= 0
            ? this.#scrollCurrentIndex : this.#getScrollIndex()
        this.removeEventListener('scroll', this.#handleScrollEvent)
        if (this.#scrollObserver) {
            this.#scrollObserver.disconnect()
            this.#scrollObserver = null
        }
        if (this.#scrollIdleTimer) {
            clearTimeout(this.#scrollIdleTimer)
            this.#scrollIdleTimer = null
        }
        // Clean up all scroll page frames and overlayers
        for (const page of this.#scrollPages) {
            this.#teardownScrollPage(page)
        }
        this.#scrollPages = []
        this.#scrollLoadGen.clear()
        this.#scrollCurrentIndex = -1
        if (this.#scrollContainer) {
            this.#scrollContainer.remove()
            this.#scrollContainer = null
        }

        // Reset scroll position left over from scroll mode
        this.scrollTop = 0
        this.scrollLeft = 0

        // Restore paginated content
        for (const child of Array.from(this.#root.children)) {
            child.style.display = ''
        }

        // Navigate to the page we were on
        if (currentIndex >= 0) {
            const section = this.book.sections[currentIndex]
            if (section) {
                const spread = this.getSpreadOf(section)
                if (spread) {
                    this.#index = -1
                    this.goToSpread(spread.index, spread.side, 'page')
                }
            }
        }
    }
    // Create an iframe directly inside the page placeholder (no reparenting)
    async #createScrollFrame(pageData, srcOption) {
        const srcOptionIsString = typeof srcOption === 'string'
        const src = srcOptionIsString ? srcOption : srcOption?.src
        const data = srcOptionIsString ? null : srcOption?.data
        const onZoom = srcOptionIsString ? null : srcOption?.onZoom

        const element = document.createElement('div')
        element.setAttribute('dir', 'ltr')
        element.style.position = 'relative'
        const iframe = document.createElement('iframe')
        element.append(iframe)
        Object.assign(iframe.style, {
            border: '0',
            display: 'none',
            overflow: 'hidden',
        })
        iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts')
        iframe.setAttribute('scrolling', 'no')
        iframe.setAttribute('part', 'filter')
        // Place directly in the placeholder — no root append + reparent
        pageData.el.append(element)

        if (!src) return { blank: true, element, iframe }
        return new Promise(resolve => {
            iframe.addEventListener('load', () => {
                const doc = iframe.contentDocument
                iframe.dataset.sectionIndex = pageData.index
                this.dispatchEvent(new CustomEvent('load', { detail: { doc, index: pageData.index } }))
                const { width, height } = getViewport(doc, this.defaultViewport)
                resolve({
                    element, iframe,
                    width: parseFloat(width),
                    height: parseFloat(height),
                    onZoom,
                })
            }, { once: true })
            if (data) {
                iframe.srcdoc = data
            } else {
                iframe.src = src
            }
        })
    }
    async #loadScrollPage(pageData) {
        if (pageData.state !== 'idle') return
        pageData.state = 'loading'

        // Generation counter to detect stale loads
        const gen = (this.#scrollLoadGen.get(pageData.index) || 0) + 1
        this.#scrollLoadGen.set(pageData.index, gen)

        try {
            const src = await pageData.section.load?.()
            // Bail if cancelled or mode changed
            if (this.#scrollLoadGen.get(pageData.index) !== gen || !this.#scrollMode) {
                pageData.state = 'idle'
                return
            }
            if (!src) { pageData.state = 'idle'; return }

            const frame = await this.#createScrollFrame(pageData, src)
            // Bail if cancelled during frame creation
            if (this.#scrollLoadGen.get(pageData.index) !== gen || !this.#scrollMode) {
                frame.element?.remove()
                pageData.state = 'idle'
                return
            }

            pageData.frame = frame
            pageData.state = 'loaded'
            // Update dimensions from actual page viewport
            if (frame.width && frame.height) {
                pageData.vpWidth = frame.width
                pageData.vpHeight = frame.height
            }
            this.#renderScrollPage(pageData)

            // Create overlayer
            const doc = frame.iframe.contentDocument
            if (doc) {
                this.dispatchEvent(new CustomEvent('create-overlayer', {
                    detail: {
                        doc, index: pageData.index,
                        attach: overlayer => {
                            this.#overlayers.set(pageData.index, overlayer)
                            frame.element.append(overlayer.element)
                        },
                    },
                }))
                // Forward wheel events to host when iframe has pointer-events
                // (fallback for the brief window after scroll settles)
                doc.addEventListener('wheel', e => {
                    // Disable pointer-events immediately so subsequent
                    // wheel ticks use native scroll
                    this.#setScrollIframeInteraction(false)
                    this.scrollBy({ top: e.deltaY, left: e.deltaX, behavior: 'instant' })
                }, { passive: true })
            }
        } catch (e) {
            console.warn('Failed to load scroll page', pageData.index, e)
            pageData.state = 'idle'
        }
    }
    // Remove a loaded scroll page's frame and overlayer
    #teardownScrollPage(pageData) {
        // Bump generation to cancel any in-progress load
        const gen = (this.#scrollLoadGen.get(pageData.index) || 0) + 1
        this.#scrollLoadGen.set(pageData.index, gen)

        if (pageData.frame) {
            const idx = pageData.index
            this.#overlayers.delete(idx)
            pageData.frame.element?.remove()
        }
        pageData.frame = null
        pageData.state = 'idle'
    }
    // Evict the farthest loaded pages when over limit
    #evictScrollPages() {
        const loaded = this.#scrollPages.filter(p => p.state === 'loaded')
        if (loaded.length <= this.#scrollMaxLoaded) return
        const currentIndex = this.#getScrollIndex()
        loaded.sort((a, b) =>
            Math.abs(a.index - currentIndex) - Math.abs(b.index - currentIndex))
        for (const page of loaded.slice(this.#scrollMaxLoaded)) {
            this.#teardownScrollPage(page)
        }
    }
    #renderScrollMode() {
        const { width: hostWidth } = this.getBoundingClientRect()
        if (!hostWidth) return
        // Remember current page so we can restore scroll position after resize
        const currentIndex = this.#getScrollIndex()
        for (const page of this.#scrollPages) {
            const scale = (hostWidth / page.vpWidth) * this.#scaleFactor
            page.el.style.width = `${page.vpWidth * scale}px`
            page.el.style.height = `${page.vpHeight * scale}px`
            if (page.state === 'loaded' && page.frame) {
                this.#renderScrollPage(page)
            }
        }
        // Restore scroll position to keep current page in view after resize
        if (currentIndex >= 0 && currentIndex < this.#scrollPages.length) {
            this.#scrollPages[currentIndex].el.scrollIntoView()
            this.#scrollCurrentIndex = currentIndex
        }
    }
    #renderScrollPage(pageData) {
        const { width: hostWidth } = this.getBoundingClientRect()
        if (!hostWidth || !pageData.frame) return
        const { vpWidth: vw, vpHeight: vh, frame } = pageData
        const scale = (hostWidth / vw) * this.#scaleFactor

        if (frame.onZoom) {
            frame.onZoom({ doc: frame.iframe.contentDocument, scale })
            Object.assign(frame.iframe.style, {
                width: `${vw * scale}px`,
                height: `${vh * scale}px`,
                transform: 'none',
                display: 'block',
            })
        } else {
            Object.assign(frame.iframe.style, {
                width: `${vw}px`,
                height: `${vh}px`,
                transform: `scale(${scale})`,
                transformOrigin: 'top left',
                display: 'block',
            })
        }
        Object.assign(frame.element.style, {
            width: `${vw * scale}px`,
            height: `${vh * scale}px`,
        })
        // Update placeholder to match actual page dimensions
        pageData.el.style.width = `${vw * scale}px`
        pageData.el.style.height = `${vh * scale}px`

        const overlayer = this.#overlayers.get(pageData.index)
        if (overlayer) {
            Object.assign(overlayer.element.style, {
                position: 'absolute',
                top: '0',
                left: '0',
                width: `${vw * scale}px`,
                height: `${vh * scale}px`,
            })
            overlayer.redraw()
        }
    }
    #getScrollIndex() {
        if (!this.#scrollPages.length) return -1
        const hostRect = this.getBoundingClientRect()
        const midY = hostRect.top + hostRect.height / 2
        for (const page of this.#scrollPages) {
            const rect = page.el.getBoundingClientRect()
            if (rect.top <= midY && rect.bottom >= midY) return page.index
        }
        let closest = 0, minDist = Infinity
        for (const page of this.#scrollPages) {
            const rect = page.el.getBoundingClientRect()
            const dist = Math.abs(rect.top + rect.height / 2 - midY)
            if (dist < minDist) { minDist = dist; closest = page.index }
        }
        return closest
    }
    #reportScrollLocation() {
        const index = this.#getScrollIndex()
        if (index < 0) return
        this.#scrollCurrentIndex = index
        this.dispatchEvent(new CustomEvent('relocate', { detail:
            { reason: 'scroll', range: null, index, fraction: 0, size: 1 } }))
    }
    #goLeft() {
        if (this.#center || this.#left?.blank) return
        if (this.#portrait && this.#left?.element?.style?.display === 'none') {
            this.#side = 'left'
            this.#render()
            this.#reportLocation('page')
            return true
        }
    }
    #goRight() {
        if (this.#center || this.#right?.blank) return
        if (this.#portrait && this.#right?.element?.style?.display === 'none') {
            this.#side = 'right'
            this.#render()
            this.#reportLocation('page')
            return true
        }
    }
    open(book) {
        this.book = book
        this.defaultViewport = book.rendition?.viewport
        this.rtl = book.dir === 'rtl'

        this.#spread()
        if (this.#scrollMode) this.#initScrollMode()
    }
    #spread(mode) {
        const book = this.book
        const { rendition } = book
        const rtl = this.rtl
        const ltr = !rtl
        this.spread = mode || rendition?.spread

        if (this.spread === 'none')
            this.#spreads = book.sections.map(section => ({ center: section }))
        else this.#spreads = book.sections.reduce((arr, section, i) => {
            const last = arr[arr.length - 1]
            const { pageSpread } = section
            const newSpread = () => {
                const spread = {}
                arr.push(spread)
                return spread
            }
            if (pageSpread === 'center') {
                const spread = last.left || last.right ? newSpread() : last
                spread.center = section
            }
            else if (pageSpread === 'left') {
                const spread = last.center || last.left || ltr && i ? newSpread() : last
                spread.left = section
            }
            else if (pageSpread === 'right') {
                const spread = last.center || last.right || rtl && i ? newSpread() : last
                spread.right = section
            }
            else if (ltr) {
                if (last.center || last.right) newSpread().left = section
                else if (last.left || !i) last.right = section
                else last.left = section
            }
            else {
                if (last.center || last.left) newSpread().right = section
                else if (last.right || !i) last.left = section
                else last.right = section
            }
            return arr
        }, [{}])
    }
    #respread(spreadMode) {
        if (this.#index === -1) return
        const section = this.book.sections[this.index]
        this.#spread(spreadMode)
        const { index } = this.getSpreadOf(section)
        this.#index = -1
        this.#preloadCache.clear()
        for (const frames of this.#prerenderedSpreads.values()) {
            if (frames.center) {
                frames.center.element?.remove()
            } else {
                frames.left?.element?.remove()
                frames.right?.element?.remove()
            }
        }
        this.#prerenderedSpreads.clear()
        this.#spreadAccessTime.clear()
        this.#overlayers.clear()
        this.goToSpread(index, this.rtl ? 'right' : 'left', 'page')
    }
    get index() {
        if (this.#scrollMode) return this.#scrollCurrentIndex >= 0
            ? this.#scrollCurrentIndex : this.#getScrollIndex()
        if (this.#index < 0 || !this.#spreads) return -1
        const spread = this.#spreads[this.#index]
        if (!spread) return -1
        const section = spread.center ?? (this.#side === 'left'
            ? spread.left ?? spread.right : spread.right ?? spread.left)
        return this.book.sections.indexOf(section)
    }
    get scrolled() {
        return this.#scrollMode
    }
    get scrollLocked() {
        return this.#scrollLocked
    }
    set scrollLocked(value) {
        this.#scrollLocked = value
    }
    get isOverflowX() {
        return this.#isOverflowX
    }
    get isOverflowY() {
        return this.#isOverflowY
    }
    get atStart() {
        if (this.#scrollMode) return this.scrollTop <= 0
        return this.#index <= 0
    }
    get atEnd() {
        if (this.#scrollMode) return this.scrollTop + this.clientHeight >= this.scrollHeight - 2
        return this.#index >= this.#spreads.length - 1
    }
    #reportLocation(reason) {
        this.dispatchEvent(new CustomEvent('relocate', { detail:
            { reason, range: null, index: this.index, fraction: 0, size: 1 } }))
    }
    getSpreadOf(section) {
        const spreads = this.#spreads
        for (let index = 0; index < spreads.length; index++) {
            const { left, right, center } = spreads[index]
            if (left === section) return { index, side: 'left' }
            if (right === section) return { index, side: 'right' }
            if (center === section) return { index, side: 'center' }
        }
    }
    async goToSpread(index, side, reason) {
        if (index < 0 || index > this.#spreads.length - 1) return
        if (index === this.#index) {
            this.#render(side)
            return
        }
        this.#index = index
        const spread = this.#spreads[index]
        const cacheKey = `spread-${index}`
        const cached = this.#preloadCache.get(cacheKey)
        if (cached && cached !== 'loading') {
            if (cached.center) {
                const sectionIndex = this.book.sections.indexOf(spread.center)
                await this.#showSpread({ center: { index: sectionIndex, src: cached.center }, spreadIndex: index, side })
            } else {
                const indexL = this.book.sections.indexOf(spread.left)
                const indexR = this.book.sections.indexOf(spread.right)
                const left = { index: indexL, src: cached.left }
                const right = { index: indexR, src: cached.right }
                await this.#showSpread({ left, right, side, spreadIndex: index })
            }
        } else {
            if (spread.center) {
                const sectionIndex = this.book.sections.indexOf(spread.center)
                const src = await spread.center?.load?.()
                await this.#showSpread({ center: { index: sectionIndex, src }, spreadIndex: index, side })
            } else {
                const indexL = this.book.sections.indexOf(spread.left)
                const indexR = this.book.sections.indexOf(spread.right)
                const srcL = await spread.left?.load?.()
                const srcR = await spread.right?.load?.()
                const left = { index: indexL, src: srcL }
                const right = { index: indexR, src: srcR }
                await this.#showSpread({ left, right, side, spreadIndex: index })
            }
        }

        this.#reportLocation(reason)
        this.#preloadNextSpreads()
    }
    #preloadNextSpreads() {
        this.#cleanupPreloadCache()

        if (this.#numPrerenderedSpreads <= 0) return

        const toPreload = []
        const forwardPreloadCount = Math.max(1, this.#numPrerenderedSpreads - 1)
        const backwardPreloadCount = Math.max(0, this.#numPrerenderedSpreads - forwardPreloadCount)
        for (let distance = 1; distance <= forwardPreloadCount; distance++) {
            const forwardIndex = this.#index + distance
            if (forwardIndex >= 0 && forwardIndex < this.#spreads.length) {
                toPreload.push({ index: forwardIndex, direction: 'forward', distance })
            }
        }
        for (let distance = 1; distance <= backwardPreloadCount; distance++) {
            const backwardIndex = this.#index - distance
            if (backwardIndex >= 0 && backwardIndex < this.#spreads.length) {
                toPreload.push({ index: backwardIndex, direction: 'backward', distance })
            }
        }
        for (const { index: targetIndex, direction } of toPreload) {
            const cacheKey = `spread-${targetIndex}`
            if (this.#prerenderedSpreads.has(cacheKey)) continue
            const spread = this.#spreads[targetIndex]
            if (!spread) continue
            this.#preloadQueue.push({ targetIndex, direction, spread, cacheKey })
        }

        this.#processPreloadQueue()
    }

    async #processPreloadQueue() {
        while (this.#preloadQueue.length > 0 && this.#activePreloads < this.#maxConcurrentPreloads) {
            const task = this.#preloadQueue.shift()
            if (!task) break

            const { spread, cacheKey } = task
            this.#preloadCache.set(cacheKey, 'loading')
            this.#activePreloads++
            Promise.resolve().then(async () => {
                try {
                    if (spread.center) {
                        const src = await spread.center?.load?.()
                        this.#preloadCache.set(cacheKey, { center: src })

                        const sectionIndex = this.book.sections.indexOf(spread.center)
                        const frame = await this.#createFrame({ index: sectionIndex, src, detached: true })

                        this.#prerenderedSpreads.set(cacheKey, { center: frame })
                        this.#spreadAccessTime.set(cacheKey, Date.now())
                        if (frame.onZoom) {
                            const doc = frame.iframe.contentDocument
                            frame.onZoom({ doc, scale: this.#totalScaleFactor })
                        }
                    } else {
                        const srcL = await spread.left?.load?.()
                        const srcR = await spread.right?.load?.()
                        this.#preloadCache.set(cacheKey, { left: srcL, right: srcR })

                        const indexL = this.book.sections.indexOf(spread.left)
                        const indexR = this.book.sections.indexOf(spread.right)
                        const leftFrame = await this.#createFrame({ index: indexL, src: srcL, detached: true })
                        const rightFrame = await this.#createFrame({ index: indexR, src: srcR, detached: true })

                        this.#prerenderedSpreads.set(cacheKey, { left: leftFrame, right: rightFrame })
                        this.#spreadAccessTime.set(cacheKey, Date.now())

                        if (leftFrame.onZoom) {
                            const docL = leftFrame.iframe.contentDocument
                            leftFrame.onZoom({ doc: docL, scale: this.#totalScaleFactor })
                        }
                        if (rightFrame.onZoom) {
                            const docR = rightFrame.iframe.contentDocument
                            rightFrame.onZoom({ doc: docR, scale: this.#totalScaleFactor })
                        }
                    }
                } catch {
                    this.#preloadCache.delete(cacheKey)
                    this.#prerenderedSpreads.delete(cacheKey)
                } finally {
                    this.#activePreloads--
                    this.#processPreloadQueue()
                }
            })
        }
    }
    #cleanupPreloadCache() {
        const maxSpreads = this.#maxCachedSpreads
        if (this.#prerenderedSpreads.size <= maxSpreads) {
            return
        }

        const framesByAge = Array.from(this.#prerenderedSpreads.keys())
            .map(key => ({
                key,
                accessTime: this.#spreadAccessTime.get(key) || 0,
            }))
            .sort((a, b) => a.accessTime - b.accessTime)

        const numToRemove = this.#prerenderedSpreads.size - maxSpreads
        const framesToDelete = framesByAge.slice(0, numToRemove).map(item => item.key)

        if (framesToDelete.length > 0) {
            framesToDelete.forEach(key => {
                const frames = this.#prerenderedSpreads.get(key)
                if (frames) {
                    if (frames.center) {
                        this.#removeOverlayerForFrame(frames.center)
                        frames.center.element?.remove()
                    } else {
                        this.#removeOverlayerForFrame(frames.left)
                        this.#removeOverlayerForFrame(frames.right)
                        frames.left?.element?.remove()
                        frames.right?.element?.remove()
                    }
                }

                this.#prerenderedSpreads.delete(key)
                this.#spreadAccessTime.delete(key)
                this.#preloadCache.delete(key)
            })
        }
    }
    #removeOverlayerForFrame(frame) {
        if (!frame?.iframe) return
        const idx = frame.iframe.dataset.sectionIndex != null
            ? parseInt(frame.iframe.dataset.sectionIndex) : undefined
        if (idx != null) this.#overlayers.delete(idx)
    }
    async select(target) {
        await this.goTo(target)
        // TODO
    }
    async goTo(target) {
        const resolved = await target
        if (this.#scrollMode) {
            const page = this.#scrollPages[resolved.index]
            if (page) {
                page.el.scrollIntoView()
                this.#scrollCurrentIndex = resolved.index
            }
            return
        }
        const { book } = this
        const section = book.sections[resolved.index]
        if (!section) return
        const { index, side } = this.getSpreadOf(section)
        await this.goToSpread(index, side)
    }
    async next(distance) {
        if (this.#scrollMode) {
            this.scrollBy({ top: distance || this.clientHeight, behavior: 'smooth' })
            return
        }
        const s = this.rtl ? this.#goLeft() : this.#goRight()
        if (!s) return this.goToSpread(this.#index + 1, this.rtl ? 'right' : 'left', 'page')
    }
    async prev(distance) {
        if (this.#scrollMode) {
            this.scrollBy({ top: -(distance || this.clientHeight), behavior: 'smooth' })
            return
        }
        const s = this.rtl ? this.#goRight() : this.#goLeft()
        if (!s) return this.goToSpread(this.#index - 1, this.rtl ? 'left' : 'right', 'page')
    }
    nextSection() {
        if (!this.#scrollMode) return
        const currentIndex = this.#getScrollIndex()
        const nextIndex = Math.min(currentIndex + 1, this.#scrollPages.length - 1)
        this.#scrollPages[nextIndex]?.el.scrollIntoView({ behavior: 'smooth' })
        this.#scrollCurrentIndex = nextIndex
    }
    prevSection() {
        if (!this.#scrollMode) return
        const currentIndex = this.#getScrollIndex()
        const prevIndex = Math.max(currentIndex - 1, 0)
        this.#scrollPages[prevIndex]?.el.scrollIntoView({ behavior: 'smooth' })
        this.#scrollCurrentIndex = prevIndex
    }
    async pan(dx, dy) {
        if (this.#scrollMode) {
            this.scrollBy({ top: dy, left: dx, behavior: 'auto' })
            return
        }
        if (this.#scrollLocked) return
        this.#scrollLocked = true

        const transform = frame => {
            let { element, iframe } = frame
            if (!iframe || !element) return

            const scrollableContainer = element.parentNode.host
            scrollableContainer.scrollLeft += dx
            scrollableContainer.scrollTop += dy
        }

        transform(this.#center ?? this.#right ?? {})
        this.#scrollLocked = false
    }
    getContents() {
        if (this.#scrollMode) {
            return this.#scrollPages
                .filter(p => p.state === 'loaded' && p.frame?.iframe)
                .map(p => ({
                    doc: p.frame.iframe.contentDocument,
                    index: p.index,
                    overlayer: this.#overlayers.get(p.index),
                }))
        }
        return Array.from(this.#root.querySelectorAll('iframe'))
            .filter(frame => {
                const parent = frame.parentElement
                return parent && parent.style.visibility !== 'hidden'
            })
            .map(frame => {
                const index = frame.dataset.sectionIndex != null
                    ? parseInt(frame.dataset.sectionIndex) : undefined
                return {
                    doc: frame.contentDocument,
                    index,
                    overlayer: index != null ? this.#overlayers.get(index) : undefined,
                }
            })
    }
    pinchZoom(ratio) {
        const frames = this.#center
            ? [this.#center]
            : [this.#left, this.#right]
        for (const frame of frames) {
            if (!frame?.element || frame.element.style.visibility === 'hidden') continue
            frame.element.style.transform = `scale(${ratio})`
            frame.element.style.transformOrigin = 'center'
        }
    }
    pinchEnd() {
        for (const frame of [this.#center, this.#left, this.#right]) {
            if (!frame?.element) continue
            frame.element.style.removeProperty('transform')
            frame.element.style.removeProperty('transform-origin')
        }
    }
    get size() {
        return this.clientHeight
    }
    get viewSize() {
        return this.#scrollMode ? this.scrollHeight : this.clientHeight
    }
    get start() {
        return this.#scrollMode ? this.scrollTop : 0
    }
    get end() {
        return this.#scrollMode ? this.scrollTop + this.clientHeight : this.clientHeight
    }
    get page() {
        if (this.#scrollMode) return this.#scrollCurrentIndex >= 0
            ? this.#scrollCurrentIndex : this.#getScrollIndex()
        return this.#index
    }
    get pages() {
        if (this.#scrollMode) return this.#scrollPages.length
        return this.#spreads?.length ?? 0
    }
    get containerPosition() {
        return 0
    }
    get sideProp() {
        return this.#scrollMode ? 'height' : 'width'
    }
    destroy() {
        this.#observer.unobserve(this)
        if (this.#scrollMode) {
            this.removeEventListener('scroll', this.#handleScrollEvent)
            if (this.#scrollObserver) {
                this.#scrollObserver.disconnect()
                this.#scrollObserver = null
            }
            if (this.#scrollIdleTimer) {
                clearTimeout(this.#scrollIdleTimer)
                this.#scrollIdleTimer = null
            }
            for (const page of this.#scrollPages) {
                this.#teardownScrollPage(page)
            }
            this.#scrollPages = []
            this.#scrollLoadGen.clear()
            if (this.#scrollContainer) {
                this.#scrollContainer.remove()
                this.#scrollContainer = null
            }
        }
        for (const frames of this.#prerenderedSpreads.values()) {
            if (frames.center) {
                frames.center.element?.remove()
            } else {
                frames.left?.element?.remove()
                frames.right?.element?.remove()
            }
        }
        this.#prerenderedSpreads.clear()
        this.#preloadCache.clear()
        this.#spreadAccessTime.clear()
        this.#overlayers.clear()
    }
}

customElements.define('foliate-fxl', FixedLayout)
