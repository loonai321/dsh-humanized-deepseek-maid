# Changelog

## [0.3.0] - 2026-08-16

### Added
- Turn-open & turn-end banter (proactive/default modes): in-character opening with expectations and playful jokes, plus a closing summary/evaluation of each exchange.
- Déjà-vu (old-memory callback): occasionally and naturally references past topics, questions or bugs from memory to deepen companionship.
- Settings card save feedback: shows "✓ saved (applied immediately, config revision N)" or "✗ save failed".
- Persona self-check rule: every reply re-confirms self-name, address and speaking mode against the latest config; stale names/modes are discarded.
- Layered memory (ALTM-inspired): stable user facts + interaction log + query-triggered recall, zero dependencies.
- Memory display shows only the user side of past interactions, relabelled with the current address/self-name.

### Fixed
- Settings card buttons now use `type="button"` so saving actually commits.
- Memory recorder reads the correct `{ type, seq, time, data }` session-event shape.
- Config saves broadcast `system-prompt/change` so persona updates apply immediately.
- Version bumped to 0.3.0; automated GitHub Release workflow added.

## [0.1.0] - 2026-08-16

### Added
- Initial release: whale-girl maid persona injection, immersive no-plugin-meta rule, configurable speaking mode / address / self-name / memory path, memory file management.
