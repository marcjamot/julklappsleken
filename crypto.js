// Encryption shared by the page (index.html) and the admin script (admin.mjs).
// Uses Web Crypto, which is built into both browsers and Node.

export const ITERATIONS = 200_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function normalizeMaster(password) {
  return password.normalize('NFC').trim();
}

// Forgiving about case and separators, so "Kanel Tomte Lykta 42" opens "kanel-tomte-lykta-42".
export function normalizePassword(password) {
  return password.normalize('NFC').trim().toLowerCase().replace(/[\s_.-]+/g, '-');
}

export function randomBase64(byteLength) {
  return toBase64(crypto.getRandomValues(new Uint8Array(byteLength)));
}

// The master password unlocks the vault: names, rules, passwords and the draw.
export async function openVault(file, password) {
  return open(await masterKey(file, password), file.master);
}

export async function sealVault(file, password, vault) {
  return seal(await masterKey(file, password), vault);
}

// A person's password gives both the key to their entry and the entry's ID,
// so the page can find the entry without asking for a name.
export async function openEntry(file, password) {
  const { id, key } = await personKey(file, password);
  return Object.hasOwn(file.entries, id) ? open(key, file.entries[id]) : null;
}

export async function sealEntry(file, password, entry) {
  const { id, key } = await personKey(file, password);
  return { id, box: await seal(key, entry) };
}

async function masterKey(file, password) {
  const bits = await deriveBits(normalizeMaster(password), file.masterSalt, file.iterations, 256);
  return aesKey(bits);
}

async function personKey(file, password) {
  const bits = await deriveBits(normalizePassword(password), file.entrySalt, file.iterations, 384);
  return { id: toHex(bits.slice(32)), key: await aesKey(bits.slice(0, 32)) };
}

async function deriveBits(password, salt, iterations, length) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const params = { name: 'PBKDF2', hash: 'SHA-256', salt: fromBase64(salt), iterations };
  return new Uint8Array(await crypto.subtle.deriveBits(params, material, length));
}

function aesKey(bytes) {
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function seal(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(value)));
  return { iv: toBase64(iv), data: toBase64(new Uint8Array(data)) };
}

// Returns null when the key is wrong.
async function open(key, box) {
  try {
    const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(box.iv) }, key, fromBase64(box.data));
    return JSON.parse(decoder.decode(data));
  } catch {
    return null;
  }
}

function toBase64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(text) {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

function toHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
