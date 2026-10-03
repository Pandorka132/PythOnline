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

// Inject the native PyCharm-style Python live templates into the packaged
// built-in Python extension. The VS Code checkout is intentionally ignored
// by this project, so keep the source snippet file in the tracked tree.
const pythonExtension = path.join(output, 'extensions', 'python');
const snippetSource = path.resolve('../extensions/pycharm-python-snippets.code-snippets');
const snippetTarget = path.join(pythonExtension, 'snippets', 'pycharm-python.code-snippets');
const pythonPackagePath = path.join(pythonExtension, 'package.json');

if (!fs.existsSync(pythonPackagePath)) {
  throw new Error('Packaged Python extension not found: ' + pythonPackagePath);
}

fs.mkdirSync(path.dirname(snippetTarget), { recursive: true });
fs.copyFileSync(snippetSource, snippetTarget);

const pythonPackage = JSON.parse(fs.readFileSync(pythonPackagePath, 'utf8'));
pythonPackage.contributes ??= {};
pythonPackage.contributes.snippets ??= [];
if (!pythonPackage.contributes.snippets.some((entry: { language?: string; path?: string }) =>
  entry.language === 'python' && entry.path === './snippets/pycharm-python.code-snippets')) {
  pythonPackage.contributes.snippets.push({
    language: 'python',
    path: './snippets/pycharm-python.code-snippets',
  });
}
fs.writeFileSync(pythonPackagePath, JSON.stringify(pythonPackage, null, 2) + '\n');

console.log('Injected PyCharm-style Python snippets into', pythonExtension);
console.log('Web extensions packaged into', output);
