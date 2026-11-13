export type AiResponseStyle = "Fast" | "Balanced" | "Deep";

export type AiPreferences = {
  model: "active";
  responseStyle: AiResponseStyle;
};

export function readAiPreferences(): AiPreferences {
  let style: string | null = null;
  try {
    style = localStorage.getItem("studyos_ai_style");
  } catch {
    // The active server connection also works when browser storage is unavailable.
  }
  return {
    model: "active",
    responseStyle:
      style === "Fast" || style === "Concise"
        ? "Fast"
        : style === "Deep" || style === "Detailed"
          ? "Deep"
          : "Balanced",
  };
}

export function saveAiResponseStyle(style: AiResponseStyle) {
  try {
    localStorage.setItem("studyos_ai_style", style);
  } catch {
    // Connection credentials and routing are always kept on the server.
  }
}
