'use strict';

// Guarda as credenciais do B2 neste navegador, criptografadas com uma senha (PBKDF2 + AES-GCM).
// Sem a senha, o que fica no localStorage não serve para nada.

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();
const ITERATIONS = 250000;

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(passphrase, salt, iterations) {
  const base = await subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function seal(passphrase, obj) {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, ITERATIONS);
  const data = await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  return { v: 1, iter: ITERATIONS, salt: b64(salt), iv: b64(iv), data: b64(data) };
}

/** Devolve o objeto, ou lança "Senha incorreta". */
async function open(passphrase, sealed) {
  try {
    const key = await deriveKey(passphrase, unb64(sealed.salt), sealed.iter || ITERATIONS);
    const plain = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(sealed.iv) }, key, unb64(sealed.data));
    return JSON.parse(dec.decode(plain));
  } catch {
    throw new Error('Senha incorreta');
  }
}

module.exports = { seal, open };
