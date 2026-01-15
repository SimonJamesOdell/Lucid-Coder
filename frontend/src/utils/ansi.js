const ANSI_REGEX = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PRZcf-nq-uy=><]/g;

export const stripAnsi = (value = '') => {
  if (typeof value !== 'string') {
    return value;
  }
  return value.replace(ANSI_REGEX, '');
};
