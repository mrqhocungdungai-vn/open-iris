import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { guidePage, permitted, RUNNABLE } from "./guard.mjs";

const root = "/Applications/open-iris.app/Contents/Resources/app";
const url = (p) => pathToFileURL(root + p).href;

test("only the bundled guides may open or be navigated to", () => {
  assert.ok(guidePage(url("/src/gesture/guide.html"), root));
  assert.ok(guidePage(url("/src/gesture/gallery-guide.html") + "?lang=en", root));
  assert.ok(!guidePage(url("/src/gesture/chat.html"), root)); // an app page, but not a guide
  assert.ok(!guidePage("file:///Users/me/Downloads/evil-guide.html", root)); // a dropped file
  assert.ok(!guidePage(url("/src/gesture/../../../evil/guide.html"), root));
  assert.ok(!guidePage("https://example.com/src/gesture/guide.html", root));
  assert.ok(!guidePage("not a url", root));
});

test("only mic, camera and clipboard read, only for the app's own pages", () => {
  assert.ok(permitted("media", url("/src/renderer/index.html"), root));
  assert.ok(permitted("clipboard-read", url("/src/gesture/chat.html"), root));
  assert.ok(!permitted("geolocation", url("/src/renderer/index.html"), root));
  assert.ok(!permitted("media", "file:///Users/me/Downloads/evil.html", root));
  assert.ok(!permitted("media", pathToFileURL(root + "-evil/x.html").href, root)); // sibling folder with the same prefix
  assert.ok(!permitted("media", "https://example.com/", root));
  assert.ok(!permitted("media", undefined, root));
});

test("the gallery refuses runnable files and Finder links", () => {
  for (const f of ["/a/run.command", "/a/x.SH", "/a/go.fileloc", "/a/site.inetloc"]) assert.ok(RUNNABLE.test(f), f);
  for (const f of ["/a/photo.jpg", "/a/notes.txt", "/a/report.pdf"]) assert.ok(!RUNNABLE.test(f), f);
});
