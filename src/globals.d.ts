// Set from the agent table of `skills` at build time; see vite.config.ts.
/** Environment variables that place agents' skills folders. */
declare const __SKILLS_AGENT_ENV__: readonly string[];
/** Universal agents that globally read only their own folder, not ~/.agents/skills. */
declare const __SKILLS_OWN_GLOBAL_FOLDER__: readonly string[];
