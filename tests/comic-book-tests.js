import { makeComicBook } from '../comic-book.js'

{
    // CBZ entries often use uppercase extensions; matching must be case-insensitive
    // but stored paths must stay as in the archive for loadBlob lookups.
    const loadBlob = async () => new Blob([new Uint8Array([1, 2, 3])])
    const getSize = () => 3
    const file = { name: 'sample.cbz' }
    const book = makeComicBook({
        entries: [
            { filename: '001.JPG' },
            { filename: '002.Png' },
            { filename: 'readme.txt' },
        ],
        loadBlob,
        getSize,
    }, file)

    console.assert(book.sections.length === 2,
        `expected 2 image sections, got ${book.sections.length}`)
    console.assert(book.sections[0].id === '001.JPG',
        `expected id 001.JPG, got ${book.sections[0].id}`)
    console.assert(book.sections[1].id === '002.Png',
        `expected id 002.Png, got ${book.sections[1].id}`)
}

{
    let threw = false
    try {
        makeComicBook({
            entries: [{ filename: 'note.TXT' }],
            loadBlob: async () => new Blob(),
            getSize: () => 0,
        }, { name: 'empty.cbz' })
    } catch (e) {
        threw = true
        console.assert(e.message === 'No supported image files in archive',
            `unexpected error: ${e.message}`)
    }
    console.assert(threw, 'expected throw when archive has no image entries')
}
