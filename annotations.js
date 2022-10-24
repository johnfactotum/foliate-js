export class Annotations {
    #annotationsByIndex = new Map()
    #byValue = new Map()
    #anchorsByValue = new Map()
    #indicesByValue = new Map()
    constructor({ resolve, compare, onAdd, onDelete, onUpdate }) {
        this.resolve = resolve
        this.compare = compare
        this.onAdd = onAdd
        this.onDelete = onDelete
        this.onUpdate = onUpdate
    }
    async add(annotation, sorted) {
        const { value } = annotation
        if (this.#byValue.has(value)) return
        const { index, anchor } = await this.resolve(value)
        this.#byValue.set(value, annotation)
        this.#indicesByValue.set(value, index)
        this.#anchorsByValue.set(value, anchor)
        if (this.#annotationsByIndex.has(index)) {
            const arr = this.#annotationsByIndex.get(index)
            if (sorted) {
                arr.push(annotation)
                this.onAdd?.(annotation, index, arr.length - 1)
            } else {
                let position = 0
                for (let i = 0; i < arr.length; i++) {
                    const itemValue = arr[i].value
                    if (this.compare(value, itemValue) <= 0) break
                    position = i + 1
                }
                arr.splice(position, 0, annotation)
                this.onAdd?.(annotation, index, position)
            }
        } else {
            this.#annotationsByIndex.set(index, [annotation])
            this.onAdd?.(annotation, index, 0)
        }
    }
    update(annotation) {
        const index = this.#indicesByValue.get(annotation.value)
        const old = this.#byValue.get(annotation.value)
        Object.assign(old, annotation)
        this.onUpdate?.(annotation, index)
    }
    delete(value) {
        const index = this.#indicesByValue.get(value)
        const arr = this.#annotationsByIndex.get(index)
        const position = arr.findIndex(a => a.value === value)
        arr.splice(position, 1)
        this.#byValue.delete(value)
        this.#indicesByValue.delete(value)
        this.#anchorsByValue.delete(value)
        this.onDelete?.(value, index, position)
    }
    getByIndex(index) {
        return this.#annotationsByIndex.get(index) ?? []
    }
    getAnchor(value) {
        return this.#anchorsByValue.get(value)
    }
}
