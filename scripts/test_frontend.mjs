// Frontend editing-logic tests. Run:  node scripts/test_frontend.mjs
// Loads web/app.js under a minimal DOM stub and drives the internals that
// scripts can reach (split / merge / speed / copy-paste / undo / save-load
// sanitization). Pure logic only — playback and pywebview calls are inert.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

let pass = 0;
let fail = 0;
function check(name, condition, detail = "") {
  if (condition) { pass += 1; console.log(`  ok  ${name}`); }
  else { fail += 1; console.log(`FAIL  ${name}  ${detail}`); }
}

// ---- minimal DOM stub ----
function makeEl() {
  const el = {
    style: {},
    dataset: {},
    children: [],
    innerHTML: "",
    textContent: "",
    value: "",
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    removeAttribute() {},
    focus() {},
    select() {},
    load() {},
    pause() {},
    play() { return { catch() {} }; },
    closest() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; },
  };
  return el;
}

const elements = {};
const docListeners = {};
let storage = {};

globalThis.document = {
  addEventListener(type, fn) { (docListeners[type] ||= []).push(fn); },
  removeEventListener() {},
  getElementById(id) { return (elements[id] ||= makeEl()); },
  activeElement: null,
};
globalThis.window = {
  __OD_TEST__: true,
  innerWidth: 1600,
  innerHeight: 900,
  addEventListener() {},
};
globalThis.localStorage = {
  getItem(key) { return key in storage ? storage[key] : null; },
  setItem(key, value) { storage[key] = String(value); },
  removeItem(key) { delete storage[key]; },
};
globalThis.performance = { now: () => Date.now() };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

const here = dirname(fileURLToPath(import.meta.url));
await import(pathToFileURL(join(here, "..", "web", "app.js")).href);

const t = globalThis.window.__odTest;
check("test hook exposed", !!t);
t.init(); // cacheElements + bindEvents + first render against the stub DOM

function freshState(clips = []) {
  const s = t.defaults();
  s.tracks[0].clips = clips.map((clip) => ({ sourceIn: 0, speed: 1, ...clip }));
  t.setState(s);
  t.normalizeTotal();
  return s;
}

// ---- defaults ----
{
  const d = t.defaults();
  check("defaults: 4 tracks (2V/1A/1S)",
    d.tracks.length === 4 &&
    d.tracks.filter((x) => x.type === "video").length === 2 &&
    d.tracks.some((x) => x.type === "audio") && d.tracks.some((x) => x.type === "subtitle"));
  check("defaults: projectPath null + auto-gpu", d.projectPath === null && d.encoder === "auto-gpu");
}

// ---- loadState sanitization ----
{
  storage = {};
  const saved = t.defaults();
  saved.tracks[0].clips = [{
    id: "c1", start: 0, duration: 5, source: "C:/media/a.mp4",
    url: "http://127.0.0.1:1/media/x/a.mp4", fileUrl: "file:///a.mp4",
    proxyUrl: "http://dead", proxyPath: "x", proxyState: "done", proxyTried: true,
  }];
  saved.projectPath = "C:/proj/p.odproj";
  storage["opendirector.project.v1"] = JSON.stringify(saved);
  const loaded = t.loadState();
  const clip = loaded.tracks[0].clips[0];
  check("loadState strips per-run fields",
    !("url" in clip) && !("fileUrl" in clip) && !("proxyUrl" in clip) &&
    !("proxyState" in clip) && !("proxyTried" in clip) && clip.source === "C:/media/a.mp4",
    JSON.stringify(clip));
  check("loadState keeps projectPath", loaded.projectPath === "C:/proj/p.odproj");
  check("loadState resets session fields", loaded.selectedId === null && loaded.history.length === 0 && loaded.isPlaying === false);
  storage = {};
}

