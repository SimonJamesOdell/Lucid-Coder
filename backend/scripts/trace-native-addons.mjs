import path from 'node:path';
import { pathToFileURL } from 'node:url';

const targetArg = process.argv[2] ?? './server.js';
const resolvedTarget = path.isAbsolute(targetArg)
  ? targetArg
  : path.resolve(process.cwd(), targetArg);

// Avoid accidental server auto-start when tracing imports.
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'test';
}

const originalDlopen = process.dlopen;
process.dlopen = function patchedDlopen(...args) {
  const filename = args[1];
  // filename is typically the absolute path to the *.node binary.
  // Logging this helps identify which native addon was being loaded
  // right before a crash like napi_register_module_v1.
  try {
    // eslint-disable-next-line no-console
    console.log('[native-addon]', filename);
  } catch {
    // ignore
  }
  return originalDlopen.apply(this, args);
};

// eslint-disable-next-line no-console
console.log('[trace-native-addons] importing', resolvedTarget, 'NODE_ENV=', process.env.NODE_ENV);

await import(pathToFileURL(resolvedTarget).href);

// eslint-disable-next-line no-console
console.log('[trace-native-addons] import complete');
