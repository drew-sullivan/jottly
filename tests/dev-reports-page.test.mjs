import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

const script = await readFile(new URL("../assets/reports.js", import.meta.url), "utf8");

function page(fetch, search = "") {
  const nodes = new Map();
  const stored = new Map();
  let nextCreated = 0;
  const makeNode = () => ({
    hidden: false, textContent: "", value: "", listeners: {}, children: [], dataset: {}, disabled: false,
    classList: { add() {}, remove() {}, toggle() {} },
    parentElement: { classList: { add() {}, remove() {} } },
    nextElementSibling: null,
    addEventListener(event, listener) { this.listeners[event] = listener; },
    replaceChildren(...children) { this.children = children; linkSiblings(this); },
    querySelector(selector) { return this.children.find((child) => selector === ".diagnostic-row" && child.className === "diagnostic-row") ?? null; },
    querySelectorAll(selector) { return descendants(this).filter((child) => selector === ".diagnostic-toggle" ? child.className === "diagnostic-toggle" : true); },
    setAttribute(name, value) { this[name] = value; },
    append(...children) { this.children.push(...children); linkSiblings(this); },
    after(child) {
      for (const parent of nodes.values()) {
        const index = parent.children.indexOf(this);
        if (index >= 0) { parent.children.splice(index + 1, 0, child); linkSiblings(parent); return; }
      }
    },
    remove() {
      for (const parent of nodes.values()) {
        const index = parent.children.indexOf(this);
        if (index >= 0) { parent.children.splice(index, 1); linkSiblings(parent); return; }
      }
    },
  });
  const node = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, {
      ...makeNode(),
    });
    return nodes.get(selector);
  };
  node("#status").value = "new";
  node(".workspace").hidden = true;
  node(".toolbar").hidden = true;
  runInNewContext(script, {
    document: { querySelector: node, createElement: () => node(`created-${nextCreated++}`) },
    sessionStorage: {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => stored.set(key, value),
      removeItem: (key) => stored.delete(key),
    },
    fetch,
    location: { search },
    URLSearchParams,
    encodeURIComponent,
  });
  return { node, stored };
}

function descendants(parent) {
  return parent.children.flatMap((child) => [child, ...descendants(child)]);
}

function linkSiblings(parent) {
  parent.children.forEach((child, index) => { child.nextElementSibling = parent.children[index + 1] ?? null; });
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
  node("#signout").listeners.click();
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

  const firstRow = node("#tickets").children[0];
  assert.equal(firstRow.children[1].textContent, "A shared game link opened the wrong rule sheet");
  const viewButton = firstRow.children[3].children[0];
  viewButton.listeners.click();
  assert.equal(node("#tickets").children.length, 7);
  assert.match(node("#tickets").children[1].children[0].children[0].textContent, /\[sample\]/);
  assert.equal(viewButton.textContent, "Hide");

  node("#status").value = "in_progress";
  node("#status").listeners.change();
  assert.equal(node("#tickets").children.length, 1);
  node("#status").value = "fixed";
  node("#status").listeners.change();
  assert.equal(node("#tickets").children.length, 2);
  node("#exit-sample").listeners.click();
  assert.equal(node(".workspace").hidden, true);
  assert.equal(node("#sample-banner").hidden, true);
  assert.equal(requests, 0);
});

test("reports render as simple newest-first rows with fixed diagnostics cleared", async () => {
  const { node } = page(async () => ({ status: 200, ok: true, json: async () => ({ reports: [
    { id: "newest", status: "new", description: "Newest report" },
    { id: "older", status: "fixed", description: "Older report" },
  ] }) }));
  node("#token-input").value = "valid-token";
  node("#auth-form").listeners.submit({ preventDefault() {} });
  await new Promise(setImmediate);
  const [newest, older] = node("#tickets").children;
  assert.deepEqual(newest.children.map((cell) => cell.textContent), ["newest", "Newest report", "", ""]);
  assert.equal(newest.children[2].children[0].textContent, "new");
  assert.equal(newest.children[3].children[0].textContent, "View");
  assert.equal(older.children[0].textContent, "older");
  assert.equal(older.children[3].children[0].textContent, "Cleared");
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
