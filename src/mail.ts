// Mail
// ====
// The sign-in mail, through Resend's batch endpoint: one sender per server
// (with workers, the supervisor's) sends the queue, BATCH a request, one
// request at a time (its 429 says when to come back). A batch refused as
// invalid goes again in halves, so a bad address fails only itself.

// Types
// =====

// a mail queued, and its answer
type Wait = { mail: object; done: (err: string | null) => void };

// Constants
// =========

const URL   = "https://api.resend.com/emails/batch";
const BATCH = 100;

// how long Resend may take to answer a request (ms): the queue waits on
// it, so a hung one never holds every sign-in for fetch's minutes
const ANSWER = 30 * 1000;

// Globals
// =======

// the mails queued; whether the sender runs
const QUEUE: Wait[] = [];
let RUN = false;

// Mail
// ====

export namespace Mail {

  export function send(key: string, mail: object): Promise<string | null> {
    const done = new Promise<string | null>((done) => QUEUE.push({ mail, done }));
    if (!RUN) {
      Mail.run(key);
    }
    return done;
  }

  // the sender, run once while the queue has mail, detached (Mail.send):
  // a throw (never from post, which answers its batch) is logged, and
  // RUN clears whatever happened, so the next send starts it again
  export async function run(key: string): Promise<void> {
    RUN = true;
    try {
      while (QUEUE.length > 0) {
        await Mail.post(key, QUEUE.splice(0, BATCH));
      }
    } catch (err: any) {
      console.error("mail: " + (err?.message ?? err));
    } finally {
      RUN = false;
    }
  }

  // one request; its batch is always answered (so no send hangs), even
  // should the request throw
  export async function post(key: string, batch: Wait[]): Promise<void> {
    try {
      await Mail.sent(key, batch);
    } catch (err: any) {
      batch.forEach((wait) => wait.done("mail: " + (err?.message ?? err)));
    }
  }

  export async function sent(key: string, batch: Wait[]): Promise<void> {
    const headers = { authorization: "Bearer " + key, "content-type": "application/json" };
    const body = JSON.stringify(batch.map((wait) => wait.mail));
    const res = await fetch(URL, { method: "POST", headers, body, signal: AbortSignal.timeout(ANSWER) }).catch(() => null);
    const out = (await res?.json().catch(() => null)) ?? {};
    const wait = Number(res?.headers.get("retry-after") ?? "1");
    if (out.name === "rate_limit_exceeded") {
      await Bun.sleep(wait * 1000);
      return Mail.post(key, batch);
    }
    if ([400, 422].includes(res?.status ?? 0) && batch.length > 1) {
      const half = Math.ceil(batch.length / 2);
      await Mail.post(key, batch.slice(0, half));
      return Mail.post(key, batch.slice(half));
    }
    const err = res?.ok ? null : "mail: HTTP " + (res?.status ?? 0) + ": " + (out.message ?? "no answer");
    batch.forEach((wait) => wait.done(err));
  }

}
