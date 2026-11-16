// Apple Wallet (.pkpass) generation for vouchers.
// Needs an Apple Developer Pass Type ID certificate. Each item below is read from an
// environment variable (PEM text or base64 of it) or, failing that, from a file in certs/.
//   PASS_TYPE_ID            e.g. pass.com.example.vouchers
//   APPLE_TEAM_ID           10-character Apple team ID
//   PASS_SIGNER_CERT        certs/signerCert.pem  (Pass Type ID certificate)
//   PASS_SIGNER_KEY         certs/signerKey.pem   (its private key)
//   PASS_SIGNER_KEY_PASSPHRASE                    (only if the key is encrypted)
//   APPLE_WWDR_CERT         certs/wwdr.pem        (Apple WWDR G4 intermediate)
//   PASS_ORG_NAME           shown on the pass and lock screen (default "Vouchers")
import { PKPass } from 'passkit-generator';
import fs from 'node:fs';
import path from 'node:path';

const fromEnvOrFile = (envName, file) => {
  const v = process.env[envName];
  if (v) return v.includes('-----BEGIN') ? v : Buffer.from(v, 'base64').toString('utf8');
  const p = path.resolve('certs', file);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
};

let certs;
function loadCerts() {
  certs ??= {
    signerCert: fromEnvOrFile('PASS_SIGNER_CERT', 'signerCert.pem'),
    signerKey: fromEnvOrFile('PASS_SIGNER_KEY', 'signerKey.pem'),
    wwdr: fromEnvOrFile('APPLE_WWDR_CERT', 'wwdr.pem'),
    signerKeyPassphrase: process.env.PASS_SIGNER_KEY_PASSPHRASE || undefined
  };
  return certs;
}

export function walletEnabled() {
  const c = loadCerts();
  return Boolean(process.env.PASS_TYPE_ID && process.env.APPLE_TEAM_ID && c.signerCert && c.signerKey && c.wwdr);
}

let images;
function loadImages() {
  if (!images) {
    const dir = path.resolve('server', 'pass-assets');
    images = Object.fromEntries(
      fs.readdirSync(dir).filter(f => f.endsWith('.png')).map(f => [f, fs.readFileSync(path.join(dir, f))])
    );
  }
  return images;
}

const money = cents => (cents / 100).toLocaleString('en-AU', { style: 'currency', currency: 'AUD' });
const auDate = d =>
  new Date(d).toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Australia/Sydney' });

// v is a raw row from the vouchers table
export function buildPass(v) {
  const org = process.env.PASS_ORG_NAME || 'Vouchers';
  const pass = new PKPass({ ...loadImages() }, loadCerts(), {
    passTypeIdentifier: process.env.PASS_TYPE_ID,
    teamIdentifier: process.env.APPLE_TEAM_ID,
    organizationName: org,
    description: `${org} voucher ${v.code}`,
    serialNumber: `voucher-${v.id}-${v.code}`,
    logoText: org,
    backgroundColor: 'rgb(6, 42, 42)',
    foregroundColor: 'rgb(251, 246, 230)',
    labelColor: 'rgb(212, 175, 55)',
    voided: v.balance_cents === 0
  });

  pass.type = 'storeCard';
  pass.headerFields.push({ key: 'code', label: 'VOUCHER NO.', value: v.code });
  pass.primaryFields.push({ key: 'balance', label: 'REMAINING CREDIT', value: money(v.balance_cents) });
  pass.secondaryFields.push(
    { key: 'initial', label: 'ORIGINAL VALUE', value: money(v.initial_cents) },
    { key: 'expires', label: 'EXPIRES', value: v.expires_at ? auDate(v.expires_at) : 'No expiry' }
  );
  pass.backFields.push(
    ...(v.description ? [{ key: 'desc', label: 'Description', value: v.description }] : []),
    {
      key: 'asof',
      label: 'Balance',
      value: `Balance shown is as at ${auDate(new Date())}. Your current balance is confirmed in store when the voucher is scanned.`
    }
  );

  pass.setBarcodes({
    format: 'PKBarcodeFormatCode128',
    message: v.code,
    messageEncoding: 'iso-8859-1',
    altText: v.code
  });
  if (v.expires_at) pass.setExpirationDate(new Date(v.expires_at));

  return pass.getAsBuffer();
}
