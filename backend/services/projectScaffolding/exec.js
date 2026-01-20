const sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));

export const looksLikeWindowsLock = (error, platform = process.platform) => {
  if (platform !== 'win32') {
    return false;
  }
  const text = `${error?.message || ''}\n${error?.stderr || ''}\n${error?.stdout || ''}`.toLowerCase();
  return text.includes('eperm') || text.includes('ebusy') || text.includes('eacces') || text.includes('enotempty');
};

export const execWithRetry = async (
  execFn,
  command,
  options,
  {
    maxBuffer,
    delays = [500, 1500, 3000],
    platform = process.platform,
    sleepFn = sleep
  } = {}
) => {
  try {
    return await execFn(command, { ...(options || {}), maxBuffer });
  } catch (error) {
    if (!looksLikeWindowsLock(error, platform)) {
      throw error;
    }

    let lastError = error;
    for (const delay of delays) {
      await sleepFn(delay);
      try {
        return await execFn(command, { ...(options || {}), maxBuffer });
      } catch (nextError) {
        lastError = nextError;
        if (!looksLikeWindowsLock(nextError, platform)) {
          break;
        }
      }
    }
    throw lastError;
  }
};

export const buildExecErrorTail = (error) => {
  const stderr = typeof error?.stderr === 'string' ? error.stderr : '';
  const stdout = typeof error?.stdout === 'string' ? error.stdout : '';
  const combined = [stderr, stdout].filter(Boolean).join('\n');
  if (!combined) {
    return '';
  }
  const tail = combined.split(/\r?\n/).slice(-40).join('\n');
  return `\n${tail}`;
};
