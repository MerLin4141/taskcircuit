export function agentEnvironment(source, adapter) {
    return Object.fromEntries(Object.entries(source).filter(([key]) => !key.toUpperCase().startsWith("TASKCIRCUIT_") &&
        !(adapter === "codex" &&
            key.toUpperCase() === "CODEX_WINDOWS_REGISTERED_CORE")));
}
