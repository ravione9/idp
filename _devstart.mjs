// Local-only launcher: loads .env into process.env (handles spaces), then boots the server.
import fs from 'node:fs';
const txt = fs.readFileSync(new URL('./.env', import.meta.url), 'utf8');
for (const line of txt.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}
process.env.SAML_KEY_DIR ??= new URL('./data/saml', import.meta.url).pathname.replace(/^\//, '');
fs.mkdirSync(process.env.SAML_KEY_DIR, { recursive: true });
await import('./dist/index.js');
