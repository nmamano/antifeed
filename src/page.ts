// The page: one HTML document with the stylesheet and the client script inlined.
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("./page.css", import.meta.url), "utf8");
const js = readFileSync(new URL("./client.js", import.meta.url), "utf8");
// The tab's icon (a bold gradient A on deep indigo, 2026-10-28) and its 180 px
// copy for an iPhone home screen (made by tools/apple-icon.cjs).
export const icon = readFileSync(new URL("./icon.svg", import.meta.url), "utf8");
export const appleIcon = readFileSync(new URL("./apple-touch-icon.png", import.meta.url));

export const pageHtml = (view: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Antifeed</title>
<link rel="icon" type="image/svg+xml" href="/icon.svg?v=3">
<link rel="apple-touch-icon" href="/apple-touch-icon.png?v=3">
<style>
${css}</style>
</head>
<body>
<header>
  <div class="brand"><h1>Antifeed</h1><span id="chatlink" class="chatlink"></span><span id="newbtn" class="newbtn"></span><div id="hdrdock" class="hdrdock"></div></div>
  <nav id="tabs"></nav>
</header>
<main>
  <section id="tab-queue" class="tab"></section>
  <section id="tab-decided" class="tab" hidden></section>
  <section id="tab-accuracy" class="tab" hidden></section>
  <section id="tab-policies" class="tab" hidden></section>
  <section id="tab-setup" class="tab" hidden></section>
  <section id="tab-sources" class="tab" hidden></section>
  <section id="tab-status" class="tab" hidden></section>
  <section id="tab-help" class="tab" hidden></section>
</main>
<div id="toast" class="toast" hidden></div>
<div id="keys" class="keys" hidden></div>
<div id="lb" class="lb" hidden></div>
<section id="newpanel" class="newpanel" hidden aria-label="New: your words become a task"></section>
<script>window.AF_VIEW = ${view.replace(/</g, "\\u003c")};</script>
<script>
${js}</script>
</body>
</html>`;
