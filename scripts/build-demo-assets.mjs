#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assetDir = join(repoRoot, "docs/assets/demo");
const captureDir = process.env.DEMO_CAPTURE_DIR
  ? resolve(process.env.DEMO_CAPTURE_DIR)
  : join(assetDir, "captures");
const buildDir = join(assetDir, ".build");

const slides = [
  {
    name: "01-intro",
    duration: 3,
    intro: true,
  },
  {
    name: "02-ack",
    duration: 4,
    capture: "02-message-progress.png",
    crop: "crop=518:160:250:610,pad=518:704:0:272:color=white",
    eyebrow: "FAST ACKNOWLEDGEMENT",
    title: ["Message in.", "Agent connected."],
    body: ["Scoped ACL and ordered sessions", "keep the IM path responsive."],
    accent: "#35d6ff",
  },
  {
    name: "03-stream",
    duration: 4,
    capture: "03c-message-stable.png",
    crop: "crop=518:200:250:420,pad=518:704:0:252:color=white",
    eyebrow: "MUTABLE BOT REPLIES",
    title: ["One reply,", "updated in place."],
    body: [
      "Status and text deltas become one",
      "durably delivered final answer.",
    ],
    accent: "#4f8cff",
  },
  {
    name: "04-card",
    duration: 4,
    capture: "05-card-visible.png",
    crop: "crop=518:310:250:510,pad=518:704:0:197:color=white",
    eyebrow: "HUMAN IN THE LOOP",
    title: ["Native decisions,", "inside WeCom."],
    body: [
      "Confirm, select, form, and cancel",
      "without prompt-shaped workarounds.",
    ],
    accent: "#8b5cff",
  },
  {
    name: "05-resume",
    duration: 4,
    capture: "07-card-resumed.png",
    crop: "crop=518:300:250:460,pad=518:704:0:202:color=white",
    eyebrow: "SAME SESSION · SAME TASK",
    title: ["One click resumes", "the Agent."],
    body: [
      "Scoped, durable, idempotent callbacks",
      "restore the original tool call.",
    ],
    accent: "#55d6a7",
  },
  {
    name: "06-proactive",
    duration: 4,
    capture: "09-proactive-media.png",
    crop: "crop=518:570:250:180,pad=518:704:0:67:color=white",
    eyebrow: "BIDIRECTIONAL DELIVERY",
    title: ["The Agent can", "reach back."],
    body: ["Proactive text and media reuse", "the same Bot, ACL, and Outbox."],
    accent: "#ffb44f",
  },
  {
    name: "07-outro",
    duration: 3,
    outro: true,
  },
];

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function dataUri(path) {
  return `data:image/png;base64,${readFileSync(path).toString("base64")}`;
}

function textLines(lines, x, y, size, lineHeight, attributes = "") {
  return `<text x="${x}" y="${y}" ${attributes}>${lines
    .map(
      (line, index) =>
        `<tspan x="${x}" dy="${index === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`,
    )
    .join("")}</text>`;
}

function chrome(footer = "REAL WECOM CLIENT · PRIVACY-CROPPED") {
  return `
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#050b18"/>
        <stop offset="0.55" stop-color="#071426"/>
        <stop offset="1" stop-color="#0b1730"/>
      </linearGradient>
      <radialGradient id="glow" cx="0.22" cy="0.22" r="0.75">
        <stop offset="0" stop-color="#194f8f" stop-opacity="0.44"/>
        <stop offset="1" stop-color="#071426" stop-opacity="0"/>
      </radialGradient>
      <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%">
        <feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#000714" flood-opacity="0.62"/>
      </filter>
      <clipPath id="chatClip"><rect x="766" y="42" width="474" height="636" rx="24"/></clipPath>
    </defs>
    <rect width="1280" height="720" fill="url(#bg)"/>
    <rect width="1280" height="720" fill="url(#glow)"/>
    <circle cx="70" cy="72" r="13" fill="#35d6ff"/>
    <path d="M91 72h64" stroke="#35d6ff" stroke-width="3" stroke-linecap="round" opacity="0.62"/>
    <text x="70" y="698" fill="#637995" font-family="Arial, sans-serif" font-size="15" letter-spacing="2">${escapeXml(footer)}</text>
  `;
}

function regularSlide(slide, imagePath) {
  const title = textLines(
    slide.title,
    70,
    248,
    55,
    66,
    'fill="#f6f9ff" font-family="Arial, sans-serif" font-size="55" font-weight="700" letter-spacing="-1.5"',
  );
  const body = textLines(
    slide.body,
    72,
    423,
    24,
    36,
    'fill="#aebfd5" font-family="Arial, sans-serif" font-size="24" font-weight="400"',
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="1280" viewBox="0 0 1280 1280">
    ${chrome()}
    <text x="72" y="154" fill="${slide.accent}" font-family="Arial, sans-serif" font-size="19" font-weight="700" letter-spacing="3">${escapeXml(slide.eyebrow)}</text>
    ${title}
    ${body}
    <rect x="754" y="30" width="498" height="660" rx="30" fill="#0b1730" stroke="#263f61" stroke-width="2" filter="url(#shadow)"/>
    <g clip-path="url(#chatClip)">
      <image href="${dataUri(imagePath)}" x="766" y="42" width="474" height="644" preserveAspectRatio="xMidYMid slice"/>
    </g>
    <rect x="766" y="42" width="474" height="636" rx="24" fill="none" stroke="#ffffff" stroke-opacity="0.18"/>
  </svg>`;
}

