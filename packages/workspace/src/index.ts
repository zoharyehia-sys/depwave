export { CONFIG_FILE, createIgnoreMatcher, loadConfig, type DepwaveConfig } from './config.js';
export { createOwnerLookup } from './paths.js';
export { SourceInventory } from './SourceInventory.js';
export { createMatcher, WorkspaceDiscovery, WorkspaceError } from './WorkspaceDiscovery.js';
export { LockfileAnalyzer } from './lockfile/LockfileAnalyzer.js';
export { resolveFrom } from './lockfile/NpmLockfile.js';
export { depPath } from './lockfile/PnpmLockfile.js';
