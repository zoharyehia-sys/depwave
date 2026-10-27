import { CacheManager } from '@depwave/cache';
import { GitService } from '@depwave/git';
import { Command, Option } from 'clipanion';
import { cachePath } from '../AnalysisPipeline.js';
import { EXIT_FAILURE } from './ImpactCommand.js';

abstract class CacheCommand extends Command {
  cwd = Option.String('--cwd', { description: 'Repository whose cache to use (defaults to the current directory)' });

  protected abstract run(cache: CacheManager): void;

  async execute(): Promise<number> {
    let cache: CacheManager | undefined;
    try {
      cache = new CacheManager(cachePath(await new GitService(this.cwd ?? process.cwd()).root()));
      this.run(cache);
      return 0;
    } catch (error) {
      this.context.stderr.write(`depwave: ${error instanceof Error ? error.message : String(error)}\n`);
      return EXIT_FAILURE;
    } finally {
      cache?.close();
    }
  }
}

export class CacheStatsCommand extends CacheCommand {
  static override paths = [['cache', 'stats']];
  static override usage = Command.Usage({ description: 'Show what the analysis cache holds and its size on disk.' });

  protected run(cache: CacheManager): void {
    const s = cache.stats();
    this.context.stdout.write(
      [
        `cache:       ${s.path}`,
        `facts:       ${s.facts} file(s)`,
        `resolutions: ${s.resolutions}`,
        `snapshots:   ${s.snapshots} commit(s)`,
        `size:        ${formatBytes(s.bytes)}`,
        '',
      ].join('\n'),
    );
  }
}

export class CacheClearCommand extends CacheCommand {
  static override paths = [['cache', 'clear']];
  static override usage = Command.Usage({ description: 'Delete everything in the analysis cache. The next run rebuilds it.' });

  protected run(cache: CacheManager): void {
    const before = cache.stats();
    cache.clear();
    this.context.stdout.write(`cleared ${before.facts} facts, ${before.resolutions} resolutions, ${before.snapshots} snapshots (${formatBytes(before.bytes)})\n`);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
