# Bafwethu Society

An offline-first contribution manager built with React, Vite, and SQLite WASM. Society records are stored unencrypted in this browser's IndexedDB. Google Drive is not used as the live database.

## Run locally

Requires Node.js 20 or later and npm:

```sh
npm install
npm run dev
```

## Run with Docker

Requires Docker Engine and Docker Compose:

```sh
docker compose up --build -d
```

Open [http://localhost:4173](http://localhost:4173). To stop the app, run `docker compose down`. Society records are stored unencrypted in the browser's IndexedDB, not in the container.

### Access from other devices on your local network

HTTPS is recommended for installing the PWA and using offline service-worker features when accessing the app by LAN IP. Generate a local CA and a server certificate for this Mac's current `en0` IPv4 address, then start/rebuild the app:

```sh
bash scripts/setup-lan-https.sh
docker compose up --build -d
```

Open `http://<this-Mac's-LAN-IP>:4173` to be redirected to `https://<this-Mac's-LAN-IP>:8443`. The HTTPS address is recommended for installing the app as a PWA, but requires a trusted local certificate; otherwise the browser displays a certificate warning. The setup script prints the IP and creates certificates in the ignored `certs/` directory. On macOS, open Keychain Access, import `certs/ca.crt` into the login keychain, open the imported **Bafwethu Local HTTPS CA** certificate, expand **Trust**, and set **When using this certificate** to **Always Trust**. On each other device, securely transfer only `certs/ca.crt` and install/trust it as a root certificate; never share `certs/ca.key` or `certs/server.key`. On iPhone/iPad, install the downloaded certificate profile, then enable full trust for it under **Settings → General → About → Certificate Trust Settings**. Browsers may need to be restarted after trusting the CA.

The certificate is valid for the IP address detected when the setup script runs. If the Mac's LAN IP changes, rerun the script and `docker compose up --build -d`. `localhost`, the LAN IP over HTTP, and the LAN IP over HTTPS are separate browser origins with separate local databases. If data already exists under one origin, export a JSON backup there and restore it after opening the other origin.

### Install on a phone

Connect the phone to the same Wi-Fi as the Mac and open `http://<this-Mac's-LAN-IP>:4173`; it redirects to HTTPS. Trust the local CA certificate first so the browser accepts the HTTPS connection. On iPhone, open the HTTPS page in Safari, tap **Share → Add to Home Screen**, then launch Bafwethu from its home-screen icon. On Android, open it in Chrome and choose **Install app** or **Add to Home screen** from the browser menu. The app uses the phone's full screen, safe-area insets, touch-sized controls, and a bottom navigation bar. Records are stored separately on each device, so use JSON backup/restore to transfer them.

Open the local Vite URL in a current browser with IndexedDB and WebAssembly support. For a production build, run `npm run build` and deploy the `dist/` directory over HTTPS. The configured cross-origin isolation headers are used only when migrating a previous OPFS SQLite database. The app requests persistent browser storage where supported; that request is not a substitute for backups.

## Included workflows

- Member registration, local search, editing, and deactivation.
- Contribution recording with integer-cent amounts, explicit duplicate/additional-payment confirmation, EFT/bank reference validation, and stable receipt identifiers.
- Payment history filters, CSV export, printable receipts, and auditable reversals.
- Monthly dashboard and annual contribution, member, and transaction reports.
- Society settings and versioned JSON export/validated restore. Restore requires confirmation and downloads a safety copy first.
- Installable PWA shell and online/offline status. Financial records remain on the device when offline.
- Correlated, on-device diagnostic logs for app/database startup and failures. Export them from **Settings → Backup & recovery** to help troubleshoot browser issues; logs omit member and payment details.
- A readable **Settings → Change history** feed for successful member, payment, reversal, and settings changes. The audit trail is included in JSON backups and remains available offline.

This single-user version does not include remote authentication, multi-device synchronization, spreadsheet/PDF report generation, or Google Drive OAuth. Drive upload requires an OAuth client ID and deployment-specific redirect/origin configuration; no client secret should be embedded in a browser app. Until that integration is configured, use JSON backups and keep them outside the device.

## Data and recovery

There is no passphrase or encryption. Anyone with access to this browser profile can view its local society records. Browser storage can still be cleared or the device can be lost. Download JSON backups regularly from **Settings → Backup & recovery** and keep them somewhere separate. Backups contain readable records; store them securely. A restore replaces current local records only after validation and confirmation, and downloads a safety copy first.

The app no longer reads or migrates the previous encrypted vault. Records in that vault are not accessible through this version; the old encrypted browser data is left untouched. Older installations may also have a previous OPFS SQLite database; it is copied to the new local store without deleting the old file.

Amounts are stored as integer cents. Reversed payments remain in the database and audit history, but are excluded from collected totals. The default contribution value is applied to new payments only.
