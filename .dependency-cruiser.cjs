/**
 * Architecture rules (see ARCHITECTURE.md §2.1):
 *   core      → nothing (pure: no node builtins, no npm deps, no other @ripple package)
 *   adapters  → core only
 *   cli       → anything (composition root)
 */
const ADAPTERS = '(parser|resolver|cache|git|workspace|reporters)';

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular imports make incremental reasoning (and humans) sad.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'core-no-builtins',
      severity: 'error',
      comment: 'core is pure: I/O belongs behind a port in an adapter package.',
      from: { path: '^packages/core/src' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'core-no-npm',
      severity: 'error',
      comment: 'core has zero third-party runtime dependencies.',
      from: { path: '^packages/core/src', pathNot: '\\.test\\.ts$' },
      to: { dependencyTypes: ['npm', 'npm-dev', 'npm-optional', 'npm-peer', 'npm-no-pkg', 'npm-unknown'] },
    },
    {
      name: 'core-no-internal-deps',
      severity: 'error',
      comment: 'core may not import any other @ripple package.',
      from: { path: '^packages/core/' },
      to: { path: '^packages/', pathNot: '^packages/core/' },
    },
    {
      name: 'adapters-depend-only-on-core',
      severity: 'error',
      comment: 'Adapters talk to each other only through core ports, wired together in cli.',
      from: { path: `^packages/${ADAPTERS}/` },
      to: { path: '^packages/', pathNot: ['^packages/core/', '^packages/$1/'] },
    },
    {
      name: 'no-test-code-in-src',
      severity: 'error',
      from: { path: '^packages/', pathNot: '\\.test\\.ts$' },
      to: { path: '\\.test\\.ts$' },
    },
    {
      name: 'no-undeclared-deps',
      severity: 'error',
      comment: 'Every npm import must be declared in the importing package.json.',
      from: {},
      to: { dependencyTypes: ['npm-no-pkg', 'npm-unknown'] },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: ['node_modules'] },
    exclude: { path: ['(^|/)dist/', '\\.d\\.ts$'] },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.js', '.json'],
    },
  },
};
