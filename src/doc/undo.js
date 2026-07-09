// Bounded undo/redo over invertible ops (ops.js). apply() pushes the inverse;
// consecutive ops sharing coalesceKey AND gestureId collapse (slider drags,
// rapid typing on one cell). Redo stack clears on every fresh apply.

const MAX_UNDO = 512;

export class UndoStack {
  constructor(doc, onDirty) {
    this.doc = doc;
    this.onDirty = onDirty ?? (() => {});
    this.undoStack = []; // [{inverse, coalesceKey, gestureId, dirty}]
    this.redoStack = [];
  }

  /** Apply an op to the document; returns the op's dirty tags. */
  apply(op) {
    const inverse = op.apply(this.doc);
    const dirty = op.dirty(this.doc);
    const top = this.undoStack[this.undoStack.length - 1];
    const coalesce =
      top !== undefined &&
      op.gestureId !== null &&
      top.gestureId === op.gestureId &&
      top.coalesceKey === op.coalesceKey;
    if (!coalesce) {
      // keep the FIRST inverse of a gesture (restores pre-gesture state)
      this.undoStack.push({
        inverse,
        coalesceKey: op.coalesceKey,
        gestureId: op.gestureId,
        dirty,
      });
      if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    }
    this.redoStack.length = 0;
    this.onDirty(dirty);
    return dirty;
  }

  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }

  undo() {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    const redoInverse = entry.inverse.apply(this.doc);
    this.redoStack.push({ ...entry, inverse: redoInverse });
    this.onDirty(entry.dirty);
    return entry.dirty;
  }

  redo() {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    const undoInverse = entry.inverse.apply(this.doc);
    this.undoStack.push({ ...entry, inverse: undoInverse });
    this.onDirty(entry.dirty);
    return entry.dirty;
  }
}
