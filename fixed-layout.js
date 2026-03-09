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
    static observedAttributes = ['zoom', 'scale-factor', 'spread']
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
        if (!side) return
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

        const transform = ({frame, styles}) => {
            let { element, iframe, width, height, blank, onZoom } = frame
            if (!iframe) return
            if (onZoom) onZoom({ doc: frame.iframe.contentDocument, scale })
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

            const container= element.parentNode.host
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
            const {width, height, containerWidth, containerHeight} = dimensions
            this.#isOverflowX = width > containerWidth
            this.#isOverflowY = height > containerHeight
        } else {
            const leftDimensions = transform({frame: left, styles: { marginInlineStart: 'auto' }})
            const rightDimensions = transform({frame: right, styles: { marginInlineEnd: 'auto' }})
            const {width: leftWidth, height: leftHeight, containerWidth, containerHeight} = leftDimensions
            const {width: rightWidth, height: rightHeight} = rightDimensions
            this.#isOverflowX = leftWidth + rightWidth > containerWidth
            this.#isOverflowY = Math.max(leftHeight, rightHeight) > containerHeight
        }
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

        this.#side = center ? 'center' : this.#left.blank ? 'right'
            : this.#right.blank ? 'left' : side
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

        // Dispatch create-overlayer when the spread is actually shown (not at
        // iframe load time) so preloaded frames also get overlayers.
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

        this.#render()
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
        const spread = this.#spreads[this.#index]
        const section = spread?.center ?? (this.#side === 'left'
            ? spread.left ?? spread.right : spread.right ?? spread.left)
        return this.book.sections.indexOf(section)
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
        return this.#index <= 0
    }
    get atEnd() {
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
        const { book } = this
        const resolved = await target
        const section = book.sections[resolved.index]
        if (!section) return
        const { index, side } = this.getSpreadOf(section)
        await this.goToSpread(index, side)
    }
    async next() {
        const s = this.rtl ? this.#goLeft() : this.#goRight()
        if (!s) return this.goToSpread(this.#index + 1, this.rtl ? 'right' : 'left', 'page')
    }
    async prev() {
        const s = this.rtl ? this.#goRight() : this.#goLeft()
        if (!s) return this.goToSpread(this.#index - 1, this.rtl ? 'left' : 'right', 'page')
    }
    async pan(dx, dy) {
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
    destroy() {
        this.#observer.unobserve(this)
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
