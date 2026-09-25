import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const publicPages = [
  "index",
  "invite",
  "solo",
  "daily",
  "strategy",
  "support",
  "privacy",
];

const pages = Object.fromEntries(await Promise.all(
  publicPages.map(async (page) => [
    page,
    await readFile(new URL(`../${page}.html`, import.meta.url), "utf8"),
  ]),
));

test("home positions Jottly as a play, build, and share platform", () => {
  const home = pages.index;
  assert.match(home, /<h1>Play\. Build\. Share\.<\/h1>/);
  assert.match(home, /word and letter-deduction games/);
  assert.match(home, /<p class="kicker">Play<\/p>/);
  assert.match(home, /<p class="kicker">Build<\/p>/);
  assert.match(home, /<p class="kicker">Share<\/p>/);
  assert.match(home, /millions of possible games/);
  assert.match(home, /Popular &amp; Featured/);
  assert.match(home, /Play solo whenever you have a minute/);
  assert.match(home, /challenge a friend on your own schedule/);
  assert.doesNotMatch(home, /portable game definitions|link carries the rules and presentation/);
});

test("home explains the built-in lineup and current Remix workflow", () => {
  const home = pages.index;
  for (const game of ["Lightning", "Cowpoke", "Classic", "Shapeshifter", "Mastered Mind"]) {
    assert.match(home, new RegExp(`<h3>${game}</h3>`));
  }
  for (const glyph of ["lightning", "cow", "shapeshifter", "brain"]) {
    assert.match(home, new RegExp(`src="/assets/glyph_${glyph}\\.png"`));
  }
  assert.match(home, /class="game-glyph classic"[^>]*>C<\/span>/);
  assert.match(home, /Remix a template/);
  assert.match(home, /Playtest instantly/);
  assert.match(home, /Own your collection/);
});

test("solo, invitation, and recommendation fallbacks describe their current destinations", () => {
  assert.match(pages.solo, /Pick a game\. Play solo\./);
  assert.match(pages.solo, /Jottly Favorites/);
  assert.match(pages.solo, /Community/);
  assert.match(pages.solo, /Your Games/);

  assert.match(pages.invite, /start playing with your friend/);
  assert.match(pages.invite, /play it solo, save it for later, share it, or make it your own/);

  assert.match(pages.daily, /Today's JotBot recommendation\./);
  assert.match(pages.daily, /Jottly Favorites and the community/);
  assert.match(pages.daily, /Play today's recommendation/);
});

test("support documents the current play, creation, sharing, and management flows", () => {
  const support = pages.support;
  assert.match(support, /Every game opens with its own rules sheet/);
  assert.match(support, /How do I build a game\?/);
  assert.match(support, /Can I share a game without starting a match\?/);
  assert.match(support, /How do I save a game someone shared\?/);
  assert.match(support, /How do I edit or delete one of my games\?/);
});

test("strategy teaches each clue language instead of one fixed ruleset", () => {
  const strategy = pages.strategy;
  for (const game of ["Lightning", "Cowpoke", "Classic", "Shapeshifter", "Custom games"]) {
    assert.match(strategy, new RegExp(`<p class="kicker">${game}</p>`));
  }
  assert.match(strategy, /title alone is never the contract/);
  assert.match(strategy, /Change one thing, then play it/);
});

test("privacy covers portable packages and reviewed community games", () => {
  const privacy = pages.privacy;
  assert.match(privacy, /word and letter-deduction game platform/);
  assert.match(privacy, /<strong>Game packages:<\/strong>/);
  assert.match(privacy, /<h2>Community games<\/h2>/);
  assert.match(privacy, /not match records, secret words, guesses, opponent information, or\s+player identifiers/);
});

test("public product pages do not advertise retired features", () => {
  const retired = [
    /daily challenge/i,
    /JotBot Daily/i,
    /guided (?:first )?game/i,
    /race the bot/i,
    /side-by-side/i,
    /reaction for every move/i,
    /same secret word (?:for everyone|each day)/i,
    /Play JotBot/i,
    /Settings[^<]{0,30}How to play/i,
  ];

  for (const [page, html] of Object.entries(pages)) {
    for (const phrase of retired) {
      assert.doesNotMatch(html, phrase, `${page}.html still advertises ${phrase}`);
    }
  }
});


test("privacy separates optional usage counters from complete custom-game contributions", () => {
  const text = pages.privacy.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  assert.match(text, /Both optional sharing settings start off/);
  assert.match(text, /choose each independently/);
  assert.match(text, /Contribute favorite custom games/);
  assert.match(text, /complete reusable game package/);
  assert.match(text, /title, description, icon choice, rules, creator attribution, package identifiers/);
  assert.match(text, /private review/);
  assert.match(text, /does not include the match's secret words, guesses, or game history/);
  assert.doesNotMatch(text, /only personal detail ever shared/);
});

test("privacy covers reports, dictation and the actual limits of local deletion", () => {
  const text = pages.privacy.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  assert.match(text, /in-app report/);
  assert.match(text, /recent diagnostic logs/);
  assert.match(text, /automatically send a sanitized error report/);
  assert.match(text, /separate from the two optional sharing settings/);
  assert.match(text, /Microphone and Speech Recognition/);
  assert.match(text, /may process audio using its speech-recognition services/);
  assert.match(text, /does not delete data already received/);
  assert.match(text, /does not delete another player's copy or all CloudKit records/);
  assert.match(text, /Unsent anonymous usage aggregates expire locally after 35 days/);
  assert.doesNotMatch(text, /Game data stays until you delete a game in the app or remove the app/);
});

test("internal work records are excluded from both static publication surfaces", async () => {
  const ignored = await readFile(new URL("../.assetsignore", import.meta.url), "utf8");
  assert.ok(ignored.split(/\r?\n/).includes("docs"), "Cloudflare must exclude internal request/review records");
  assert.ok(ignored.split(/\r?\n/).includes("_config.yml"), "GitHub Pages publishing configuration is not a public Cloudflare asset");
  const pagesConfig = await readFile(new URL("../_config.yml", import.meta.url), "utf8");
  assert.match(pagesConfig, /^exclude:\s*\n(?:[ \t]+-[^\n]*\n)*[ \t]+- docs[ \t]*(?:\r?\n|$)/m, "GitHub Pages must exclude the complete docs directory");
  assert.doesNotMatch(pagesConfig, /^include:/m, "Do not override the internal-directory exclusion with explicit includes");
});
