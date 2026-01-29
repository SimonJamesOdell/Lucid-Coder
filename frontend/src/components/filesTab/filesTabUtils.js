export const buildSiblingPath = (basePath, nextName) => {
  const safeName = String(nextName || '').trim().replace(/\\/g, '/');
  if (!safeName || safeName.includes('/') || safeName.includes('..')) {
    return null;
  }

  const lastSlash = basePath.lastIndexOf('/');
  const dir = lastSlash >= 0 ? basePath.slice(0, lastSlash) : '';
  return dir ? `${dir}/${safeName}` : safeName;
};

export const buildChildPath = (baseDir, nextName) => {
  const safeName = String(nextName || '').trim().replace(/\\/g, '/');
  if (!safeName || safeName.includes('/') || safeName.includes('..')) {
    return null;
  }

  const normalizedBase = String(baseDir || '').trim().replace(/\\/g, '/').replace(/\/$/, '');
  if (!normalizedBase) {
    return safeName;
  }

  if (normalizedBase.includes('..')) {
    return null;
  }

  return `${normalizedBase}/${safeName}`;
};

export const suggestDuplicateName = (fileName) => {
  const name = String(fileName || '').trim();
  if (!name) {
    return 'copy';
  }
  const lastDot = name.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === name.length - 1) {
    return `${name}-copy`;
  }
  const base = name.slice(0, lastDot);
  const ext = name.slice(lastDot);
  return `${base}-copy${ext}`;
};
