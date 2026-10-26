import { NotImplementedError, type FileChange, type GitPort, type Hunk, type Revision, type TrackedFile } from '@ripple/core';

/** Spawns `git` directly with `-z` output: full fidelity, no wrapper-library leaks. */
export class GitService implements GitPort {
  constructor(readonly cwd: string) {}

  async mergeBase(_a: Revision, _b: Revision): Promise<string> {
    throw new NotImplementedError('GitService.mergeBase', 'Phase 1');
  }

  async diff(_base: Revision, _head: Revision): Promise<FileChange[]> {
    throw new NotImplementedError('GitService.diff', 'Phase 1');
  }

  async hunks(_base: Revision, _head: Revision, _path: string): Promise<Hunk[]> {
    throw new NotImplementedError('GitService.hunks', 'Phase 2');
  }

  async listTracked(_rev: Revision): Promise<TrackedFile[]> {
    throw new NotImplementedError('GitService.listTracked', 'Phase 1');
  }

  async readBlob(_rev: Revision, _path: string): Promise<string> {
    throw new NotImplementedError('GitService.readBlob', 'Phase 1');
  }
}
