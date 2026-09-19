import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

const script = await readFile(new URL("../assets/reports.js", import.meta.url), "utf8");

function page(fetch, search = "") {
  const nodes = new Map();
  const stored = new Map();
  const node = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, {
      hidden: false, textContent: "", value: "", listeners: {}, children: [],
      classList: { add() {}, remove() {}, toggle() {} },
      parentElement: { classList: { add() {}, remove() {} } },
      addEventListener(event, listener) { this.listeners[event] = listener; },
      replaceChildren(...children) { this.children = children; },
      querySelectorAll() { return this.children; },
      setAttribute() {},
      append(...children) { this.children.push(...children); },
    });
    return nodes.get(selector);
  };
  node("#status").value = "new";
  node(".workspace").hidden = true;
  node(".toolbar").hidden = true;
  runInNewContext(script, {
    document: { querySelector: node, createElement: () => node(`created-${nodes.size}`) },
    sessionStorage: {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => stored.set(key, value),
      removeItem: (key) => stored.delete(key),
    },
    fetch,
    location: { search },
    URLSearchParams,
    matchMedia: () => ({ matches: false }),
    encodeURIComponent,
  });
  return { node, stored };
}

test("report page reveals no data before authentication and locks on a bad token", async () => {
  const calls = [];
  const { node, stored } = page(async (_url, options) => {
    calls.push(options);
    return { status: 404, ok: false };
  });
  assert.equal(calls.length, 0);
  assert.equal(node(".workspace").hidden, true);
  node("#token-input").value = "wrong-token";
  node("#auth-form").listeners.submit({ preventDefault() {} });
  await new Promise(setImmediate);
  assert.equal(calls[0].headers.authorization, "Bearer wrong-token");
  assert.equal(node(".workspace").hidden, true);
  assert.equal(node("#auth-form").hidden, false);
  assert.equal(stored.size, 0);
});

test("locking clears rendered diagnostics and ignores a late authorized response", async () => {
  let finishFetch;
  const { node, stored } = page(() => new Promise((resolve) => { finishFetch = resolve; }));
  node("#token-input").value = "valid-token";
  node("#auth-form").listeners.submit({ preventDefault() {} });
  node("#detail-log").textContent = "private diagnostic";
  node("#signout").listeners.click();
  assert.equal(node("#detail-log").textContent, "");
  assert.equal(node(".workspace").hidden, true);
  assert.equal(stored.size, 0);
  finishFetch({ status: 200, ok: true, json: async () => ({
    reports: [{ id: "old", status: "new", description: "private description" }],
  }) });
  await new Promise(setImmediate);
  assert.equal(node("#tickets").children.length, 0);
  assert.equal(node(".workspace").hidden, true);
});

test("sample tickets show every lifecycle state without touching the API or Keychain token", () => {
  let requests = 0;
  const { node, stored } = page(() => { requests += 1; throw new Error("demo must be local"); });
  node("#sample").listeners.click();
  assert.equal(node("#status").value, "all");
  assert.equal(node("#sample-banner").hidden, false);
  assert.equal(node("#sample-indicator").hidden, false);
  assert.equal(node("#tickets").children.length, 6);
  assert.equal(node("#notice").textContent, "6 sample tickets");
  assert.equal(stored.size, 0);

  node("#tickets").children[0].listeners.click();
  assert.match(node("#detail-log").textContent, /\[sample\]/);
  assert.match(node("#detail-title").textContent, /shared game link/);

  node("#status").value = "in_progress";
  node("#status").listeners.change();
  assert.equal(node("#tickets").children.length, 1);
  node("#status").value = "fixed";
  node("#status").listeners.change();
  assert.equal(node("#tickets").children.length, 2);
  node("#exit-sample").listeners.click();
  assert.equal(node(".workspace").hidden, true);
  assert.equal(node("#detail-log").textContent, "");
  assert.equal(node("#sample-banner").hidden, true);
  assert.equal(requests, 0);
});

test("the sample URL opens the filled preview without a token or API request", () => {
  let requests = 0;
  const { node, stored } = page(() => { requests += 1; }, "?sample=1");
  assert.equal(node("#tickets").children.length, 6);
  assert.equal(node("#auth-form").hidden, true);
  assert.equal(node("#sample-banner").hidden, false);
  assert.equal(stored.size, 0);
  assert.equal(requests, 0);
});
