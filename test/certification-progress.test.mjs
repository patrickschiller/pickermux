import assert from "node:assert/strict";
import test from "node:test";
import {
  createCertificationProgress,
  emitCertificationProgress,
} from "../src/certification-progress.mjs";

function fixture() {
  const output = [];
  let time = 0;
  let tick;
  let cleared = 0;
  const progress = createCertificationProgress({
    write: (text) => output.push(text),
    now: () => time,
    setIntervalImpl: (callback, delay) => {
      assert.equal(delay, 10_000);
      assert.equal(tick, undefined);
      tick = callback;
      return 1;
    },
    clearIntervalImpl: (timer) => {
      assert.equal(timer, 1);
      cleared += 1;
    },
  });
  return {
    ...progress,
    output,
    wait: () => { time += 10_000; tick(); },
    cleared: () => cleared,
  };
}

test("progress reports real model/probe stages with elapsed heartbeats, including piped output", () => {
  const progress = fixture();
  progress.onProgress({ phase: "start" });
  progress.onProgress({ phase: "prepare" });
  progress.onProgress({ phase: "model", index: 2, total: 3, probeCount: 9 });
  progress.onProgress({ phase: "probe", probe: "longContext" });
  progress.wait();
  progress.onProgress({ phase: "probe", probe: "toolSearch" });
  progress.onProgress({ phase: "probe", probe: "searchedTool" });
  progress.onProgress({ phase: "model-passed", mode: "direct" });
  assert.doesNotMatch(progress.output.join(""), /publication complete/u);
  progress.onProgress({ phase: "publishing" });
  progress.onProgress({ phase: "complete" });
  progress.stop();
  assert.equal(progress.cleared(), 1);
  const output = progress.output.join("");
  assert.match(output, /several minutes per model/u);
  assert.match(output, /Model 2\/3: check 7\/9 - Long context; still working \(10s elapsed\)/u);
  assert.match(output, /check 8\/9 - Efficient Fidelity tool search/u);
  assert.match(output, /check 9\/9 - Efficient Fidelity selected tool/u);
  assert.match(output, /checks passed \(Direct tools\); awaiting catalog publication/u);
  assert.match(output, /publication complete \(10s elapsed\)/u);
  assert.doesNotMatch(output, /%|\r|\x1b/u);
});

test("failed checks stop heartbeats and print recovery without a successful completion", () => {
  const progress = fixture();
  progress.onProgress({ phase: "start" });
  progress.onProgress({ phase: "failed", error: "private-secret" });
  const before = progress.output.join("");
  progress.wait();
  progress.onProgress({ phase: "complete" });
  assert.equal(progress.output.join(""), before);
  assert.equal(progress.cleared(), 1);
  assert.match(before, /Installation retained/u);
  assert.match(before, /pickermux certify --all/u);
  assert.doesNotMatch(before, /private-secret|publication complete/u);
});

test("only fixed progress labels and numeric counts can reach output", () => {
  const progress = fixture();
  for (const event of [
    { phase: "private-secret" },
    { phase: "probe", probe: "private-secret" },
    { phase: "model", index: "private-secret", total: 1, probeCount: 9 },
    { phase: "model", index: 2, total: 1, probeCount: 9 },
    { phase: "model-passed", mode: "private-secret" },
  ]) progress.onProgress(event);
  assert.deepEqual(progress.output, []);
  progress.onProgress({ phase: "model", index: 1, total: 1, probeCount: 7, model: "private-secret" });
  progress.onProgress({ phase: "probe", probe: "text", body: "private-secret" });
  progress.onProgress({ phase: "probe", probe: "toolSearch" });
  progress.stop();
  assert.match(progress.output.join(""), /check 1\/7 - Text response/u);
  assert.doesNotMatch(progress.output.join(""), /private-secret|check 8/u);
});

test("reporter and observer failures cannot interrupt certification", () => {
  const progress = createCertificationProgress({
    write: () => { throw new Error("closed output"); },
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => {},
  });
  assert.doesNotThrow(() => progress.onProgress({ phase: "start" }));
  assert.doesNotThrow(() => progress.onProgress({ phase: "complete" }));
  assert.doesNotThrow(() => emitCertificationProgress(() => {
    throw new Error("observer failed");
  }, { phase: "prepare" }));
});
