import { build } from 'tsup';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';

try {
  await build({entry:['tests/migration.test.ts'],format:['esm'],platform:'node',outDir:'.test-dist',config:false,removeNodeProtocol:false,clean:true,silent:true});
  const result=spawnSync(process.execPath,['--test','.test-dist/migration.test.js'],{stdio:'inherit'});
  process.exitCode=result.status ?? 1;
} finally {
  rmSync('.test-dist', { recursive: true, force: true });
}
