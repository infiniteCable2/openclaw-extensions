# Kitten model text preparation

The Kitten backend removes Unicode emoji grapheme clusters immediately before
model synthesis, for both plain and expressive requests. This includes joined
families/professions, skin tones, flags and keycap sequences. Removal inserts a
separator, so adjacent words or control fragments cannot concatenate.

Visible text, expression-plan offsets, service segmentation, joining pauses and
other TTS backends remain unchanged. Ordinary Unicode writing, numbers, currency
and textual copyright/trademark signs are preserved. Emotions, emphasis and vocal
events remain available; emoji are not automatically converted into vocal events.
This filter does not guess ASCII emoticons such as `:)` from punctuation.

The Unicode parser is qualified with regex 2026.7.19 and 2026.9.29. The bounded
dependency range supports the existing Kitten runtime while preserving the
separate Chatterbox deployment's original pinned constraints.

A unit containing only removed decoration (possibly an emotion label and
punctuation) produces 10 ms of silence without calling the model. This preserves
the service's one-result-per-unit streaming contract and the existing join pauses.
Generated audio itself is neither trimmed nor filtered.
