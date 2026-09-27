const PROBES = Object.freeze({
  text: "Text response",
  stream: "Streaming response",
  function: "Function call",
  toolResult: "Tool result",
  parameterless: "Parameterless namespaced function",
  namespaceStream: "Streaming namespaced function",
  longContext: "Long context",
  toolSearch: "Efficient Fidelity tool search",
  searchedTool: "Efficient Fidelity selected tool",
});

// Progress is observational: observer exceptions must not affect receipts
// or interrupt a certification transaction. Never pass provider data here.
export function emitCertificationProgress(onProgress, event) {
  try {
    onProgress?.(event);
  } catch {
    // The certification result remains authoritative.
  }
}

export function createCertificationProgress({
  write = (text) => process.stderr.write(text),
  now = () => performance.now(),
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  const startedAt = now();
  let timer;
  let current;
  let modelPrefix = "";
  let probeCount = 7;
  let stopped = false;
  const elapsed = () => `${Math.floor(Math.max(0, now() - startedAt) / 1_000)}s elapsed`;
  const print = (message) => {
    try {
      write(`${message}\n`);
    } catch {
      // Output failure cannot change certification authority.
    }
  };
  const stop = () => {
    if (timer !== undefined) clearIntervalImpl(timer);
    timer = undefined;
    current = undefined;
    stopped = true;
  };
  const onProgress = (event) => {
    if (stopped) return;
    if (event.phase === "start") {
      print("Model certification enables Codex tools for project files and commands.");
      print("Live test requests can take several minutes per model, or longer on slow hardware. Keep models loaded and Codex fully closed until installation finishes.");
      current = "Checking model certifications";
    } else if (event.phase === "prepare") {
      current = "Preparing the certification service";
    } else if (event.phase === "model") {
      if (
        !Number.isSafeInteger(event.index) || event.index < 1 ||
        !Number.isSafeInteger(event.total) || event.total < event.index ||
        ![7, 9].includes(event.probeCount)
      ) return;
      modelPrefix = `Model ${event.index}/${event.total}: `;
      probeCount = event.probeCount;
      current = `${modelPrefix}starting live checks`;
    } else if (event.phase === "probe" && Object.hasOwn(PROBES, event.probe)) {
      const index = Object.keys(PROBES).indexOf(event.probe) + 1;
      if (index > probeCount) return;
      current = `${modelPrefix}check ${index}/${probeCount} - ${PROBES[event.probe]}`;
    } else if (event.phase === "publishing") {
      current = "Publishing the verified model catalog";
    } else if (event.phase === "model-passed" && ["direct", "efficient"].includes(event.mode)) {
      current = `${modelPrefix}checks passed (${event.mode === "efficient" ? "Efficient Fidelity" : "Direct tools"}); awaiting catalog publication`;
    } else if (event.phase === "complete") {
      print(`Certification checks and catalog publication complete (${elapsed()}). Restart Codex to load the result.`);
      stop();
      return;
    } else if (event.phase === "failed") {
      print(`Model certification incomplete (${elapsed()}).`);
      print("Installation retained. Models without a valid certification cannot use tools; interrupted models may remain blocked pending recovery.");
      print("Keep the models loaded, run pickermux doctor, then retry pickermux certify --all. Fully quit and reopen Codex afterwards.");
      stop();
      return;
    } else if (event.phase === "reused") {
      print("Existing valid model certifications retained; no live tests needed.");
      stop();
      return;
    } else if (event.phase === "no-models") {
      print("No external models discovered. Load a model, then run pickermux certify --all to enable tools.");
      stop();
      return;
    } else {
      return;
    }
    print(`${current} (${elapsed()}).`);
    if (timer === undefined) {
      timer = setIntervalImpl(() => {
        if (current) print(`${current}; still working (${elapsed()}).`);
      }, 10_000);
      timer?.unref?.();
    }
  };
  return { onProgress, stop };
}
