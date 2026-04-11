import { spawnSync } from "node:child_process"

const SYSTEM_DEPENDENCIES = [
  {
    command: "tmux",
    probeArgs: ["-V"],
    installHint: "Install tmux and make sure it is available on PATH.",
  },
  {
    command: "opencode",
    probeArgs: ["--version"],
    installHint: "Install the OpenCode CLI and make sure it is available on PATH.",
  },
]

function dependencyExists(command, probeArgs) {
  const result = spawnSync(command, probeArgs, {
    stdio: "ignore",
  })
  return result.error?.code !== "ENOENT"
}

export function getSystemDependencyReport() {
  const missing = SYSTEM_DEPENDENCIES.filter((dependency) => !dependencyExists(dependency.command, dependency.probeArgs))
  return {
    allFound: missing.length === 0,
    missing,
  }
}

export function formatMissingDependencyMessage(report) {
  if (report.allFound) {
    return "[opencode-sidebar] Found required system dependencies: tmux, opencode."
  }

  const details = report.missing.map((dependency) => `- ${dependency.command}: ${dependency.installHint}`).join("\n")
  return [
    "[opencode-sidebar] Installed, but some required system dependencies are missing.",
    details,
    "[opencode-sidebar] The package will not run until those commands are installed.",
  ].join("\n")
}
