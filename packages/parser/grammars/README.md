# Tree-sitter grammars

Copied unchanged from [`tree-sitter-typescript`](https://www.npmjs.com/package/tree-sitter-typescript) 0.23.2 (MIT, see
[LICENSE](LICENSE)). The npm package isn't a dependency: it adds 38 MB and an install script for these two files.

| File | SHA-256 |
|---|---|
| `tree-sitter-typescript.wasm` | `778025db5a8be0e70f8ccc3671e486dfeddd048c25d9e8a70c26de2e1bf6f97d` |
| `tree-sitter-tsx.wasm` | `79e5da75ea62855a0cd67177685f0164eac87d5f630b3cbe1e0a099751ad30f8` |

To update: `npm pack tree-sitter-typescript@<version>`, copy both files and the license from the tarball, update this
page, and bump `PARSER_VERSION`, because cached facts came from the old grammar.
