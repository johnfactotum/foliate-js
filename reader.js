/* global zip: false, fflate: false */
import { View } from './view.js'
import { createTOCView } from './ui/tree.js'

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

const isCBZ = ({ name, type }) =>
    type === 'application/vnd.comicbook+zip' || name.endsWith('.cbz')

const isFB2 = ({ name, type }) =>
    type === 'application/x-fictionbook+xml' || name.endsWith('.fb2')

const isFBZ = ({ name, type }) =>
    type === 'application/x-zip-compressed-fb2'
    || name.endsWith('.fb2.zip') || name.endsWith('.fbz')

const getView = async (file, emit) => {
    if (!file.size) throw new Error('File not found')
    let book
    if (await isZip(file)) {
        const loader = await makeZipLoader(file)
        if (isCBZ(file)) {
            const { makeComicBook } = await import('./comic-book.js')
            book = makeComicBook(loader, file)
        } else if (isFBZ(file)) {
            const { makeFB2 } = await import('./fb2.js')
            const { entries } = loader
            const entry = entries.find(entry => entry.filename.endsWith('.fb2'))
            const blob = await loader.loadBlob((entry ?? entries[0]).filename)
            book = await makeFB2(blob)
        } else {
            const { EPUB } = await import('./epub.js')
            book = await new EPUB(loader).init()
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
        -webkit-hyphenate-limit-before: 3;
        -webkit-hyphenate-limit-after: 2;
        -webkit-hyphenate-limit-lines: 2;
        hanging-punctuation: allow-end last;
        widows: 2;
    }
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

let setCurrentHref

const emit = obj => {
    console.debug(obj)
    switch (obj.type) {
        case 'relocated': {
            const { fraction, location, tocItem, pageItem } = obj
            const percent = percentFormat.format(fraction)
            const loc = pageItem
                ? `Page ${pageItem.label}`
                : `Loc ${location.current}`
            $('#progress-label').innerText = `${percent} · ${loc}`
            if (tocItem?.href) setCurrentHref?.(tocItem.href)
            break
        }
    }
}

const open = async file => {
    document.body.removeChild($('#drop-target'))
    const view = await getView(file, emit)
    const style = {
        spacing: 1.4,
        justify: true,
        hyphenate: true,
    }
    view.setAppearance({ css: getCSS(style) })
    view.renderer.next()

    const { book } = view
    const title = book.metadata?.title ?? 'Untitled Book'
    document.title = title
    $('#side-bar-title').innerText = title
    const author = book.metadata?.author
    $('#side-bar-author').innerText = typeof author === 'string' ? author
        : author
            ?.map(author => typeof author === 'string' ? author : author.name)
            ?.join(', ')
            ?? ''
    book.getCover?.()?.then(blob =>
        blob ? $('#side-bar-cover').src = URL.createObjectURL(blob) : null)

    const closeSideBar = () => {
        $('#dimming-overlay').classList.remove('show')
        $('#side-bar').classList.remove('show')
    }

    const toc = book.toc
    if (toc) {
        const onclick = href => {
            view.goTo(href).catch(e => console.error(e))
            closeSideBar()
        }
        const tocView = createTOCView(toc, onclick)
        setCurrentHref = tocView.setCurrentHref
        $('#toc-view').append(tocView.element)
    }

    $('#header-bar').style.visibility = 'visible'
    $('#side-bar-button').addEventListener('click', () => {
        $('#dimming-overlay').classList.add('show')
        $('#side-bar').classList.add('show')
    })
    $('#dimming-overlay').addEventListener('click', closeSideBar)

    $('#nav-bar').style.visibility = 'visible'
    $('#left-button').addEventListener('click', () => view.goLeft())
    $('#right-button').addEventListener('click', () => view.goRight())
}

const dragOverHandler = e => e.preventDefault()
const dropHandler = e => {
    e.preventDefault()
    const file = Array.from(e.dataTransfer.items)
        .find(item => item.kind === 'file')?.getAsFile()
    if (file) open(file).catch(e => emit(e))
}
const dropTarget = $('#drop-target')
dropTarget.addEventListener('drop', dropHandler)
dropTarget.addEventListener('dragover', dragOverHandler)

$('#file-input').addEventListener('change', e =>
    open(e.target.files[0]).catch(e => emit(e)))
$('#file-button').addEventListener('click', () => $('#file-input').click())
