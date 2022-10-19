# foliate-js

Library for rendering e-books in the browser.

Features:
- Supports EPUB, MOBI, KF8, FB2, CBZ
- Pure JavaScript
- Small and modular
- No dependencies
- Does not depend on or include any library for unzipping; bring your own Zip library
- Does not require loading whole file into memory
- Does not care about older browsers
- No continuous scrolling mode :(

## Demo

Serve the files with a server, and open `reader.html`. Or visit https://johnfactotum.github.io/foliate-js/reader.html.

## Overview

The project is designed to be modular. It has two renderers, one for paginating reflowable books, and one for fixed layout. The `View` class defined in `view.js` is the one that strings everything together.

Processors for each book format returns an object that implement the following interface:
- `.sections`: an array of sections in the book. Each item has the following properties:
    - `.load()`: returns a string of the URL that will be rendered. May be async.
    - `.unload()`: returns nothing. If present, can be used to free the section.
    - `.createDocument()`: returns a `Document` object of the section. Used for searching. May be async.
    - `.size`: a number of the byte size of the section. Used for showing reading progress.
    - `.linear`: a string. If it is `"no"`, the section is not part of the linear reading sequence.
    - `.cfi`: base CFI string of the section. The part that goes before the `!` in CFIs.
    - `.id`: an identifier for the section, used for getting TOC item (see below). Can be anything, as long as they can be used as keys for the `Map` object.
- `.dir`: a string representing the page progression direction of the book (`"rtl"` or `"ltr"`).
- `.toc`: an array representing the table of contents of the book. Each item has
    - `.label`: a string label for the item
    - `.href`: a string representing the destination of the item. Does not have to be a valid URL.
    - `.subitems`: a array that contains TOC items
- `.pageList`: same as the TOC, but for the Page List.
- `.metadata`: an object representing the metadata of the book.
- `.rendition`: an object that contains properties similar to the EPUB rendition properties. If `.layout` is `"pre-paginated"`, the book is rendered with the fixed layout renderer.
- `.resolveHref(href)`: given an href string, returns an object representing the destination referenced by the href, which has the following properties:
    - `.index`: the index of the referenced section in the `.section` array
    - `.anchor(doc)`: given a `Document` object, returns the document fragment referred to by the href (can either be an `Element` or a `Range`), or `null`
- `.resolveCFI(cfi)`: same as above, but with a CFI string instead of href
- `.isExternal(href)`: returns a boolean. If `true`, the link should be opened externally.

The following methods are used for getting the correct TOC and Page List item when navigating:
- `.splitTOCHref(href)`: given an href string (from the TOC), returns an array, the first element is the `id` of the section (see above), and the second element is the fragment identifier (can be any type; see below)
- `.getTOCFragment(doc, id)`: given a `Document` object and a fragment identifier (the one provided by `.splitTOCHref()`; see above), returns a `Node` representing the target linked by the TOC item

Almost all of the properties and methods are optional. At minimum it needs `.sections` and the `.load()` method for the sections, as otherwise there won't be anything to render.