// ---- addMediaClip ----
{
  freshState();
  t.addMediaClip({ kind: "video", path: "C:/m/v.mp4", url: "http://x", name: "v.mp4", duration: 8, width: 1280, height: 720, fps: 29.97, hasAudio: true });
  const s = t.getState();
  const clip = s.tracks[0].clips[0];
  check("addMediaClip lands on video track", s.tracks[0].clips.length === 1 && clip.source === "C:/m/v.mp4");
  check("addMediaClip adopts source dims/fps", s.width === 1280 && s.height === 720 && Math.abs(s.fps - 29.97) < 0.001);
  check("addMediaClip strips extension for label", clip.label === "v");
  t.addMediaClip({ kind: "audio", path: "C:/m/a.mp3", url: "http://y", name: "a.mp3", duration: 4, hasAudio: true });
  const audioTrack = t.getState().tracks.find((x) => x.type === "audio");
  check("audio media lands on audio track", audioTrack.clips.length === 1);
}

// ---- split ----
{
  freshState([{ id: "c1", start: 0, duration: 10, label: "clip", sourceDuration: 10 }]);
  t.splitAt("c1", 4);
  const clips = t.getState().tracks[0].clips.slice().sort((a, b) => a.start - b.start);
  check("split produces 2 clips", clips.length === 2);
  check("split durations 4 + 6", Math.abs(clips[0].duration - 4) < 1e-9 && Math.abs(clips[1].duration - 6) < 1e-9,
    JSON.stringify(clips.map((c) => c.duration)));
  check("split second sourceIn = 4", Math.abs(clips[1].sourceIn - 4) < 1e-9, String(clips[1].sourceIn));

  // split at 2x speed: sourceIn advances at 2x
  freshState([{ id: "c2", start: 0, duration: 10, speed: 2, sourceIn: 1 }]);
  t.splitAt("c2", 3);
  const fast = t.getState().tracks[0].clips.slice().sort((a, b) => a.start - b.start);
  check("split at 2x maps sourceIn (1 + 3*2 = 7)", Math.abs(fast[1].sourceIn - 7) < 1e-9, String(fast[1].sourceIn));

  // guard: too close to the edge is a no-op
  freshState([{ id: "c3", start: 0, duration: 1 }]);
  t.splitAt("c3", 0.1);
  check("split near edge is a no-op", t.getState().tracks[0].clips.length === 1);
}

// ---- merge ----
{
  const s = freshState([
    { id: "a", start: 0, duration: 3, label: "A" },
    { id: "b", start: 3, duration: 2, label: "B" },
  ]);
  s.selectedId = "a";
  t.doMerge();
  const merged = t.getState().tracks[0].clips[0];
  check("merge spans both clips", t.getState().tracks[0].clips.length === 1 && merged.start === 0 && merged.duration === 5,
    JSON.stringify(merged));
  check("merge keeps selection on result", t.getState().selectedId === merged.id);
}

// ---- speed + normalizeTotal ----
{
  const s = freshState([{ id: "c1", start: 0, duration: 8, sourceDuration: 8 }]);
  check("total follows content", t.getState().total === 8, String(t.getState().total));
  t.setSpeed("c1", 2);
  const clip = t.findClip("c1").clip;
  check("2x speed halves duration", Math.abs(clip.duration - 4) < 1e-9, String(clip.duration));
  check("total shrinks after speed-up", t.getState().total === 4, String(t.getState().total));
  t.setSpeed("c1", 1);
  check("back to 1x restores duration", Math.abs(t.findClip("c1").clip.duration - 8) < 1e-9);
}

// ---- copy / paste ----
{
  const s = freshState([{ id: "c1", start: 0, duration: 2, label: "src", source: "C:/m/v.mp4" }]);
  s.selectedId = "c1";
  t.doCopy();
  s.playhead = 5;
  t.doPaste();
  const clips = t.getState().tracks[0].clips;
  check("paste adds a clip at playhead", clips.length === 2 && clips.some((c) => c.start === 5), JSON.stringify(clips.map((c) => c.start)));
  const pasted = clips.find((c) => c.start === 5);
  check("paste mints a new id", pasted.id !== "c1");
  check("total grows to cover paste", t.getState().total >= 7, String(t.getState().total));
}

