import * as CFI from './epubcfi.js'
import { TOCProgress, SectionProgress } from './progress.js'
import { Overlayer } from './overlayer.js'
import { textWalker } from './text-walker.js'
import { FootnoteHandler } from './footnotes.js'

const SEARCH_PREFIX = 'foliate-search:'

const isZip = async file => {
    const arr = new Uint8Array(await file.slice(0, 4).arrayBuffer())
    return arr[0] === 0x50 && arr[1] === 0x4b && arr[2] === 0x03 && arr[3] === 0x04
}

const isPDF = async file => {
    const arr = new Uint8Array(await file.slice(0, 5).arrayBuffer())
    return arr[0] === 0x25
        && arr[1] === 0x50 && arr[2] === 0x44 && arr[3] === 0x46
        && arr[4] === 0x2d
}

const isCBZ = ({ name, type }) =>
    type === 'application/vnd.comicbook+zip' || name.endsWith('.cbz')

const isFB2 = ({ name, type }) =>
    type === 'application/x-fictionbook+xml' || name.endsWith('.fb2')

const isFBZ = ({ name, type }) =>
    type === 'application/x-zip-compressed-fb2'
    || name.endsWith('.fb2.zip') || name.endsWith('.fbz')

const makeZipLoader = async file => {
    const { configure, ZipReader, BlobReader, TextWriter, BlobWriter } =
        await import('./vendor/zip.js')
    configure({ useWebWorkers: false })
    const reader = new ZipReader(new BlobReader(file))
    const entries = await reader.getEntries()
    const map = new Map(entries.map(entry => [entry.filename, entry]))
    const load = f => (name, ...args) =>
        map.has(name) ? f(map.get(name), ...args) : null
    const loadText = load(entry => entry.getData(new TextWriter()))
    const loadBlob = load((entry, type) => entry.getData(new BlobWriter(type)))
    const getSize = name => map.get(name)?.uncompressedSize ?? 0
    return { entries, loadText, loadBlob, getSize }
}

const getFileEntries = async entry => entry.isFile ? entry
    : (await Promise.all(Array.from(
        await new Promise((resolve, reject) => entry.createReader()
            .readEntries(entries => resolve(entries), error => reject(error))),
        getFileEntries))).flat()

const makeDirectoryLoader = async entry => {
    const entries = await getFileEntries(entry)
    const files = await Promise.all(
        entries.map(entry => new Promise((resolve, reject) =>
            entry.file(file => resolve([file, entry.fullPath]),
                error => reject(error)))))
    const map = new Map(files.map(([file, path]) =>
        [path.replace(entry.fullPath + '/', ''), file]))
    const decoder = new TextDecoder()
    const decode = x => x ? decoder.decode(x) : null
    const getBuffer = name => map.get(name)?.arrayBuffer() ?? null
    const loadText = async name => decode(await getBuffer(name))
    const loadBlob = name => map.get(name)
    const getSize = name => map.get(name)?.size ?? 0
    return { loadText, loadBlob, getSize }
}

export class ResponseError extends Error {}
export class NotFoundError extends Error {}
export class UnsupportedTypeError extends Error {}

const fetchFile = async url => {
    const res = await fetch(url)
    if (!res.ok) throw new ResponseError(
        `${res.status} ${res.statusText}`, { cause: res })
    return new File([await res.blob()], new URL(res.url).pathname)
}

export const makeBook = async file => {
    if (typeof file === 'string') file = await fetchFile(file)
    let book
    if (file.isDirectory) {
        const loader = await makeDirectoryLoader(file)
        const { EPUB } = await import('./epub.js')
        book = await new EPUB(loader).init()
    }
    else if (!file.size) throw new NotFoundError('File not found')
    else if (await isZip(file)) {
        const loader = await makeZipLoader(file)
        if (isCBZ(file)) {
            const { makeComicBook } = await import('./comic-book.js')
            book = makeComicBook(loader, file)
        }
        else if (isFBZ(file)) {
            const { makeFB2 } = await import('./fb2.js')
            const { entries } = loader
            const entry = entries.find(entry => entry.filename.endsWith('.fb2'))
            const blob = await loader.loadBlob((entry ?? entries[0]).filename)
            book = await makeFB2(blob)
        }
        else {
            const { EPUB } = await import('./epub.js')
            book = await new EPUB(loader).init()
        }
    }
    else if (await isPDF(file)) {
        const { makePDF } = await import('./pdf.js')
        book = await makePDF(file)
    }
    else {
        const { isMOBI, MOBI } = await import('./mobi.js')
        if (await isMOBI(file)) {
            const fflate = await import('./vendor/fflate.js')
            book = await new MOBI({ unzlib: fflate.unzlibSync }).open(file)
        }
        else if (isFB2(file)) {
            const { makeFB2 } = await import('./fb2.js')
            book = await makeFB2(file)
        }
    }
    if (!book) throw new UnsupportedTypeError('File type not supported')
    return book
}

