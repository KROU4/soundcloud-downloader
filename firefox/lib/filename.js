// File and folder names that are valid on Windows, macOS and Linux and accepted
// by chrome.downloads / browser.downloads (both reject some names outright).

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
const REPLACEMENTS = { '/': '∕', '\\': '⧵', ':': '꞉', '*': '∗', '?': '？', '"': '＂', '<': '‹', '>': '›', '|': '∣' };

export function sanitize(name, maxLength = 120) {
  let s = String(name ?? '')
    .normalize('NFC')
    .replace(/[/\\:*?"<>|]/g, (c) => REPLACEMENTS[c])
    // control chars, zero-width and bidi marks break downloads on Chromium
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.~]+/, '')
    .replace(/[. ]+$/, '');
  if (s.length > maxLength) s = s.slice(0, maxLength).replace(/[. ]+$/, '').trim();
  if (!s || RESERVED.test(s)) s = `_${s}`;
  return s;
}

/**
 * Renders a template like "{artist} - {title}". Unknown/empty placeholders vanish
 * together with dangling separators. Slashes inside values are replaced so that
 * "AC/DC" stays one folder name; only slashes typed in the template make folders.
 */
export function renderTemplate(template, values) {
  const out = template.replace(/\{(\w+)\}/g, (_, k) => {
    const v = values[k];
    return v === undefined || v === null ? '' : String(v).replace(/[/\\]/g, (c) => REPLACEMENTS[c]);
  });
  return out
    .replace(/(\s*[-–—]\s*){2,}/g, ' - ')
    .replace(/^\s*[-–—]\s*|\s*[-–—]\s*$/g, '')
    .replace(/\(\s*\)|\[\s*\]/g, '')
    .trim();
}

/** Joins template output into a relative path; each segment is sanitized. */
export function buildPath(folder, fileBase, ext) {
  const file = `${sanitize(fileBase) || 'track'}.${ext}`;
  if (!folder) return file;
  const dirs = folder
    .split('/')
    .map((d) => sanitize(d, 80))
    .filter((d) => d && d !== '_');
  return [...dirs, file].join('/');
}

export function pad(n, width) {
  return String(n).padStart(width, '0');
}
