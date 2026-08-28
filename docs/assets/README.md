# Brand assets

`social-preview.png` is the 1280×640 repository preview for the Public Preview.
It uses original generic gateway and agent-node motifs and intentionally avoids
Tencent, WeCom, WeChat, Agent-provider logos, mascots, or endorsement language.

The exact text is:

- `WeCom Agent Gateway`
- `One IM channel. Pluggable agent kernels.`

Keep the source aspect ratio and verify the rendered repository card after any
GitHub social-preview upload or replacement.

`verified-kernel-cases/pi-wecom-private.png` is a cropped, privacy-reviewed
macOS WeCom screenshot captured on 2026-08-28. It shows an ordinary Pi Agent
reply and a separately requested interaction card. The crop excludes the chat
sidebar, account identifiers, credentials, internal IDs, and unrelated chats.

The `demo/` directory contains a 26-second real-client product walkthrough:

- `wecom-agent-gateway-demo.gif` is the lightweight README embed;
- `wecom-agent-gateway-demo.mp4` is the 1280×720 H.264 version;
- `wecom-agent-gateway-demo-cover.png` is the static fallback and link preview.

The walkthrough records real Pi/WeCom behavior: immediate status, mutable final
text, a native confirmation card, same-task resume, and proactive text/media.
Raw desktop captures are intentionally ignored. See [`demo/README.md`](demo/README.md)
for the privacy gate and reproducible macOS build.
