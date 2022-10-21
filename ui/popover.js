const clamp = (min, max, x) => Math.min(max, Math.max(min, x))

const arrowHeight = 10
const arrowWidth = 20
const radius = 6

const createSVGElement = tag =>
    document.createElementNS('http://www.w3.org/2000/svg', tag)

const createArrow = down => {
    const h = arrowHeight + 1
    const svg = createSVGElement('svg')
    svg.setAttribute('width', arrowWidth)
    svg.setAttribute('height', arrowHeight)
    const polygon = createSVGElement('polygon')
    polygon.setAttribute('points', down
        ? `0 ${h}, ${arrowWidth / 2} 0, ${arrowWidth} ${h}`
        : `0 0, ${arrowWidth / 2} ${h}, ${arrowWidth} 0`)
    svg.classList.add(down ? 'popover-arrow-down' : 'popover-arrow-up')
    svg.append(polygon)
    return svg
}

export const createPopover = (width, height, { x, y }, dir) => {
    const down = dir === 'down'
    const fullHeight = height + arrowHeight
    const overlay = document.createElement('div')
    Object.assign(overlay.style, {
        position: 'absolute',
        left: '0',
        top: '0',
        width: '100vw',
        height: '100vh',
    })
    const arrow = createArrow(down)
    Object.assign(arrow.style, {
        position: 'absolute',
        left: `${clamp(radius, window.innerWidth - arrowWidth - radius,
            x - arrowWidth / 2)}px`,
        top: `${clamp(0, window.innerHeight - arrowHeight,
            down ? y : y - arrowHeight)}px`,
    })
    const popover = document.createElement('div')
    popover.classList.add('popover')
    Object.assign(popover.style, {
        position: 'absolute',
        boxSizing: 'border-box',
        overflow: 'hidden',
        left: `${clamp(0, window.innerWidth - width, x - width / 2)}px`,
        top: `${clamp(0, window.innerHeight - fullHeight,
            down ? y + arrowHeight : y - fullHeight)}px`,
        width: `${width}px`,
        height: `${height}px`,
    })
    overlay.addEventListener('click', () => {
        overlay.parentNode.removeChild(overlay)
        arrow.parentNode.removeChild(arrow)
        popover.parentNode.removeChild(popover)
    })
    return { popover, arrow, overlay }
}
