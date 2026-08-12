# Ambisonic Spectral Radiation Monitor

## 1. Concept

The visualizer represents the Ambisonic soundfield as **one three-dimensional, frequency-resolved radiation surface**.

The surface is rendered through exactly three selectable orthographic views:

1. **Front**
2. **Side**
3. **Top**

Only one viewport is visible at a time.

The three views are different projections of the **same underlying soundfield**, not independent visualizers.

The underlying representation must remain **complex and phase-aware**. The visualizer must not reduce the soundfield to independent channel amplitudes or magnitude-only directional measurements before constructing the radiation pattern.

---

# 2. Soundfield Representation

For each frequency band and spatial direction ((\theta,\phi)), evaluate the complex Ambisonic soundfield:

[
p(\theta,\phi,f)
]

The complex value contains both:

* magnitude
* phase

The directional energy is then derived from the coherent field:

[
E(\theta,\phi,f)=|p(\theta,\phi,f)|^2
]

The important property is that the complex contributions from different spatial components are **summed before taking the magnitude**.

Thus:

[
p(\mathbf d)=\sum_s p_s(\mathbf d)
]

rather than:

[
E(\mathbf d)=\sum_s |p_s(\mathbf d)|^2
]

The latter would discard interference and phase relationships.

The radiation surface therefore represents the **resulting coherent soundfield**, not merely a collection of source powers.

Where appropriate, active acoustic intensity may also be used to improve physical directionality, but it must remain derived from the same underlying complex soundfield.

---

# 3. Radiation Surface

For each direction:

[
E(\theta,\phi)=\sum_b E_b(\theta,\phi)
]

where (b) represents the six frequency bands.

Convert total spatial energy into radial displacement:

[
r(\theta,\phi)=f(E(\theta,\phi))
]

and construct the surface:

[
\mathbf p(\theta,\phi)=
r(\theta,\phi)
\begin{bmatrix}
\sin\phi\cos\theta\
\sin\phi\sin\theta\
\cos\phi
\end{bmatrix}
]

A uniform field therefore produces a sphere.

A directional field produces lobes.

Interference, phase cancellation, and coherent summation naturally alter the geometry of those lobes.

No special rendering rule is required for phase inversion.

---

# 4. Six Frequency Bands

The soundfield is analysed independently in five frequency bands.

Suggested bands:

| Band     | Frequency range | Colour |
| -------- | ------------: | ------ |
| Bass     |     20–200 Hz | --cv-fx-op |
| Low-mid  |    200–800 Hz | --cv-fx-a1 |
| Mid      |  800 Hz–2 kHz | --cv-fx-a2 |
| High-mid |       2–8 kHz | --cv-fx-a3 |
| High     |      8–20 kHz | --cv-col-pan |

At every spatial sample, obtain:

[
E_1,\ldots,E_5
]

The **sum of the bands determines geometry**:

[
E_\Sigma=\sum_iE_i
]

The **relative spectral composition determines colour**:

[
\mathbf C(\theta,\phi)=
\frac{\sum_iE_i(\theta,\phi)\mathbf C_i}
{\sum_iE_i(\theta,\phi)}
]

Therefore:

* radial distance → total energy
* colour → spectral composition
* shading → 3D orientation/depth
* silhouette → spatial radiation pattern

The five bands do not produce five separate surfaces.

---

# 5. Phase and Interference Behaviour

Phase is not represented by an additional graph.

It is represented **implicitly through the geometry of the coherent radiation surface**.

This is important because identical source amplitudes can produce radically different spatial perceptions depending on their relative phase.

## Phenomenon: identical sources, same phase

Two identical coherent sources are placed symmetrically.

### 180° separation

Two equal sources exist on opposite sides of the listener.

Expected perceptual result:

> The sources can collapse toward the centre rather than being perceived simply as two independent points.

The radiation surface should therefore reflect the coherent combined field rather than displaying two independent source lobes.

### 60° separation

Two equal sources are placed symmetrically around the front centre.

Expected perceptual result:

> A phantom source is perceived around front-centre.

Again, the visualization should show the resulting coherent spatial field rather than simply drawing two source markers.

---

## Phenomenon: one source phase-inverted

Keep the source positions and amplitudes identical, but invert the phase of one source by 180°.

### 180° separation

Expected result:

> The two sources become maximally distinct, with strong opposing spatial structure and a cancellation/null region between them.

### 60° separation

Expected result:

> The phantom-centre behaviour is destroyed; the sound becomes spatially separated, with the interference pattern producing distinct directional lobes.

The radiation surface should naturally develop this structure because:

[
p=p_1+p_2
]

becomes:

[
p=p_1-p_2
]

before the magnitude is calculated.

The visualization must **not** implement a special "phase-inverted source" rule.

