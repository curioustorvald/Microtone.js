// The Analogue Warmth Edition's splash (see src/ui/warmth.js for when the
// edition is on). It opens every time the theme is switched ON — which is the
// joke: the plugins this parodies nag you at every single launch, and one of
// them will happily do it after you have paid.
//
// NOT translated, on purpose. The thing being sent up is the English-language
// marketing copy of the international plugin trade — the same wall of claims
// that reaches a Korean or German buyer untranslated. Running it through t()
// would put the joke in the language files and make it someone's problem to
// localise a parody of untranslated advertising.
//
// Everything below is a static string; nothing here interpolates user data.

const CLAIMS = [
  ["Physically modelled yellowed ABS interface",
   "every panel individually aged for 40 simulated years beside a sunlit studio window"],
  ["Authentic mushy membrane-button response",
   "down instantly, up reluctantly, exactly like the gear you miss"],
  ["Enhanced beige-frequency perception",
   "unlocks the 2 – 5 kHz band that flat design has been hiding from you"],
  ["Proprietary UV-Bombardment&trade; ageing algorithm",
   "bromine migration curve resolved at 128&times; oversampling (visually)"],
  ["True analogue drift",
   "the same pseudorandom numbers as before, but warmer"],
  ["Restores the harmonics your summing bus has been stealing",
   "up to +9&thinsp;dB of perceived nostalgia at 0&thinsp;% CPU"],
  ["Zero tubes, zero transformers, <span class=\"ws-shout\">maximum plastic</span>",
   "nothing in the signal path, which is how we keep the noise floor this low"],
  ["Not available in dark mode",
   "darkness is a digital construct"],
];

let open = false;

export function showWarmthSplash() {
  if (open || typeof document === "undefined") return;
  open = true;
  const dlg = document.createElement("dialog");
  dlg.className = "modal warmth-splash";
  dlg.innerHTML = `
    <div class="ws-badge">Limited Edition</div>
    <h3 class="ws-title">
      <span class="ws-brand">MICROTONE</span><span class="ws-tm">&trade;</span>
      <span class="ws-sub">Analogue Warmth Edition</span>
    </h3>
    <p class="ws-lede">The <b>only</b> tracker with a physically modelled enclosure.
      Twelve years of R&amp;D, four decades of sunlight, one colour scheme.</p>
    <ul class="ws-claims">
      ${CLAIMS.map(([head, sub]) =>
        `<li><span class="ws-tick">&check;</span><span><b>${head}</b><span class="ws-sub2">${sub}</span></span></li>`).join("")}
    </ul>
    <p class="ws-quote">&ldquo;I can <i>hear</i> the beige.&rdquo;
      <span class="ws-stars">&#9733;&#9733;&#9733;&#9733;&#9733;</span>
      <span class="ws-attrib">&mdash; a verified owner, probably</span></p>
    <div class="ws-price">
      <span class="ws-was">$349</span>
      <span class="ws-now">$0.00</span>
      <span class="ws-forever">limited-time offer &mdash; offer is forever</span>
    </div>
    <div class="modal-buttons">
      <button class="ws-go">ENGAGE&nbsp;WARMTH</button>
    </div>
    <p class="ws-fineprint">Analogue Warmth Edition does not alter a single sample of your audio.
      The perceived improvement <i>is</i> the product. It is also free, along with the rest of
      Microtone.js, which is how you can tell it isn't snake oil. Any resemblance to plugins
      sold at &pound;199 for a saturation curve is entirely intentional. Switch it off with the
      theme button in the top bar.</p>`;
  document.body.appendChild(dlg);
  const close = () => { dlg.close(); dlg.remove(); open = false; };
  dlg.querySelector(".ws-go").addEventListener("click", close);
  dlg.addEventListener("cancel", () => { dlg.remove(); open = false; });
  dlg.addEventListener("keydown", (e) => e.stopPropagation());
  dlg.showModal();
}
