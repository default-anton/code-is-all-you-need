import { stdout } from 'node:process';

function detectAnsiColorSupport() {
  if ('NO_COLOR' in process.env) {
    return false;
  }
  if ('FORCE_COLOR' in process.env && process.env.FORCE_COLOR !== '0') {
    return true;
  }
  return Boolean(stdout?.isTTY);
}

function applyAnsiStyle(code) {
  return (value) => {
    const normalized = value == null ? '' : String(value);
    if (!normalized) {
      return '';
    }
    if (!supportsAnsiColors) {
      return normalized;
    }
    return `\u001B[${code}m${normalized}\u001B[0m`;
  };
}

const supportsAnsiColors = detectAnsiColorSupport();

const theme = {
  label: applyAnsiStyle('1;96'),
  accent: applyAnsiStyle('36'),
  heading: applyAnsiStyle('95'),
  muted: applyAnsiStyle('90'),
  success: applyAnsiStyle('92'),
  warning: applyAnsiStyle('93'),
  error: applyAnsiStyle('91'),
  prompt: applyAnsiStyle('94'),
  strong: applyAnsiStyle('97'),
  reasoning: applyAnsiStyle('2;37'),
};

export { theme, applyAnsiStyle, detectAnsiColorSupport };
