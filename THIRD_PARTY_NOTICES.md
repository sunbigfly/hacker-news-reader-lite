# Third-party notices

Selected generic owners and behavioral tests were adapted from Awesome LinuxDo Reader Lite at commit `eec5e110d6e003c790947df294ef05a44e8bac8d`.

Copyright (c) 2026 sunbigfly. Used under the MIT License included in this repository.

Exact source paths and SHA-256 values are recorded in `reuse-manifest.json`.
This is provenance only: Hacker News Reader has no runtime or build dependency on the source repository.

## Multiavatar

Comment avatars are generated locally by Multiavatar 1.0.7, loaded from a
version-pinned jsDelivr URL with SHA-256 subresource integrity.

Copyright (c) 2020-2021 Gie Katon. Multiavatar permits use in software projects,
including commercial use, subject to the restrictions in the Multiavatar
License v1.0. The generator is used only as an addition to Hacker News Reader;
the design assets are not repackaged, rebranded, or offered as a competing
avatar product.

- Project: https://multiavatar.com/
- Package: https://www.npmjs.com/package/@multiavatar/multiavatar/v/1.0.7
- License: https://github.com/multiavatar/Multiavatar/blob/main/LICENSE

## ECDICT

The wordbook's offline English-Chinese entry, part-of-speech tags and word forms come from a
snapshot of the ECDICT core vocabulary, embedded in the userscript as a gzipped payload
(`lite/src/vocabulary/ecdict-data.ts`).

- Project: https://github.com/skywind3000/ECDICT
- License: MIT

## Wiktionary and Tatoeba

Wordbook lookups query these public endpoints on demand, from the reader's own browser, and only
for a word the reader explicitly opens:

- Wiktionary REST API, definitions for one word: https://en.wiktionary.org/api/rest_v1/
  Content is available under CC BY-SA 4.0; the entry links back to its Wiktionary page.
- Tatoeba API, bilingual example sentences: https://api.tatoeba.org/
  Sentences are CC BY 2.0 FR; each example keeps its own attribution and license label.
