import { packageAllLocalExtensionsStream, packageMarketplaceExtensionsStream } from '../vscode/build/lib/extensions.ts';
import { gulp } from '../vscode/build/lib/gulp/facade.ts';
import es from '../vscode/node_modules/event-stream/index.js';
import fs from 'fs';
import path from 'path';

const output = path.resolve('../vscode/.build');
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });

const stream = es.merge([
  packageAllLocalExtensionsStream(true),
  packageMarketplaceExtensionsStream(true),
]);

await new Promise<void>((resolve, reject) => {
  stream
    .pipe(gulp.dest(output))
    .on('error', reject)
    .on('end', resolve);
});

console.log('Web extensions packaged into', output);
