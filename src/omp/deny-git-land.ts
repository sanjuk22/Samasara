import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.setLabel("samasara-deny-git-land");
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return;
    const cmd = String((event.input as { command?: string }).command ?? "");
    if (!/\bgit\b/.test(cmd)) return;
    if (/\bgit\s+(-C\s+\S+\s+)?((status|diff|log|show|rev-parse|ls-files)(\s|$))/.test(cmd)) return;
    return { block: true, reason: "samasara: git mutations are forbidden; edit files only, do not commit or push" };
  });
}
