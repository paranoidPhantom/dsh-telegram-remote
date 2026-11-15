# Agent-authored Telegram widgets

Write `telegram_widget_<name>.html` inside the connected session workspace using a native write/edit tool. The same basename in the same topic is a delivery key: unchanged compiled output does nothing; changed output sends first, then removes the previous message. Agent HTML owns the content; the bot supplies no widget templates.

Use inline CSS and classic JavaScript, SVG/CSS charts, no runtime fetch/XHR/WebSocket, no navigation, external fonts or widget request calls. Queries and sharing are disabled. Input and compiled output must each fit 32768 UTF-8 bytes, compiled output at most 4096 bytes with zlib level 9. Prefer tiny semantic markup.

The compiler recursively resolves supported resource references, rejects private-network URLs and local paths outside the real workspace, bounds downloads and builds, bundles supported modules, and inlines assets. Required CSS/JS fetch failures fail the build; optional images/fonts may be removed with warnings. Original HTML is attached on a compile/send failure. Unresolved or unsupported constructs fail with a precise reason rather than sending a broken widget.