// ---- delete + undo ----
{
  const s = freshState([{ id: "c1", start: 0, duration: 6, label: "gone" }]);
  s.selectedId = "c1";
  t.doDelete();
  check("delete removes the clip", t.getState().tracks[0].clips.length === 0);
  check("delete shrinks total to default", t.getState().total === t.defaults().total, String(t.getState().total));
  t.undo();
  check("undo restores the clip", t.getState().tracks[0].clips.length === 1 && t.getState().tracks[0].clips[0].id === "c1");
}

// ---- subtitle ----
{
  freshState();
  const subTrack = t.getState().tracks.find((x) => x.type === "subtitle");
  t.addSubtitle(subTrack.id, 2.34);
  const sub = subTrack.clips[0];
  check("addSubtitle creates 3s clip at rounded time", subTrack.clips.length === 1 && sub.start === 2.3 && sub.duration === 3,
    JSON.stringify(sub));
  check("addSubtitle opens the editor", t.getState().editing && t.getState().editing.id === sub.id);
}

// ---- snap ----
{
  const s = freshState([
    { id: "c1", start: 0, duration: 4 },
    { id: "c2", start: 10, duration: 2 },
  ]);
  s.pxPerSec = 18;
  const snapped = t.snap(4.2, "c2", 2); // 7/18 ≈ 0.39s threshold, 4.2 is near c1's end (4)
  check("snap pulls to neighbour edge", snapped === 4, String(snapped));
  const free = t.snap(7.0, "c2", 2);
  check("no snap when far from edges", Math.abs(free - 7.0) < 0.11, String(free));
}

// ---- save payload / load apply ----
{
  const s = freshState([{
    id: "c1", start: 0, duration: 2, source: "C:/m/v.mp4",
    url: "http://127.0.0.1:1/x", proxyState: "done",
  }]);
  s.name = "My Cut";
  const payload = t.projectPayload();
  check("projectPayload carries editing state", payload.name === "My Cut" && payload.tracks.length === 4 && !("history" in payload) && !("clipboard" in payload));

  t.applyLoadedProject({
    name: "Loaded", width: 640, height: 360, fps: 24, total: 12, playhead: 99,
    tracks: [{ id: "v1", type: "video", name: "V", clips: [{ id: "c9", start: 0, duration: 12, source: "C:/m/z.mp4", url: "http://stale", proxyTried: true }] }],
  }, "C:/proj/loaded.odproj");
  const ns = t.getState();
  check("applyLoadedProject replaces state", ns.name === "Loaded" && ns.width === 640 && ns.projectPath === "C:/proj/loaded.odproj");
  check("applyLoadedProject clamps playhead", ns.playhead <= ns.total, String(ns.playhead));
  const loadedClip = ns.tracks[0].clips[0];
  check("applyLoadedProject strips stale urls", !("url" in loadedClip) && !("proxyTried" in loadedClip), JSON.stringify(loadedClip));
  check("applyLoadedProject resets history/clipboard", ns.history.length === 0 && ns.clipboard === null);
}

// ---- formatting helpers ----
{
  freshState();
  t.getState().fps = 30;
  check("tc formats mm:ss:ff", t.tc(65.5) === "01:05:15", t.tc(65.5));
  check("rl formats m:ss", t.rl(125) === "2:05", t.rl(125));
  check("fileStem handles windows path", t.fileStem("C:\\proj\\我的專案.odproj") === "我的專案", t.fileStem("C:\\proj\\我的專案.odproj"));
  check("fileStem handles posix path", t.fileStem("/tmp/cut.v2.odproj") === "cut.v2", t.fileStem("/tmp/cut.v2.odproj"));
  check("stripExtension", t.stripExtension("clip.final.mp4") === "clip.final");
  const hue = t.hueFromName("anything.mp4");
  check("hueFromName in palette range", hue >= 205 && hue < 285, String(hue));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
