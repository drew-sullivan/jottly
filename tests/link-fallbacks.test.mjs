import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

async function scripts(page) {
  const html = await readFile(new URL(`../${page}.html`, import.meta.url), "utf8");
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
}

test("join fallback preserves every link purpose without turning a package into a match", async () => {
  const script = (await scripts("invite")).at(-1);
  for (const [search, expected] of [
    ["?env=production&v=2", "jotto://join/match-123?env=production&v=2"],
    ["?env=production&v=2&intent=shareGame", "jotto://join/match-123?env=production&v=2&intent=shareGame"],
    ["?env=production&v=2&intent=challengeAgain", "jotto://join/match-123?env=production&v=2&intent=challengeAgain"],
    ["?env=production&v=2&intent=viewGame", "jotto://join/match-123?env=production&v=2&intent=viewGame"],
    ["?env=development&v=2&intent=shareGame", "jotto://join/match-123?env=development&v=2&intent=shareGame"],
    ["?intent=future", "jotto://join/match-123?intent=future"],
    ["?intent=join&intent=shareGame", "jotto://join/match-123?intent=join&intent=shareGame"],
    ["?intent", "jotto://join/match-123?intent"],
    ["?INTENT=shareGame", "jotto://join/match-123?INTENT=shareGame"],
    ["?intent=future&unexpected=1", "jotto://join/match-123?intent=future&unexpected=1"],
  ]) {
    const openApp = { href: "" };
    const context = {
      URLSearchParams,
      encodeURIComponent,
      location: { origin: "https://icedmatchalabs.com", pathname: "/join/match-123", search },
      document: { getElementById: (id) => id === "openapp" ? openApp : null },
      navigator: {},
    };
    runInNewContext(script, context);
    assert.equal(openApp.href, expected, search);
  }
});

for (const page of ["solo", "daily"]) {
  test(`${page} fallback preserves every selected mode in the banner and Open action`, async () => {
    const script = (await scripts(page))[0];
    for (const mode of [
      "lightningSolitaire6V1", "cowpokeSolitaire11V1",
      "jottlySolitaire14V1", "shapeshifterSolitaire8V2",
    ]) {
      const search = `?ruleset=${mode}`;
      const meta = { content: "" };
      const link = { href: "" };
      let onReady;
      const context = {
        URLSearchParams, encodeURIComponent,
        location: { search },
        window: { location: { search }, addEventListener: (_, callback) => { onReady = callback; } },
        document: {
          querySelector: () => meta,
          getElementById: () => link,
        },
      };
      runInNewContext(script, context);
      assert.equal(meta.content, `app-id=6780044797, app-argument=https://icedmatchalabs.com/${page}${search}`);
      assert.equal(typeof onReady, "function");
      onReady();
      assert.equal(link.href, `jotto://${page}${search}`);
    }
  });
}
