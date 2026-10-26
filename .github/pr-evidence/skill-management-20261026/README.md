# Skill management UI evidence

These images and the recording show synthetic Skill fixtures in the isolated development preview and browser component tests. They do not contain user conversations or credentials.

- [Before](./before.jpg): the earlier detail dialog layout, before the final compact layout and alignment fixes.
- [After](./after.jpg): the final overview layout, with native light borders, tag chips, a compact expert section, and the shared 920 px dialog width used by both views.
- [Tag interaction recording](./tags.webm): adding and removing tag chips while preserving pending input. This is a 3.84-second excerpt from the browser test `edits tag chips without duplicates and preserves pending input when removing a chip`.

The runtime source represented by the final evidence is integration candidate `b7d06c615385d80a7865a86e381a7f3088380b29`. The evidence commit adds only these review assets and their documentation; it does not change runtime behavior.

Broader implementation and validation history: [Skill acceptance record](../../../docs/skill-management-2026-10-26-acceptance.md). Current integration check results are recorded on the pull request.