The geometry itself is the result of the phase relationship.

---

# 6. Important Distinction: Physical Field vs Perceived Location

The radiation surface represents:

> **the physical coherent soundfield.**

It should not be interpreted as a direct map of human localization.

Perceived source location also depends on the listener and playback system, including:

* interaural level differences
* interaural time differences
* interaural phase relationships
* frequency-dependent localization
* HRTF
* coherence
* room reflections

Therefore the visualizer should not artificially move the radiation surface toward a "perceived centre."

If a phantom centre emerges acoustically, it should emerge from the coherent field itself.

A separate perceptual localization indicator could be added in the future, but it should remain conceptually distinct from the radiation surface.

---

# 7. Three Strict Orthographic Views

The single radiation surface is viewed through exactly three canonical cameras.

## Front

Horizontal:

* left ↔ right

Vertical:

* down ↔ up

Depth:

* front ↔ rear

## Side

Horizontal:

* rear ↔ front

Vertical:

* down ↔ up

Depth:

* left ↔ right

## Top

Horizontal:

* left ↔ right

Vertical:

* rear ↔ front

Depth:

* down ↔ up

All three projections are strictly orthographic.

Perspective is not used.

The user selects the active viewport:

```text
[ Front ] [ Side ] [ Top ]
```

Only the selected viewport is displayed.

Switching views changes only the camera projection.

The underlying radiation surface remains identical.

---

# 8. Depth Cues

Although the output is a 2D orthographic projection, it must retain enough information to communicate the three-dimensional shape.

## Occlusion

Near portions of the radiation surface obscure distant portions.

## Shading

Apply restrained lighting based on surface normals.

Lighting communicates geometry, not loudness.

## Back-surface attenuation

Distant portions may be rendered somewhat dimmer or more transparent.

This allows otherwise hidden lobes to remain visible without turning the display into a flat heatmap.

## Spherical reference grid

Use a sparse latitude/longitude grid.

The grid follows the deformed surface, allowing the viewer to see how the sphere has expanded or contracted spatially.

---

# 9. Spectral Colour

Colour identifies the spectral composition of each point on the surface.

A direction containing predominantly one band receives that band's colour.

A direction containing multiple bands receives a mixture determined by their relative energy.

Colour must not encode absolute loudness.

For example, a quiet high-frequency region and a loud high-frequency region should remain recognizably the same spectral colour while differing in geometric magnitude and/or intensity.

The six-band legend should always be visible or readily accessible.

---

# 10. Temporal Behaviour

The soundfield is analysed over short-time windows rather than individual waveform samples.

Apply temporal smoothing independently to:

* radial geometry
* spectral colour

Use sufficiently fast attack to preserve transients and somewhat slower release to prevent the surface from jittering.

The visualizer should feel like an audio spatial analyzer rather than an oscilloscope.

---

# 11. Rendering Pipeline

The conceptual pipeline is:

```text
                 Ambisonic input
                       │
                       ▼
             Frequency-band analysis
                       │
                       ▼
             Complex SH soundfield
                       │
                       ▼
           Coherent spatial evaluation
                       │
                       ▼
                 |p(θ,φ)|²
                       │
              ┌────────┴────────┐
              │                 │
              ▼                 ▼
        Total energy       Band energies
              │                 │
              ▼                 ▼
        Surface radius      Surface colour
              │                 │
              └────────┬────────┘
                       ▼
              One 3D radiation surface
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
        Front         Side          Top
       camera        camera        camera
          │            │            │
          └────────────┴────────────┘
                       │
                 View selector
```

---

# 12. Design Principle

The visualizer should always preserve this hierarchy:

> **One soundfield → one radiation surface → three possible orthographic observations.**

Not:

> three direction meters + a phase meter + six spectrum meters.

Phase is part of the soundfield.

Frequency is part of the soundfield.

Interference is part of the soundfield.

Spatial separation is part of the soundfield.

The visualization should therefore let these properties **emerge from the shape and colour of the same object**.

---

# 13. Intended Result

The final visualization should answer several questions simultaneously without introducing separate competing displays:

* Where is acoustic energy concentrated?
* How spatially diffuse or directional is it?
* How does its direction vary with frequency?
* How does the soundfield behave in three dimensions?
* Where are interference/null regions?
* Does phase coherence cause sources to collapse toward a phantom centre?
* Does phase inversion produce separated lobes instead?
* How does the resulting structure look from front, side, and top?

The central idea is therefore:

> **A phase-aware, spectrally coloured three-dimensional radiation surface whose geometry is produced by coherent Ambisonic field summation, observed through one of three strict orthographic projections.**

---

# 14. The 3D Graphics

Use whichever most convenient. Be it a raw-dogging, or three.js, choice don't matter.
