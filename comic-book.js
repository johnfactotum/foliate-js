async function getJpgDimensions(blob) {
    const header = await blob.slice(0, 2).arrayBuffer()
    const view = new DataView(header)
    if (view.getUint16(0) !== 0xFFD8) return null  //JPEG SOI

    let offset = 2
    while (offset < blob.size) {
        const buffer = await blob.slice(offset, offset + 9).arrayBuffer()
        if (buffer.byteLength < 4) return null
        const view = new DataView(buffer)
        const marker = view.getUint16(0)
        const length = view.getUint16(2)

        // SOF0 (baseline DCT) or SOF2 (progressive DCT)
        if (marker === 0xFFC0 || marker === 0xFFC2) {
            const height = view.getUint16(5)
            const width = view.getUint16(7)
            return { width, height }
        }

        if (marker === 0xFFDA) return null  //Image data

        offset += 2 + length
    }

    return null
}

function getUint24LittleEndian(dataView, offset) {
    return dataView.getUint8(offset)
        | (dataView.getUint8(offset + 1) << 8)
        | (dataView.getUint8(offset + 2) << 16)
}

async function getWebpDimensions(blob) {
    const header = await blob.slice(0, 30).arrayBuffer()
    const view = new DataView(header)

    const riff = String.fromCharCode(...new Uint8Array(header.slice(0, 4)))
    const webp = String.fromCharCode(...new Uint8Array(header.slice(8, 12)))
    if (riff !== 'RIFF' || webp !== 'WEBP') return null

    const chunkType = String.fromCharCode(...new Uint8Array(header.slice(12, 16)))

    if (chunkType === 'VP8 ') {
        const width = view.getUint16(26, true) & 0x3FFF
        const height = view.getUint16(28, true) & 0x3FFF
        return { width, height }
    }

    if (chunkType === 'VP8L') {
        const b0 = view.getUint8(21)
        const b1 = view.getUint8(22)
        const b2 = view.getUint8(23)
        const b3 = view.getUint8(24)

        const width = 1 + (((b1 & 0x3F) << 8) | b0)
        const height = 1 + (((b3 & 0xF) << 10) | (b2 << 2) | ((b1 & 0xC0) >> 6))
        return { width, height }
    }

    if (chunkType === 'VP8X') {
        const width = 1 + getUint24LittleEndian(view, 24)
        const height = 1 + getUint24LittleEndian(view, 27)
        return { width, height }
    }

    return null
}

const pageDimensions = {
    jpg: getJpgDimensions,
    jpeg: getJpgDimensions,
    png: async (blob) => {
        const header = await blob.slice(0, 24).arrayBuffer()
        const view = new DataView(header)
        if (view.getUint32(0) !== 0x89504E47) return null  //PNG magic number
        const width = view.getUint32(16)
        const height = view.getUint32(20)
        return { width, height }
    },
    gif: async (blob) => {
        const header = await blob.slice(0, 10).arrayBuffer()
        const view = new DataView(header)
        const signature = String.fromCharCode(...new Uint8Array(header.slice(0, 6)))
        if (!/^GIF8[79]a$/.test(signature)) return null //GIF magic numbers
        const width = view.getUint16(6, true)
        const height = view.getUint16(8, true)
        return { width, height }
    },
    webp: getWebpDimensions,
}

export const makeComicBook = async ({ entries, loadBlob, getSize }, file, smartSpreads) => {
    const cache = new Map()
    const urls = new Map()
    const load = async name => {
        if (cache.has(name)) return cache.get(name)
        const src = URL.createObjectURL(await loadBlob(name))
        const page = URL.createObjectURL(
            new Blob([`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin: 0"><img src="${src}"></body></html>`], { type: 'text/html' }))
        urls.set(name, [src, page])
        cache.set(name, page)
        return page
    }
    const unload = name => {
        urls.get(name)?.forEach?.(url => URL.revokeObjectURL(url))
        urls.delete(name)
        cache.delete(name)
    }

    const exts = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.jxl', '.avif']
    const files = entries
        .map(entry => entry.filename)
        .filter(name => exts.some(ext => name.endsWith(ext)))
        .sort()
    if (!files.length) throw new Error('No supported image files in archive')

    const spreads = {}
    if (smartSpreads) {
        const promises = []
        files.forEach((name) => {
            const extension = name.slice((name.lastIndexOf('.') - 1 >>> 0) + 2)
            if (!pageDimensions[extension]) return
            promises.push(new Promise(resolve => {
                loadBlob(name)
                    .then(blob => pageDimensions[extension](blob))
                    .then(dimensions => {
                        if (dimensions.width > dimensions.height * 1.05) {
                            spreads[name] = 'center'
                        }
                        resolve()
                    })
            }))
        })

        await Promise.all(promises)
    }

    const book = {}
    book.getCover = () => loadBlob(files[0])
    book.metadata = { title: file.name }
    book.sections = files.map(name => ({
        id: name,
        load: () => load(name),
        unload: () => unload(name),
        size: getSize(name),
        pageSpread: spreads[name],
    }))
    book.toc = files.map(name => ({ label: name, href: name }))
    book.rendition = { layout: 'pre-paginated' }
    book.resolveHref = href => ({ index: book.sections.findIndex(s => s.id === href) })
    book.splitTOCHref = href => [href, null]
    book.getTOCFragment = doc => doc.documentElement
    book.destroy = () => {
        for (const arr of urls.values())
            for (const url of arr) URL.revokeObjectURL(url)
    }
    return book
}

