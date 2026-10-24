// Load-proof timing for the perf tests. An absolute bound flakes when the machine is busy, so time the code against
// reference work run in the same process, interleaved with it: load slows both, a regression in the code only one.
// The fastest of several runs of each is what we compare, since load only ever adds time.

// Tokenising and allocating, the kind of work a parser does, on a fixed synthetic line. It runs for tens of
// milliseconds, the same order as the code under test, so preemption on a crowded machine hits both alike.
const sample = "plain words, a *star* or [[link]] and uni:A/B now ".repeat(2000);
const reference = () => { let n = 0; for (let i = 0; i < 25; i++) n += sample.split(/(\s+)/).map((v) => ({ t: "text", v })).filter((x) => x.v.trim()).length; return n; };

/** How many times longer `fn` takes than the reference work, fastest run against fastest run. */
export function timesReference(fn: () => unknown, runs = 7): number {
  let code = Infinity;
  let ref = Infinity;
  for (let i = 0; i < runs; i++) {
    let t0 = performance.now();
    fn();
    code = Math.min(code, performance.now() - t0);
    t0 = performance.now();
    reference();
    ref = Math.min(ref, performance.now() - t0);
  }
  return code / ref;
}