class CursorAutohider {
    #timeout
    #el
    #check
    #state
    constructor(el, check, state = {}) {
        this.#el = el
        this.#check = check
        this.#state = state
        if (this.#state.hidden) this.hide()
        this.#el.addEventListener('mousemove', ({ screenX, screenY }) => {
            // check if it actually moved
            if (screenX === this.#state.x && screenY === this.#state.y) return
            this.#state.x = screenX, this.#state.y = screenY
            this.show()
            if (this.#timeout) clearTimeout(this.#timeout)
            if (check()) this.#timeout = setTimeout(this.hide.bind(this), 1000)
        }, false)
    }
    cloneFor(el) {
        return new CursorAutohider(el, this.#check, this.#state)
    }
    hide() {
        this.#el.style.cursor = 'none'
        this.#state.hidden = true
    }
    show() {
        this.#el.style.removeProperty('cursor')
        this.#state.hidden = false
    }
}

class History extends EventTarget {
    #arr = []
    #index = -1
    pushState(x) {
        const last = this.#arr[this.#index]
        if (last === x || last?.fraction && last.fraction === x.fraction) return
        this.#arr[++this.#index] = x
        this.#arr.length = this.#index + 1
        this.dispatchEvent(new Event('index-change'))
    }
    replaceState(x) {
        const index = this.#index
        this.#arr[index] = x
    }
    back() {
        const index = this.#index
        if (index <= 0) return
        const detail = { state: this.#arr[index - 1] }
        this.#index = index - 1
        this.dispatchEvent(new CustomEvent('popstate', { detail }))
        this.dispatchEvent(new Event('index-change'))
    }
    forward() {
        const index = this.#index
        if (index >= this.#arr.length - 1) return
        const detail = { state: this.#arr[index + 1] }
        this.#index = index + 1
        this.dispatchEvent(new CustomEvent('popstate', { detail }))
        this.dispatchEvent(new Event('index-change'))
    }
    get canGoBack() {
        return this.#index > 0
    }
    get canGoForward() {
        return this.#index < this.#arr.length - 1
    }
    clear() {
        this.#arr = []
        this.#index = -1
    }
}

const languageInfo = lang => {
    if (!lang) return {}
    try {
        const canonical = Intl.getCanonicalLocales(lang)[0]
        const locale = new Intl.Locale(canonical)
        const isCJK = ['zh', 'ja', 'kr'].includes(locale.language)
        const direction = (locale.getTextInfo?.() ?? locale.textInfo)?.direction
        return { canonical, locale, isCJK, direction }
    } catch (e) {
        console.warn(e)
        return {}
    }
}

export class View extends HTMLElement {
    #root = this.attachShadow({ mode: 'closed' })
    #sectionProgress
    #tocProgress
    #pageProgress
    #searchResults = new Map()
    #cursorAutohider = new CursorAutohider(this, () =>
        this.hasAttribute('autohide-cursor'))
    #footnoteHandler = new FootnoteHandler()
    #pendingFootnoteView = null
    isFixedLayout = false
    lastLocation
    history = new History()
    constructor() {
        super()
        this.history.addEventListener('popstate', ({ detail }) => {
            const resolved = this.resolveNavigation(detail.state)
            this.renderer.goTo(resolved)
        })
        
        // Set up footnote handler to show modal instead of creating new view
        this.#footnoteHandler.addEventListener('render', ({ detail }) => {
            this.#showFootnoteModal(detail)
        })
        
        // Also listen for the before-render event to get the content earlier
        this.#footnoteHandler.addEventListener('before-render', ({ detail }) => {
            this.#prepareFootnoteModal(detail)
        })
        
    }
    
