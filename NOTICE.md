# Source attribution

The agent-card foil texture in `src/features/agents/assets/card-foil.webp`,
portrait palette sampling, and reveal/hover treatment are adapted from
[Block Buzz PR #5790](https://github.com/block/buzz/pull/5790), revision
`0c7cea1f91a681f3751af1ac25a7e15d0e99d36b`. The texture is the first embedded
image in `desktop/src/features/agents/assets/buzz-trading-card-template.svg`.

The relay read model in `src/features/relay` and development read broker in
`browser-host` are adapted from the supplied Astra example. The channel layout
and virtualizer behavior are adapted from that example's Channels view.

Astra's presentation is derived from Block Buzz `prototypes/project-cube-orbit`,
revision `0cd836965110adb18b95747c8656779c470d6e4d`:
https://github.com/block/buzz/tree/0cd836965110adb18b95747c8656779c470d6e4d/prototypes/project-cube-orbit

The Apache-2.0 license is preserved in [LICENSE](LICENSE). Changes here
include Cordis service ownership, scoped channel panels, GitHub reference rendering,
connection lifecycle, stylesheet extraction and integration with the foundation.

App, favicon, and touch icons in `public/` and `src-tauri/icons/` are copied from
Block Buzz's `desktop/src-tauri/icons` ([source repository](https://github.com/block/buzz)).
The shell palette and proportions are adapted from the supplied Buzz screenshots.

`public/bestie.png` is the snake portrait supplied by the user for the shell.

`public/shell-gradient.png` is the background image supplied by Wes for the bento
shell on 2026-09-09 (SHA-256
`618ce821eaea22dd30bddb0c2a933284f0a49f6b4f0cefff5ae0b51e2b3ea651`).
The repeating dots are drawn in CSS, not baked into the image.

The Emoji Mart picker configuration and search-input focus/correction behavior in
`src/features/messages/emoji-mart.ts` are adapted from Block Buzz
`desktop/src/features/custom-emoji/ui/EmojiPicker.tsx` at revision
`b9392d9d78744df365f9276e1ffe8c1baa5ea903`. The adapter adds scoped custom IDs,
explicit dictionary cleanup, and lazy loading for the session-owned catalog.

The chart grammar, option sanitizer and data-row tables in `src/bundled/charts`
are adapted from a Charts plugin by Alessandro Joabar (GitHub `sandro-sq`).

OneDrive is a trademark of Microsoft.

## Harness brand marks

The Goose and Pi marks in `src/shared/design-system/icons/HarnessLogos.tsx`
are reused from old Buzz to identify their respective harnesses.

Goose: [block/goose](https://github.com/block/goose), revision
`305849b71709b95b86ed9f11bd3bc939899c0aab`,
`documentation/static/img/goose.svg`. Apache-2.0 © Block, Inc.; the license is
preserved in [LICENSE](LICENSE). Old Buzz changed the fill to `currentColor`
and removed the redundant clipping wrapper. This app adds the shared icon
sizing, ref and decorative accessibility gateway.

Pi: [earendil-works/pi-website](https://github.com/earendil-works/pi-website),
revision `2f5e410b97474d0a34ec2500aa1aa58d6c3f992c`, `src/favicon.svg`.
The artwork is unchanged; this app adds the shared icon sizing, ref and
decorative accessibility gateway. Its license follows:

MIT License

Copyright (c) 2026 Earendil Inc. and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Claude: the bundled `icons/claude.png` is reused unchanged from Block Buzz's
`desktop/src/features/onboarding/assets/harness-logos/claude.png` to identify
Anthropic's Claude harness. Claude is a trademark of Anthropic.

Codex: the OpenAI Blossom mark in `CodexLogoArtwork` is taken from OpenAI's
brand kit (https://cdn.openai.com/brand/openai-logos.zip,
`SVGs/OAI_OpenAI-Blossom_Black.svg`) to identify OpenAI's Codex harness. This
app changes the fill to `currentColor` and crops the viewBox to the mark.
OpenAI and the Blossom logo are trademarks of OpenAI.

Hermes Agent: the bundled `icons/hermes.png` is reused unchanged from Block Buzz's
`desktop/public/harness-logos/hermes.png`. Its upstream is
[NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent), revision
`6ad632b`, `website/static/img/logo.png`, MIT © 2025 Nous Research. Old Buzz
cropped the border, padded it to square, resized to 64×64 and quantised it to
16 colours. The MIT license terms above also apply to this artwork, with the
Nous Research copyright notice.

Builderlab: the Builderlab Event 2026 mark was supplied by Taylor Ho as native
Figma SVG exports on October 29, 2026. Builderlab is a mark of Block, Inc.
The small-size adaptation is used for 16–32px harness choices and agent cards
and for the sign-in callback in `public/builderlab-mark.svg`. It broadens
the silhouette's top-right and bottom-left corner curves for legibility at small
sizes, preserves the letter geometry and Gaussian blur, pads the viewBox to
square, and converts the letter to a transparent luminance-mask cutout so the
mark follows `currentColor`.
Procedural grain and displacement are omitted because they alias at small sizes
and render differently from the source texture. Larger branded surfaces should
use a dedicated textured asset. No open-source license is asserted for this
supplied brand asset.

The callback's `src-tauri/src/oauth_callback/cubes.webp` is a cropped, WebP-encoded
version of the transparent cube artwork in the supplied Buzz web design-system
sign-in references, used at Taylor Ho's direction on October 30, 2026. No
open-source license is asserted for this supplied brand artwork.
The background swatch embedded in `page.css` comes from the same references.

## Model-family brand marks

The additional artwork in `src/shared/design-system/icons/HarnessLogos.tsx`
identifies model families in shared pickers, including Builderlab and Goose.
All marks remain the property of their respective owners; their inclusion
identifies supported models and does not imply endorsement.

DeepSeek: [DeepSeek-icon.svg](https://commons.wikimedia.org/wiki/File:DeepSeek-icon.svg),
file revision June 30, 2025. Copyright © DeepSeek, MIT (Expat) license.
The MIT terms reproduced above apply with this copyright notice. The original
blue fill and path geometry are preserved; this app adds its shared SVG wrapper.

Grok: [Grok-feb-2025-logo.svg](https://commons.wikimedia.org/wiki/File:Grok-feb-2025-logo.svg),
by X.AI Corp., classified by Wikimedia Commons as public domain because it
consists of simple geometric shapes or text. This app retains the two mark
paths, omits the wordmark, crops the viewBox to square, and preserves the
original `currentColor` fill. Grok is a trademark of xAI.

Z.ai / GLM: [Z.ai (company logo).svg](https://commons.wikimedia.org/wiki/File:Z.ai_(company_logo).svg),
by Z.ai, sourced from its [official favicon](https://z-cdn.chatglm.cn/z-ai/static/logo.svg).
Wikimedia Commons classifies the artwork as public domain because it consists
of simple geometric shapes or text. This app preserves the favicon geometry,
colors and border, removes unused styles and groups, and adds its shared SVG
wrapper. Z.ai and GLM are marks of their respective owner.

Kimi: the official [Moonshot Kimi favicon](https://www.kimi.com/favicon-light.ico),
retrieved October 28, 2026, converted from its 48×48 ICO frame to the colocated
`icons/kimi.png` without resizing or changing colors. No open-source license is
asserted for this official brand asset. Kimi is a trademark of Moonshot AI.

## Plugin catalog artwork

The generated plugin PNG artwork in `src/bundled/*/icon.png` was created by
Taylor Ho using GPT Image 2.5 and supplied for Buzz, including the Claude Code,
Codex, goose and GitHub catalog illustrations. These generated integration
illustrations incorporate third-party marks; those marks remain the property of their respective
owners. Claude is a trademark of Anthropic; OpenAI and the Blossom logo are
trademarks of OpenAI; goose is a trademark of LF Projects; GitHub and Octocat
are trademarks of GitHub, Inc. Their inclusion identifies the corresponding
integrations and does not imply endorsement.

The Huddles, Voice Notes, Usage, Mermaid diagrams, Pi, TypeSafe, Builderlab,
Agent Attention UI, Shared compute and Focus illustrations were supplied separately
by Taylor Ho and resized for the catalog; the generation attribution above does not
cover these ten assets.

## Embedded callback typeface

`src-tauri/src/oauth_callback/inter-latin.woff2` is the unchanged Latin variable
font from the app's existing `@fontsource-variable/inter` 5.3.0 dependency, embedded
for consistent standalone callback typography. Its license follows:

Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter) Inter-Italic[opsz,wght].ttf: Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
