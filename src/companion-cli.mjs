import {
  CompanionControlError,
  companionFailure,
  companionSuccess,
  createCompanionProgress,
  readCompanionRequest,
} from "./companion-control.mjs";

/** One bounded stdin request; all output is projected before crossing into Swift. */
export async function runCompanionCli(argv, {
  input = process.stdin,
  output = process.stdout,
  progressOutput = process.stderr,
  statusImpl,
  executeImpl,
} = {}) {
  let response;
  try {
    if (argv.length !== 1 || !["status", "run"].includes(argv[0])) throw new CompanionControlError("INVALID_REQUEST");
    if (argv[0] === "status") {
      response = await statusImpl();
    } else {
      const request = await readCompanionRequest(input);
      const result = await executeImpl(request, {
        onProgress(event) {
          progressOutput.write(`${JSON.stringify(createCompanionProgress(event))}\n`);
        },
      });
      const { schemaVersion, ok, code, ...data } = companionSuccess(request.action, result);
      response = { schemaVersion, ok, code, data };
    }
  } catch (error) {
    response = companionFailure(error);
  }
  output.write(`${JSON.stringify(response)}\n`);
  return response;
}
