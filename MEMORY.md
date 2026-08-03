# Project Memory

- 2026-08-03 20:00 CEST — The repository ships project-level plugins from `.smallcode/plugins/`; these are loaded automatically before user-level plugins from `~/.config/smallcode/plugins/`.
- 2026-08-03 20:00 CEST — Gemma 4 must not receive serialized reasoning fields from earlier assistant messages. The bundled `gemma4-history-filter` pre-request hook removes `reasoning_content`, `reasoning`, and `reasoning_text` only for Gemma 4 model identifiers.
- 2026-08-03 20:10 CEST — Model-generated `bash` and `run` calls can omit their required `command`; the executor must return a structured tool error instead of calling string methods on `undefined` and crashing the TUI.
