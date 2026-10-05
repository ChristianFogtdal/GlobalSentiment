import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const dependencyRoot = process.env.TEST_DEPS_PATH || join(tmpdir(), 'sentimentmap-validation');
const require = createRequire(join(dependencyRoot, 'package.json'));
const ts = require('typescript');
const sourceRoot = fileURLToPath(new URL('../functions/', import.meta.url));
const files = ts.sys.readDirectory(sourceRoot, ['.ts']);
const denoTypes = resolve(sourceRoot, '__validation_deno.d.ts');
const assertTypes = resolve(sourceRoot, '__validation_assert.d.ts');
const virtual = new Map([
  [denoTypes, `declare namespace Deno {
    const env: { get(name: string): string | undefined; set(name: string,value: string): void; delete(name: string): void };
    function test(name: string, callback: () => void | Promise<void>): void;
    function serve(handler: (request: Request) => Response | Promise<Response>): void;
  }
  interface ImportMeta { main: boolean; }`],
  [assertTypes, 'export function assert(value: unknown, message?: string): asserts value; export function assertEquals(actual: unknown, expected: unknown, message?: string): void;'],
]);
const options = {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, noEmit: true,
  allowImportingTsExtensions: true, skipLibCheck: true, types: [],
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
};
const host = ts.createCompilerHost(options);
const read = host.readFile.bind(host);
const exists = host.fileExists.bind(host);
host.readFile = (file) => virtual.get(resolve(file)) ?? read(file);
host.fileExists = (file) => virtual.has(resolve(file)) || exists(file);
host.resolveModuleNames = (names, containingFile) => names.map((name) => {
  if (name === 'https://deno.land/std@0.224.0/assert/mod.ts') return { resolvedFileName: assertTypes, extension: ts.Extension.Dts };
  if (name === 'https://esm.sh/@supabase/supabase-js@2') {
    return ts.resolveModuleName('@supabase/supabase-js', join(dependencyRoot, 'index.ts'), options, host).resolvedModule;
  }
  return ts.resolveModuleName(name, containingFile, options, host).resolvedModule;
});
const program = ts.createProgram([...files, denoTypes], options, host);
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (file) => file, getCurrentDirectory: ts.sys.getCurrentDirectory, getNewLine: () => '\n',
  }));
  process.exitCode = 1;
} else console.log(`Strict TypeScript check passed for ${files.length} files (Deno API declarations supplied locally).`);

const { ESLint } = require('eslint');
const { parser } = require('typescript-eslint');
const eslint = new ESLint({
  overrideConfigFile: true,
  overrideConfig: [{
    files: ['**/*.ts', '**/*.mjs', '**/app.js'],
    languageOptions: { parser, ecmaVersion: 'latest', sourceType: 'module' },
    rules: {
      'constructor-super': 'error', 'no-async-promise-executor': 'error',
      'no-constant-condition': 'error', 'no-dupe-args': 'error', 'no-dupe-else-if': 'error',
      'no-dupe-keys': 'error', 'no-duplicate-case': 'error', 'no-unreachable': 'error',
      'no-unsafe-finally': 'error', 'valid-typeof': 'error',
    },
  }],
});
const lintResults = await eslint.lintFiles([
  'supabase/functions/**/*.ts', 'supabase/scripts/*.mjs', 'app.js',
]);
const lintErrors = lintResults.reduce((count, result) => count + result.errorCount, 0);
if (lintErrors) {
  console.error(await (await eslint.loadFormatter('stylish')).format(lintResults));
  process.exitCode = 1;
} else console.log(`ESLint correctness rules passed for ${lintResults.length} files.`);