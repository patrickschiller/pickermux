function hasFunctionHistory(input) {
  return (
    Array.isArray(input) &&
    input.some(
      (item) =>
        item !== null &&
        !Array.isArray(item) &&
        typeof item === "object" &&
        (item.type === "function_call" || item.type === "function_call_output"),
    )
  );
}

/** Distinguish optional client catalogs from turns that require tool support. */
export function requiresToolCapability(requestBody) {
  const choice = requestBody?.tool_choice;
  return (
    (choice !== undefined && choice !== "auto" && choice !== "none") ||
    hasFunctionHistory(requestBody?.input)
  );
}
