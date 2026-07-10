// Help popup (?) — keyboard reference.

export function showHelp() {
  const dlg = document.createElement("dialog");
  dlg.className = "modal help-modal";
  dlg.innerHTML = `
    <h3>Microtone.js — keys</h3>
    <div class="help-cols">
      <dl>
        <dt>Space</dt><dd>play from cursor / stop</dd>
        <dt>Shift+Space</dt><dd>play from start</dd>
        <dt>F1…F7</dt><dd>views (Timeline, Cues, Patterns, Samples, Instruments, Project, File)</dd>
        <dt>Insert</dt><dd>record mode on/off</dd>
        <dt>[ ]</dt><dd>octave down / up</dd>
        <dt>Enter</dt><dd>Timeline: pick up cell's instrument · Cues: command popup</dd>
        <dt>M / N</dt><dd>Timeline, navigate mode: mute / solo the cursor channel (or click / Ctrl+click a channel header)</dd>
        <dt>Ctrl+Z / Ctrl+Y</dt><dd>undo / redo</dd>
        <dt>Ctrl+S</dt><dd>save to browser disk (OPFS)</dd>
        <dt>Ctrl+G</dt><dd>go to cue:row</dd>
      </dl>
      <dl>
        <dt>A S D F G H J K</dt><dd>piano white keys (C D E F G A B C)</dd>
        <dt>W E · T Y U</dt><dd>piano black keys</dd>
        <dt>\` 1 2 3</dt><dd>note column: key-off ===, cut ^^^, fade ~~~, fast-fade ~^~</dd>
        <dt>0-9 A-F</dt><dd>hex entry (inst / vol / pan / fx arg)</dd>
        <dt>0-Z</dt><dd>effect opcode (base-36)</dd>
        <dt>+ / -</dt><dd>vol/pan column: slide selectors</dd>
        <dt>Delete or .</dt><dd>clear field</dd>
        <dt>← → / Tab</dt><dd>sub-column / next channel</dd>
        <dt>wheel · Shift+wheel</dt><dd>scroll rows · channels</dd>
        <dt>wheel on cursor cell</dt><dd>record mode: step the hovered column (notes step by one degree of the song's pitch table)</dd>
      </dl>
    </div>
    <div class="modal-buttons"><button>Close</button></div>`;
  document.body.appendChild(dlg);
  dlg.querySelector("button").addEventListener("click", () => { dlg.close(); dlg.remove(); });
  dlg.addEventListener("cancel", () => dlg.remove());
  dlg.addEventListener("keydown", (e) => e.stopPropagation());
  dlg.showModal();
}