function introSlide() {
  const hero = dataUri(join(repoRoot, "docs/assets/social-preview.png"));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="1280" viewBox="0 0 1280 1280">
    ${chrome("26-SECOND REAL PRODUCT WALKTHROUGH · REAL CLIENT FOOTAGE")}
    <image href="${hero}" x="0" y="40" width="1280" height="640"/>
  </svg>`;
}

function outroSlide() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="1280" viewBox="0 0 1280 1280">
    ${chrome("OFFICIAL SDK · STABLE RUNTIME CONTRACT · DURABLE OUTBOX")}
    <text x="640" y="190" text-anchor="middle" fill="#35d6ff" font-family="Arial, sans-serif" font-size="20" font-weight="700" letter-spacing="4">WECOM AGENT GATEWAY</text>
    <text x="640" y="292" text-anchor="middle" fill="#f6f9ff" font-family="Arial, sans-serif" font-size="62" font-weight="700" letter-spacing="-2">One IM channel.</text>
    <text x="640" y="362" text-anchor="middle" fill="#f6f9ff" font-family="Arial, sans-serif" font-size="62" font-weight="700" letter-spacing="-2">Pluggable agent kernels.</text>
    <g transform="translate(210 452)">
      <rect width="250" height="74" rx="18" fill="#102039" stroke="#25436a"/>
      <text x="125" y="46" text-anchor="middle" fill="#bcd0e9" font-family="Arial, sans-serif" font-size="21">Reliable transport</text>
      <rect x="305" width="250" height="74" rx="18" fill="#102039" stroke="#25436a"/>
      <text x="430" y="46" text-anchor="middle" fill="#bcd0e9" font-family="Arial, sans-serif" font-size="21">Native interaction</text>
      <rect x="610" width="250" height="74" rx="18" fill="#102039" stroke="#25436a"/>
      <text x="735" y="46" text-anchor="middle" fill="#bcd0e9" font-family="Arial, sans-serif" font-size="21">Kernel-neutral</text>
    </g>
    <text x="640" y="626" text-anchor="middle" fill="#55d6a7" font-family="Arial, sans-serif" font-size="23" font-weight="700">github.com/fyaic/wecom-agent-gateway</text>
  </svg>`;
}

if (process.platform !== "darwin") {
  throw new Error(
    "Demo rendering currently requires macOS Quick Look (qlmanage).",
  );
}

mkdirSync(assetDir, { recursive: true });
rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });

for (const slide of slides) {
  let svg;
  if (slide.intro) {
    svg = introSlide();
  } else if (slide.outro) {
    svg = outroSlide();
  } else {
    const source = join(captureDir, slide.capture);
    if (!existsSync(source)) throw new Error(`Missing demo capture: ${source}`);
    const cropped = join(buildDir, `${slide.name}-capture.png`);
    run("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      source,
      "-vf",
      slide.crop ?? "crop=518:704:250:64",
      "-frames:v",
      "1",
      cropped,
    ]);
    svg = regularSlide(slide, cropped);
  }

  const svgPath = join(buildDir, `${slide.name}.svg`);
  writeFileSync(svgPath, svg);
  run("qlmanage", ["-t", "-s", "1280", "-o", buildDir, svgPath]);
  const rendered = `${svgPath}.png`;
  const pngPath = join(buildDir, `${slide.name}.png`);
  run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    rendered,
    "-vf",
    "crop=1280:720:0:0",
    "-frames:v",
    "1",
    pngPath,
  ]);

  const segment = join(buildDir, `${slide.name}.mp4`);
  run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-loop",
    "1",
    "-i",
    pngPath,
    "-t",
    String(slide.duration),
    "-vf",
    `fade=t=in:st=0:d=0.28,fade=t=out:st=${slide.duration - 0.28}:d=0.28`,
    "-r",
    "30",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    segment,
  ]);
}

const concatPath = join(buildDir, "concat.txt");
writeFileSync(
  concatPath,
  slides
    .map((slide) => `file '${join(buildDir, `${slide.name}.mp4`)}'`)
    .join("\n"),
);

const videoPath = join(assetDir, "wecom-agent-gateway-demo.mp4");
run("ffmpeg", [
  "-hide_banner",
  "-loglevel",
  "error",
  "-y",
  "-f",
  "concat",
  "-safe",
  "0",
  "-i",
  concatPath,
  "-c",
  "copy",
  "-movflags",
  "+faststart",
  videoPath,
]);

const coverPath = join(assetDir, "wecom-agent-gateway-demo-cover.png");
copyFileSync(join(buildDir, "01-intro.png"), coverPath);

const palettePath = join(buildDir, "palette.png");
run("ffmpeg", [
  "-hide_banner",
  "-loglevel",
  "error",
  "-y",
  "-i",
  videoPath,
  "-vf",
  "fps=7,scale=960:-2:flags=lanczos,palettegen=max_colors=112:stats_mode=diff",
  palettePath,
]);
run("ffmpeg", [
  "-hide_banner",
  "-loglevel",
  "error",
  "-y",
  "-i",
  videoPath,
  "-i",
  palettePath,
  "-lavfi",
  "fps=7,scale=960:-2:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle",
  "-loop",
  "0",
  join(assetDir, "wecom-agent-gateway-demo.gif"),
]);

console.log(`Created ${videoPath}`);
console.log(`Created ${coverPath}`);
console.log(`Created ${join(assetDir, "wecom-agent-gateway-demo.gif")}`);