    #prepareFootnoteModal({ view }) {
        // Store reference to the view for later use
        this.#pendingFootnoteView = view
    }
    
    #showFootnoteModal(options = {}) {
        const modal = document.getElementById('footnote-modal')
        const content = document.getElementById('footnote-content')
        const title = document.getElementById('footnote-title')
        
        if (!modal || !content || !title) {
            // Clean up view if provided
            if (options.view) {
                options.view.remove()
            }
            return
        }
        
        // Determine title based on type or text
        if (options.type) {
            title.textContent = options.type === 'footnote' ? 'Footnote' : 
                              options.type === 'endnote' ? 'Endnote' : 'Note'
        } else if (options.text) {
            title.textContent = `Footnote ${options.text}`
        } else {
            title.textContent = 'Footnote'
        }
        
        // Handle different content types
        if (options.element) {
            // Case 1: Display content from a DOM element
            const clonedContent = options.element.cloneNode(true)
            
            // Remove all backlinks from the cloned content
            const backlinks = clonedContent.querySelectorAll('[role="doc-backlink"]')
            backlinks.forEach(backlink => backlink.remove())
            
            // Remove all links with relative URLs (same document links)
            const links = clonedContent.querySelectorAll('a[href]')
            links.forEach(link => {
                const href = link.getAttribute('href')
                // Remove links that start with # (same document anchors) or are relative paths
                if (href && (href.startsWith('#') || !href.includes('://'))) {
                    // Remove the entire link element
                    link.remove()
                }
            })
            
            content.innerHTML = ''
            content.appendChild(clonedContent)
        } else if (options.htmlContent) {
            // Case 2: Display provided HTML content
            content.innerHTML = options.htmlContent
        } else if (options.href && options.text) {
            // Case 3: Show simple fallback message
            content.innerHTML = `
                <p><strong>Footnote ${options.text}</strong></p>
                <p>Reference: ${options.href}</p>
                <p><em>Footnote content could not be loaded. This may be an external reference or the footnote may not be available in this document.</em></p>
            `
        } else {
            // Case 4: Loading state (for complex footnote extraction)
            content.innerHTML = '<p>Footnote content is being loaded...</p>'
        }
        
        // Show the modal
        modal.showModal()
        
        // Force positioning after modal is shown
        setTimeout(() => {
            modal.style.position = 'fixed'
            modal.style.top = '50%'
            modal.style.left = '50%'
            modal.style.transform = 'translate(-50%, -50%)'
            modal.style.margin = '0'
        }, 0)
        
        // Set up close button
        const closeBtn = document.getElementById('footnote-close')
        if (closeBtn) {
            closeBtn.onclick = () => modal.close()
        }
        
        // Close on backdrop click
        modal.onclick = (e) => {
            if (e.target === modal) {
                modal.close()
            }
        }
        
        // Close on Escape key
        modal.onkeydown = (e) => {
            if (e.key === 'Escape') {
                modal.close()
            }
        }
        
        // If we have a view to extract content from, do it asynchronously
        if (options.view && !options.element && !options.htmlContent) {
            setTimeout(() => {
                try {
                    // Look for content in the view's shadow root
                    const footnoteDoc = options.view.shadowRoot?.querySelector('foliate-paginator, foliate-fxl')
                    if (footnoteDoc) {
                        // Try to find iframe or embed element
                        const iframe = footnoteDoc.shadowRoot?.querySelector('iframe')
                        if (iframe && iframe.contentDocument) {
                            const bodyContent = iframe.contentDocument.body.cloneNode(true)
                            if (bodyContent.children.length > 0) {
                                content.innerHTML = ''
                                content.appendChild(bodyContent)
                            }
                        }
                    }
                } catch (error) {
                    content.innerHTML = '<p>Error loading footnote content.</p>'
                } finally {
                    // Clean up the temporary view
                    options.view.remove()
                }
            }, 200)
        }
    }
    
    
    async #tryDirectFootnoteNavigation(href, text) {
        try {
            // Check if this is a cross-file reference (contains .xhtml or .html)
            if (href.includes('.xhtml') || href.includes('.html')) {
                await this.#loadCrossFileFootnote(href, text)
                return
            }
            
            // Try to navigate to the footnote using the main view
            const result = await this.goTo(href)
            
            if (result) {
                // Get the current content
                const contents = this.renderer.getContents()
                const currentContent = contents.find(c => c.index === result.index)
                
                if (currentContent && currentContent.doc) {
                    // Look for the footnote element
                    const footnoteElement = currentContent.doc.querySelector(href.replace(/^#/, ''))
                    if (footnoteElement) {
                        this.#showFootnoteModal({ element: footnoteElement, text })
                        return
                    }
                }
            }
            
            // If direct navigation didn't work, show fallback
            this.#showFootnoteModal({ href, text })
            
        } catch (error) {
            this.#showFootnoteModal({ href, text })
        }
    }
    
    async #loadCrossFileFootnote(href, text) {
        try {
            // Extract filename and anchor from href
            const [filename, anchor] = href.split('#')
            
            // Find the section that contains this file
            let section = this.book.sections.find(s => s && s.id === filename)
            
            if (!section) {
                section = this.book.sections.find(s => {
                    if (!s || !s.id) return false
                    return s.id.includes(filename)
                })
            }
            if (!section) {
                section = this.book.sections.find(s => {
                    if (!s || !s.id) return false
                    return s.id.endsWith(filename)
                })
            }
            if (!section) {
                section = this.book.sections.find(s => {
                    if (!s || !s.id) return false
                    const lastPart = s.id.split('/').pop()
                    return lastPart && filename.includes(lastPart)
                })
            }
            
            if (!section) {
                this.#showFootnoteModal({ href, text })
                return
            }
            
            // Try to load the section content directly
            try {
                const doc = await section.createDocument()
                
                if (doc) {
                    const footnoteElement = doc.querySelector(`#${anchor}`)
                    
                    if (footnoteElement) {
                        this.#showFootnoteModal({ element: footnoteElement, text })
                        return
                    } else {
                        // Try alternative selectors
                        const altSelectors = [
                            `[id="${anchor}"]`,
                            `[name="${anchor}"]`,
                            `.${anchor}`,
                            `a[name="${anchor}"]`
                        ]
                        
                        for (const selector of altSelectors) {
                            const element = doc.querySelector(selector)
                            if (element) {
                                this.#showFootnoteModal({ element, text })
                                return
                            }
                        }
                    }
                }
                
                this.#showFootnoteModal({ href, text })
                
            } catch (docError) {
                this.#showFootnoteModal({ href, text })
            }
            
        } catch (error) {
            this.#showFootnoteModal({ href, text })
        }
    }
    
    
    async open(book) {
        if (typeof book === 'string'
        || typeof book.arrayBuffer === 'function'
        || book.isDirectory) book = await makeBook(book)
        this.book = book
        this.language = languageInfo(book.metadata?.language)

        if (book.splitTOCHref && book.getTOCFragment) {
            const ids = book.sections.map(s => s.id)
            this.#sectionProgress = new SectionProgress(book.sections, 1500, 1600)
            const splitHref = book.splitTOCHref.bind(book)
            const getFragment = book.getTOCFragment.bind(book)
            this.#tocProgress = new TOCProgress()
            await this.#tocProgress.init({
                toc: book.toc ?? [], ids, splitHref, getFragment })
            this.#pageProgress = new TOCProgress()
            await this.#pageProgress.init({
                toc: book.pageList ?? [], ids, splitHref, getFragment })
        }

        this.isFixedLayout = this.book.rendition?.layout === 'pre-paginated'
        if (this.isFixedLayout) {
            await import('./fixed-layout.js')
            this.renderer = document.createElement('foliate-fxl')
        } else {
            await import('./paginator.js')
            this.renderer = document.createElement('foliate-paginator')
        }
        this.renderer.setAttribute('exportparts', 'head,foot,filter')
        this.renderer.addEventListener('load', e => this.#onLoad(e.detail))
        this.renderer.addEventListener('relocate', e => this.#onRelocate(e.detail))
        this.renderer.addEventListener('create-overlayer', e =>
            e.detail.attach(this.#createOverlayer(e.detail)))
        this.renderer.open(book)
        this.#root.append(this.renderer)

        if (book.sections.some(section => section.mediaOverlay)) {
            const activeClass = book.media.activeClass
            const playbackActiveClass = book.media.playbackActiveClass
            this.mediaOverlay = book.getMediaOverlay()
            let lastActive
            this.mediaOverlay.addEventListener('highlight', e => {
                const resolved = this.resolveNavigation(e.detail.text)
                this.renderer.goTo(resolved)
                    .then(() => {
                        const { doc } = this.renderer.getContents()
                            .find(x => x.index = resolved.index)
                        const el = resolved.anchor(doc)
                        el.classList.add(activeClass)
                        if (playbackActiveClass) el.ownerDocument
                            .documentElement.classList.add(playbackActiveClass)
                        lastActive = new WeakRef(el)
                    })
            })
            this.mediaOverlay.addEventListener('unhighlight', () => {
                const el = lastActive?.deref()
                if (el) {
                    el.classList.remove(activeClass)
                    if (playbackActiveClass) el.ownerDocument
                        .documentElement.classList.remove(playbackActiveClass)
                }
            })
        }
    }
    close() {
        this.renderer?.destroy()
        this.renderer?.remove()
        this.#sectionProgress = null
        this.#tocProgress = null
        this.#pageProgress = null
        this.#searchResults = new Map()
        this.lastLocation = null
        this.history.clear()
        this.tts = null
        this.mediaOverlay = null
    }
    goToTextStart() {
        return this.goTo(this.book.landmarks
            ?.find(m => m.type.includes('bodymatter') || m.type.includes('text'))
            ?.href ?? this.book.sections.findIndex(s => s.linear !== 'no'))
    }
    async init({ lastLocation, showTextStart }) {
        const resolved = lastLocation ? this.resolveNavigation(lastLocation) : null
        if (resolved) {
            await this.renderer.goTo(resolved)
            this.history.pushState(lastLocation)
        }
        else if (showTextStart) await this.goToTextStart()
        else {
            this.history.pushState(0)
            await this.next()
        }
    }
    #emit(name, detail, cancelable) {
        return this.dispatchEvent(new CustomEvent(name, { detail, cancelable }))
    }
    #onRelocate({ reason, range, index, fraction, size }) {
        const progress = this.#sectionProgress?.getProgress(index, fraction, size) ?? {}
        const tocItem = this.#tocProgress?.getProgress(index, range)
        const pageItem = this.#pageProgress?.getProgress(index, range)
        const cfi = this.getCFI(index, range)
        this.lastLocation = { ...progress, tocItem, pageItem, cfi, range }
        if (reason === 'snap' || reason === 'page' || reason === 'scroll')
            this.history.replaceState(cfi)
        this.#emit('relocate', this.lastLocation)
    }
    #onLoad({ doc, index }) {
        // set language and dir if not already set
        doc.documentElement.lang ||= this.language.canonical ?? ''
        if (!this.language.isCJK)
            doc.documentElement.dir ||= this.language.direction ?? ''

        this.#handleLinks(doc, index)
        this.#cursorAutohider.cloneFor(doc.documentElement)

        this.#emit('load', { doc, index })
    }
    #handleLinks(doc, index) {
        const { book } = this
        const section = book.sections[index]
        doc.addEventListener('click', e => {
            const a = e.target.closest('a[href]')
            if (!a) return
            
            // Try footnote handler first
            const href = a.getAttribute('href')
            
            // Check if this looks like a footnote link first
            const isLikelyFootnote = href && (
                href.includes('footnote') ||
                href.includes('note') ||
                a.textContent.match(/^\d+$/) || // Superscript numbers
                a.getAttributeNS('http://www.idpf.org/2007/ops', 'type') === 'noteref' // EPUB noteref
            )
            
            if (isLikelyFootnote) {
                // Try to resolve the href relative to the current section first
                const resolvedHref = section?.resolveHref?.(href) ?? href
                // Check if this is a cross-file reference - skip footnote handler entirely
                if (href.includes('.xhtml') || href.includes('.html')) {
                    e.preventDefault()
                    this.#tryDirectFootnoteNavigation(resolvedHref, a.textContent)
                    return
                }
                
                // For same-file footnotes, try the footnote handler
                const resolvedFootnoteEvent = {
                    detail: { a, href: resolvedHref },
                    preventDefault: () => e.preventDefault()
                }
                
                const footnoteResult = this.#footnoteHandler.handle(book, resolvedFootnoteEvent)
                if (footnoteResult) {
                    footnoteResult.catch(() => this.#tryDirectFootnoteNavigation(resolvedHref, a.textContent))
                } else {
                    this.#tryDirectFootnoteNavigation(resolvedHref, a.textContent)
                }
                return
            }
            
            e.preventDefault()
            const href_ = a.getAttribute('href')
            const resolvedHref = section?.resolveHref?.(href_) ?? href_
            if (book?.isExternal?.(resolvedHref))
                Promise.resolve(this.#emit('external-link', { a, href: resolvedHref }, true))
                    .then(x => x ? globalThis.open(resolvedHref, '_blank') : null)
                    .catch(e => console.error(e))
            else Promise.resolve(this.#emit('link', { a, href: resolvedHref }, true))
                .then(x => x ? this.goTo(resolvedHref) : null)
                .catch(e => console.error(e))
        })
    }
    async addAnnotation(annotation, remove) {
        const { value } = annotation
        if (value.startsWith(SEARCH_PREFIX)) {
            const cfi = value.replace(SEARCH_PREFIX, '')
            const { index, anchor } = await this.resolveNavigation(cfi)
            const obj = this.#getOverlayer(index)
            if (obj) {
                const { overlayer, doc } = obj
                if (remove) {
                    overlayer.remove(value)
                    return
                }
                const range = doc ? anchor(doc) : anchor
                overlayer.add(value, range, Overlayer.outline)
            }
            return
        }
        const { index, anchor } = await this.resolveNavigation(value)
        const obj = this.#getOverlayer(index)
        if (obj) {
            const { overlayer, doc } = obj
            overlayer.remove(value)
            if (!remove) {
                const range = doc ? anchor(doc) : anchor
                const draw = (func, opts) => overlayer.add(value, range, func, opts)
                this.#emit('draw-annotation', { draw, annotation, doc, range })
            }
        }
        const label = this.#tocProgress.getProgress(index)?.label ?? ''
        return { index, label }
    }
    deleteAnnotation(annotation) {
        return this.addAnnotation(annotation, true)
    }
    #getOverlayer(index) {
        return this.renderer.getContents()
            .find(x => x.index === index && x.overlayer)
    }
    #createOverlayer({ doc, index }) {
        const overlayer = new Overlayer()
        doc.addEventListener('click', e => {
            const [value, range] = overlayer.hitTest(e)
            if (value && !value.startsWith(SEARCH_PREFIX)) {
                this.#emit('show-annotation', { value, index, range })
            }
        }, false)

        const list = this.#searchResults.get(index)
        if (list) for (const item of list) this.addAnnotation(item)

        this.#emit('create-overlay', { index })
        return overlayer
    }
    async showAnnotation(annotation) {
        const { value } = annotation
        const resolved = await this.goTo(value)
        if (resolved) {
            const { index, anchor } = resolved
            const { doc } =  this.#getOverlayer(index)
            const range = anchor(doc)
            this.#emit('show-annotation', { value, index, range })
        }
    }
    getCFI(index, range) {
        const baseCFI = this.book.sections[index].cfi ?? CFI.fake.fromIndex(index)
        if (!range) return baseCFI
        return CFI.joinIndir(baseCFI, CFI.fromRange(range))
    }
    resolveCFI(cfi) {
        if (this.book.resolveCFI)
            return this.book.resolveCFI(cfi)
        else {
            const parts = CFI.parse(cfi)
            const index = CFI.fake.toIndex((parts.parent ?? parts).shift())
            const anchor = doc => CFI.toRange(doc, parts)
            return { index, anchor }
        }
    }
    resolveNavigation(target) {
        try {
            if (typeof target === 'number') return { index: target }
            if (typeof target.fraction === 'number') {
                const [index, anchor] = this.#sectionProgress.getSection(target.fraction)
                return { index, anchor }
            }
            if (CFI.isCFI.test(target)) return this.resolveCFI(target)
            return this.book.resolveHref(target)
        } catch (e) {
            console.error(e)
            console.error(`Could not resolve target ${target}`)
        }
    }
    async goTo(target) {
        const resolved = this.resolveNavigation(target)
        try {
            await this.renderer.goTo(resolved)
            this.history.pushState(target)
            return resolved
        } catch(e) {
            console.error(e)
            console.error(`Could not go to ${target}`)
        }
    }
    async goToFraction(frac) {
        const [index, anchor] = this.#sectionProgress.getSection(frac)
        await this.renderer.goTo({ index, anchor })
        this.history.pushState({ fraction: frac })
    }
    async select(target) {
        try {
            const obj = await this.resolveNavigation(target)
            await this.renderer.goTo({ ...obj, select: true })
            this.history.pushState(target)
        } catch(e) {
            console.error(e)
            console.error(`Could not go to ${target}`)
        }
    }
    deselect() {
        for (const { doc } of this.renderer.getContents())
            doc.defaultView.getSelection().removeAllRanges()
    }
    getSectionFractions() {
        return (this.#sectionProgress?.sectionFractions ?? [])
            .map(x => x + Number.EPSILON)
    }
    getProgressOf(index, range) {
        const tocItem = this.#tocProgress?.getProgress(index, range)
        const pageItem = this.#pageProgress?.getProgress(index, range)
        return { tocItem, pageItem }
    }
    async getTOCItemOf(target) {
        try {
            const { index, anchor } = await this.resolveNavigation(target)
            const doc = await this.book.sections[index].createDocument()
            const frag = anchor(doc)
            const isRange = frag instanceof Range
            const range = isRange ? frag : doc.createRange()
            if (!isRange) range.selectNodeContents(frag)
            return this.#tocProgress.getProgress(index, range)
        } catch(e) {
            console.error(e)
            console.error(`Could not get ${target}`)
        }
    }
    async prev(distance) {
        await this.renderer.prev(distance)
    }
    async next(distance) {
        await this.renderer.next(distance)
    }
    goLeft() {
        return this.book.dir === 'rtl' ? this.next() : this.prev()
    }
    goRight() {
        return this.book.dir === 'rtl' ? this.prev() : this.next()
    }
    async * #searchSection(matcher, query, index) {
        const doc = await this.book.sections[index].createDocument()
        for (const { range, excerpt } of matcher(doc, query))
            yield { cfi: this.getCFI(index, range), excerpt }
    }
    async * #searchBook(matcher, query) {
        const { sections } = this.book
        for (const [index, { createDocument }] of sections.entries()) {
            if (!createDocument) continue
            const doc = await createDocument()
            const subitems = Array.from(matcher(doc, query), ({ range, excerpt }) =>
                ({ cfi: this.getCFI(index, range), excerpt }))
            const progress = (index + 1) / sections.length
            yield { progress }
            if (subitems.length) yield { index, subitems }
        }
    }
    async * search(opts) {
        this.clearSearch()
        const { searchMatcher } = await import('./search.js')
        const { query, index } = opts
        const matcher = searchMatcher(textWalker,
            { defaultLocale: this.language, ...opts })
        const iter = index != null
            ? this.#searchSection(matcher, query, index)
            : this.#searchBook(matcher, query)

        const list = []
        this.#searchResults.set(index, list)

        for await (const result of iter) {
            if (result.subitems){
                const list = result.subitems
                    .map(({ cfi }) => ({ value: SEARCH_PREFIX + cfi }))
                this.#searchResults.set(result.index, list)
                for (const item of list) this.addAnnotation(item)
                yield {
                    label: this.#tocProgress.getProgress(result.index)?.label ?? '',
                    subitems: result.subitems,
                }
            }
            else {
                if (result.cfi) {
                    const item = { value: SEARCH_PREFIX + result.cfi }
                    list.push(item)
                    this.addAnnotation(item)
                }
                yield result
            }
        }
        yield 'done'
    }
    clearSearch() {
        for (const list of this.#searchResults.values())
            for (const item of list) this.deleteAnnotation(item)
        this.#searchResults.clear()
    }
    async initTTS(granularity = 'word', highlight) {
        const doc = this.renderer.getContents()[0].doc
        if (this.tts && this.tts.doc === doc) return
        const { TTS } = await import('./tts.js')
        this.tts = new TTS(doc, textWalker, highlight || (range =>
            this.renderer.scrollToAnchor(range, true)), granularity)
    }
    startMediaOverlay() {
        const { index } = this.renderer.getContents()[0]
        return this.mediaOverlay.start(index)
    }
}

customElements.define('foliate-view', View)
