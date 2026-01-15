// Preload helper to log native addon loads.
//
// Usage (PowerShell):
//   $env:NODE_OPTIONS='--import=./scripts/dlopen-trace.mjs'
//   npx vitest run --config vitest.parallel.config.js
//
// This can help identify the last *.node binary loaded before a fatal
// napi_register_module_v1 crash.

const originalDlopen = process.dlopen;

process.dlopen = function patchedDlopen(module, filename, ...rest) {
  try {
    // eslint-disable-next-line no-console
    console.log('[native-addon]', filename);
  } catch {
    // ignore
  }

  // @ts-ignore - Node internal signature
  return originalDlopen.call(this, module, filename, ...rest);
};
