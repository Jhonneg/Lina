# Progressive speech

The original local-inference progressive controller was superseded by
[progressive cloud speech](progressive-cloud-speech.md) and removed in Milestone
5F.5. Follow that guide for the current ordered queue, 800-character/three-segment
budget, prefetch, completion flushing, cancellation and duplicate prevention.

The shared `speech-segmenter.ts`, `spoken-text.ts` Markdown AST helpers and bounded
numeric diagnostics remain. The cloud buffer applies its stricter cumulative
limits rather than using the legacy 4,000-character helper default. Code and HTML
are excluded; incomplete structures and sentences are held until eligible.

Historical local inference timing and recovery measurements remain in
[voice-performance.md](voice-performance.md) and its unchanged JSON artifacts.
They are not measurements of the current cloud voice. Local workers, model
loading/download consent and the benchmark route are no longer shipped.
