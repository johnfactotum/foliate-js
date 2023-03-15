/* global zip: false, fflate: false */
import { View, getPosition } from './view.js'
import { createTOCView } from './ui/tree.js'
import { createMenu } from './ui/menu.js'
import { createPopover } from './ui/popover.js'

const { ZipReader, BlobReader, TextWriter, BlobWriter } = zip
zip.configure({ useWebWorkers: false })

const isZip = async file => {
    const arr = new Uint8Array(await file.slice(0, 4).arrayBuffer())
    return arr[0] === 0x50 && arr[1] === 0x4b && arr[2] === 0x03 && arr[3] === 0x04
}

const makeZipLoader = async file => {
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

const isFB2 = ({ name, type }) =>
    type === 'application/x-fictionbook+xml' || name.endsWith('.fb2')

const isEPUB = async (file) => {
	if (file.type === 'application/epub+zip') return true
	if (file.name?.endsWith('.epub')) return true

	// epub 3 RFC: https://www.w3.org/publishing/epub3/epub-ocf.html#app-media-type
	const magicCode = await file.slice(30, 58).text()
	return magicCode === 'mimetypeapplication/epub+zip'
}

const getView = async (file, emit) => {
    let book
    if (file.isDirectory) {
        const loader = await makeDirectoryLoader(file)
        const { EPUB } = await import('./epub.js')
        book = await new EPUB(loader).init()
    }
    else if (!file.size) throw new Error('File not found')
    else if (await isZip(file)) {
        const loader = await makeZipLoader(file)
		if (await isEPUB(file)) {
			const { EPUB } = await import('./epub.js')
			book = await new EPUB(loader).init()
		} else {
			const { entries } = loader
			const fb2 = entries.find(entry => entry.filename.endsWith('.fb2'))
			if (fb2 || loader.entries.length === 1) {
				const { makeFB2 } = await import('./fb2.js')
				const blob = await loader.loadBlob((fb2 ?? entries[0]).filename)
				book = await makeFB2(blob)
			} else {
				const { makeComicBook } = await import('./comic-book.js');
				book = makeComicBook(loader, file);
			}
		}
    } else {
        const { isMOBI, MOBI } = await import('./mobi.js')
        if (await isMOBI(file))
            book = await new MOBI({ unzlib: fflate.unzlibSync }).open(file)
        else if (isFB2(file)) {
            const { makeFB2 } = await import('./fb2.js')
            book = await makeFB2(file)
        }
    }
    if (!book) throw new Error('File type not supported')
    const view = new View(book, emit)
    const element = await view.display()
    document.body.append(element)
    return view
}

const getCSS = ({ spacing, justify, hyphenate }) => `
    @namespace epub "http://www.idpf.org/2007/ops";
    html {
        color-scheme: light dark;
    }
    /* https://github.com/whatwg/html/issues/5426 */
    @media (prefers-color-scheme: dark) {
        a:link {
            color: lightblue;
        }
    }
    p, li, blockquote, dd {
        line-height: ${spacing};
        text-align: ${justify ? 'justify' : 'start'};
        -webkit-hyphens: ${hyphenate ? 'auto' : 'manual'};
        hyphens: ${hyphenate ? 'auto' : 'manual'};
        -webkit-hyphenate-limit-before: 3;
        -webkit-hyphenate-limit-after: 2;
        -webkit-hyphenate-limit-lines: 2;
        hanging-punctuation: allow-end last;
        widows: 2;
    }
    /* prevent the above from overriding the align attribute */
    [align="left"] { text-align: left; }
    [align="right"] { text-align: right; }
    [align="center"] { text-align: center; }
    [align="justify"] { text-align: justify; }

    pre {
        white-space: pre-wrap !important;
    }
    aside[epub|type~="endnote"],
    aside[epub|type~="footnote"],
    aside[epub|type~="note"],
    aside[epub|type~="rearnote"] {
        display: none;
    }
`

const $ = document.querySelector.bind(document)

const locales = 'en'
const percentFormat = new Intl.NumberFormat(locales, { style: 'percent' })

class Reader {
    #tocView
    style = {
        spacing: 1.4,
        justify: true,
        hyphenate: true,
    }
    layout = {
        margin: 48,
        gap: 48,
        maxColumnWidth: 720,
    }
    closeSideBar() {
        $('#dimming-overlay').classList.remove('show')
        $('#side-bar').classList.remove('show')
    }
    constructor() {
        $('#side-bar-button').addEventListener('click', () => {
            $('#dimming-overlay').classList.add('show')
            $('#side-bar').classList.add('show')
        })
        $('#dimming-overlay').addEventListener('click', () => this.closeSideBar())

        const menu = createMenu([
            {
                name: 'layout',
                label: 'Layout',
                type: 'radio',
                items: [
                    ['Paginated', 'paginated'],
                    ['Scrolled', 'scrolled'],
                ],
                onclick: value => {
                    this.layout.flow = value
                    this.setAppearance()
                },
            },
        ])
        menu.element.classList.add('menu')

        $('#menu-button').append(menu.element)
        $('#menu-button > button').addEventListener('click', () =>
            menu.element.classList.toggle('show'))
        menu.groups.layout.select('paginated')
    }
    async open(file) {
        this.view = await getView(file, this.#handleEvent.bind(this))
        const { book } = this.view
        this.setAppearance()
        this.view.renderer.next()

        $('#header-bar').style.visibility = 'visible'
        $('#nav-bar').style.visibility = 'visible'
        $('#left-button').addEventListener('click', () => this.view.goLeft())
        $('#right-button').addEventListener('click', () => this.view.goRight())

        const slider = $('#progress-slider')
        slider.dir = book.dir
        slider.addEventListener('input', e =>
            this.view.goToFraction(parseFloat(e.target.value)))
        const sizes = book.sections.filter(s => s.linear !== 'no').map(s => s.size)
        if (sizes.length < 100) {
            const total = sizes.reduce((a, b) => a + b, 0)
            let sum = 0
            for (const size of sizes.slice(0, -1)) {
                sum += size
                const option = document.createElement('option')
                option.value = sum / total
                $('#tick-marks').append(option)
            }
        }

        document.addEventListener('keydown', this.#handleKeydown.bind(this))

        const title = book.metadata?.title ?? 'Untitled Book'
        document.title = title
        $('#side-bar-title').innerText = title
        const author = book.metadata?.author
        $('#side-bar-author').innerText = typeof author === 'string' ? author
            : author
                ?.map(author => typeof author === 'string' ? author : author.name)
                ?.join(', ')
                ?? ''
        Promise.resolve(book.getCover?.())?.then(blob =>
            blob ? $('#side-bar-cover').src = URL.createObjectURL(blob) : null)

        const toc = book.toc
        if (toc) {
            this.#tocView = createTOCView(toc, href => {
                this.view.goTo(href).catch(e => console.error(e))
                this.closeSideBar()
            })
            $('#toc-view').append(this.#tocView.element)
        }
    }
    setAppearance = () => {
        this.view?.setAppearance({ css: getCSS(this.style), layout: this.layout })
        const scrolled = this.layout.flow === 'scrolled'
        document.documentElement.classList.toggle('scrolled', scrolled)
    }
    #handleEvent(obj) {
        console.debug(obj)
        switch (obj.type) {
            case 'loaded': this.#onLoaded(obj); break
            case 'relocated': this.#onRelocated(obj); break
            case 'reference': this.#onReference(obj); break
            case 'external-link': globalThis.open(obj.uri, '_blank'); break
        }
    }
    #handleKeydown(event) {
        const k = event.key
        if (k === 'ArrowLeft' || k === 'h') this.view.goLeft()
        else if(k === 'ArrowRight' || k === 'l') this.view.goRight()
    }
    #onLoaded({ doc }) {
        doc.addEventListener('keydown', this.#handleKeydown.bind(this))
    }
    #onRelocated(obj) {
        const { fraction, location, tocItem, pageItem } = obj
        const percent = percentFormat.format(fraction)
        const loc = pageItem
            ? `Page ${pageItem.label}`
            : `Loc ${location.current}`
        const slider = $('#progress-slider')
        slider.style.visibility = 'visible'
        slider.value = fraction
        slider.title = `${percent} · ${loc}`
        if (tocItem?.href) this.#tocView?.setCurrentHref?.(tocItem.href)
    }
    #onReference(obj) {
        const { content, element } = obj
        const { point, dir } = getPosition(element)
        const iframe = document.createElement('iframe')
        iframe.sandbox = 'allow-same-origin'
        iframe.srcdoc = content
        iframe.onload = () => {
            const doc = iframe.contentDocument
            doc.documentElement.style.colorScheme = 'light dark'
            doc.body.style.margin = '18px'
        }
        Object.assign(iframe.style, {
            border: '0',
            width: '100%',
            height: '100%',
        })
        const { popover, arrow, overlay } = createPopover(300, 250, point, dir)
        overlay.style.zIndex = 3
        popover.style.zIndex = 3
        arrow.style.zIndex = 3
        popover.append(iframe)
        document.body.append(overlay)
        document.body.append(popover)
        document.body.append(arrow)
    }
}

const open = async file => {
    document.body.removeChild($('#drop-target'))
    const reader = new Reader()
    globalThis.reader = reader
    await reader.open(file)
}

const dragOverHandler = e => e.preventDefault()
const dropHandler = e => {
    e.preventDefault()
    const item = Array.from(e.dataTransfer.items)
        .find(item => item.kind === 'file')
    if (item) {
        const entry = item.webkitGetAsEntry()
        open(entry.isFile ? item.getAsFile() : entry).catch(e => console.error(e))
    }
}
const dropTarget = $('#drop-target')
dropTarget.addEventListener('drop', dropHandler)
dropTarget.addEventListener('dragover', dragOverHandler)

$('#file-input').addEventListener('change', e =>
    open(e.target.files[0]).catch(e => console.error(e)))
$('#file-button').addEventListener('click', () => $('#file-input').click())

const params = new URLSearchParams(location.search)
const url = params.get('url')
if (url) fetch(url)
    .then(res => res.blob())
    .then(blob => open(new File([blob], new URL(url).pathname)))
    .catch(e => console.error(e))
else dropTarget.style.visibility = 'visible'
