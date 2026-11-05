// Sign-in links (Cloud.link_ask): an address has at most 3 unused at once
// (a ticket used up leaves the count) and a network (Cloud.net) 100 a
// day, used or not, so /api/login can't mail a victim links or drain the
// mail quota.

import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";

process.env.UNII_DIR = fs.mkdtempSync("/tmp/cloud-test-");
process.env.UNII_SITE = "http://127.0.0.1";
const { Cloud } = await import("./cloud.ts");

// accounts in a dir made anew; the last test's goes after all
function cloud_new() {
  fs.rmSync(process.env.UNII_DIR ?? "", { recursive: true, force: true });
  fs.mkdirSync(process.env.UNII_DIR ?? "", { recursive: true });
  return Cloud.open(() => {}, () => {}, async () => null);
}

afterAll(() => fs.rmSync(process.env.UNII_DIR ?? "", { recursive: true, force: true }));

test("Cloud.net: IPv4 whole, IPv6 by its /48", () => {
  expect(Cloud.net("1.2.3.4")).toBe("1.2.3.4");
  expect(Cloud.net("::ffff:1.2.3.4")).toBe("1.2.3.4");
  expect(Cloud.net("2001:db8:0:1:aaaa::5")).toBe("2001:db8:0::/48");
  expect(Cloud.net("2001:DB8::1")).toBe("2001:db8:0::/48");
});

test("link_ask caps links by address at once and by network a day", () => {
  const cloud = cloud_new();
  const ask = (who: string, net: string) => Cloud.link_ask(cloud, who, net) ?? Cloud.ticket(cloud, { who, session: null }, 60000);
  const first = ask("a@x.com", "1.1.1.1");
  ask("a@x.com", "1.1.1.1");
  ask("a@x.com", "1.1.1.1");
  expect(Cloud.link_ask(cloud, "a@x.com", "2.2.2.2")).toContain("15 minutes");
  Cloud.ticket_read(cloud, first, true);
  expect(Cloud.link_ask(cloud, "a@x.com", "3.3.3.3")).toBeNull();
  for (let k = 0; k < 97; k++) {
    ask("b" + k + "@x.com", "1.1.1.1");
  }
  expect(Cloud.link_ask(cloud, "c@x.com", "1.1.1.1")).toContain("tomorrow");
  expect(Cloud.link_ask(cloud, "c@x.com", "2.2.2.2")).toBeNull();
  cloud.db.query("update asks set at = at - 864e5").run();
  expect(Cloud.link_ask(cloud, "c@x.com", "1.1.1.1")).toBeNull();
  // no address (a self-host, no proxy): one network, counted
  expect(Cloud.link_ask(cloud, "d@x.com", Cloud.net(""))).toBeNull();
});

test("Cloud.address", () => {
  expect(Cloud.address("@OCTOCAT on gh", true)).toBe("@octocat");
  expect(Cloud.address("o'neil@x.com, not @octocat.", false)).toBe("o'neil@x.com");
});

// A terminal sign-in signs in only when the code the terminal shows is
// typed on the page its link opens (the email's, or GitHub's, which
// brings its code): opening the link makes no session, nor
// does a wrong code; the right one does. So opening an unrequested link,
// or one an attacker forwarded, grants nothing.
test("terminal sign-in needs the code the terminal shows", async () => {
  const cloud = cloud_new();
  const key = Cloud.random();
  const session = Cloud.hash(key);
  const t = Cloud.ticket(cloud, { who: "t@x.com", session }, 60000);
  const code = Cloud.code(session);
  expect(code).toMatch(/^\d{6}$/);
  const post = (c: string) => new Request("http://127.0.0.1/auth", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ t, code: c }).toString() });
  const signed = () => cloud.db.query("select hash from sessions where hash = ?").get(session);
  const gh = Cloud.ticket(cloud, { who: "@x", session }, 60000);
  for (const link of [t, gh]) {
    const page = await Cloud.http(cloud, new Request("http://127.0.0.1/auth?t=" + link + "&code=" + "a".repeat(64)));
    expect(await page?.text()).toContain("Enter the code");
  }
  expect(signed()).toBeNull();
  await Cloud.confirm(cloud, post(code === "000000" ? "111111" : "000000"));
  expect(signed()).toBeNull();
  await Cloud.confirm(cloud, post(code));
  expect(signed()).not.toBeNull();
});

// An emailed link signs in each time it is opened until it expires: a
// mail app's preview opening it first must not use it up.
test("an emailed link survives its preview", async () => {
  const cloud = cloud_new();
  const t = Cloud.ticket(cloud, { who: "p@x.com", session: null }, 60000);
  const open = async () => (await Cloud.http(cloud, new Request("http://127.0.0.1/auth?t=" + t)))?.headers.get("set-cookie") ?? "";
  expect(await open()).toContain("=");
  expect(await open()).toContain("=");
});
